import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { caFileAnchors } from './ca';

const root = resolve(__dirname, '../../../../..');
const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

describe.skipIf(!hasOpenssl)('trusted TLS certificates in Node and Electron', () => {
  let dir: string;
  let tempRoot: string;
  beforeAll(() => {
    tempRoot = realpathSync(tmpdir());
    dir = mkdtempSync(join(tempRoot, 'yept-ca-test-'));
    const ssl = (...args: string[]): void => void execFileSync('openssl', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
    const certificate = (name: string, ca: boolean, issuer?: string, expired = false, usage = 'serverAuth'): void => {
      // Distinct subjects: without key identifiers (LibreSSL), a leaf named like its issuer looks self-signed.
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=Synthetic ${name}`);
      writeFileSync(join(dir, 'extensions.cnf'), [
        `basicConstraints=critical,CA:${ca ? 'TRUE' : 'FALSE'}`,
        `keyUsage=critical,${ca ? 'keyCertSign,cRLSign' : 'digitalSignature,keyEncipherment'}`,
        `extendedKeyUsage=critical,${usage}`,
        'subjectAltName=DNS:api.example.test', ''
      ].join('\n'));
      if (!expired) {
        ssl('x509', '-req', '-in', `${name}.csr`, ...(issuer ? ['-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial'] : ['-signkey', `${name}.key`]), '-out', `${name}.pem`, '-days', '1', '-extfile', 'extensions.cnf');
        return;
      }
      // x509 rejects negative -days in OpenSSL 3; `ca` sets past dates in OpenSSL and LibreSSL alike.
      writeFileSync(join(dir, 'ca.cnf'), [
        '[ca]', 'default_ca = expired',
        '[expired]', 'database = index.txt', 'new_certs_dir = .', 'serial = serial.txt', 'default_md = sha256', 'policy = policy',
        '[policy]', 'commonName = supplied', ''
      ].join('\n'));
      writeFileSync(join(dir, 'index.txt'), '');
      writeFileSync(join(dir, 'serial.txt'), '01\n');
      ssl('ca', '-batch', '-notext', '-config', 'ca.cnf', '-selfsign', '-keyfile', `${name}.key`, '-in', `${name}.csr`, '-out', `${name}.pem`,
        '-startdate', '20200101000000Z', '-enddate', '20200102000000Z', '-extfile', 'extensions.cnf');
    };
    certificate('server', false);
    certificate('other', false);
    certificate('expired', false, undefined, true);
    certificate('client', false, undefined, false, 'clientAuth');
    certificate('any-purpose', false, undefined, false, 'anyExtendedKeyUsage');
    certificate('root', true);
    certificate('signing', true);
    certificate('client-leaf', false, 'root', false, 'clientAuth');
    certificate('intermediate', true, 'root');
    certificate('leaf', false, 'intermediate');
    certificate('descendant', false, 'server');
    writeFileSync(join(dir, 'probe.mjs'), `
      import tls from 'node:tls';
      import { Duplex } from 'node:stream';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const { caOptions } = await import(pathToFileURL(process.argv[2]).href);
      const name = process.argv[3];
      const pem = file => readFileSync(join(${JSON.stringify(dir)}, file), 'utf8');
      const cases = {
        trusted: ['server', ['server']],
        untrusted: ['server', ['other']],
        hostname: ['server', ['server'], 'other.example.test'],
        expired: ['expired', ['expired']],
        purpose: ['client', ['client']],
        'any-purpose': ['any-purpose', ['any-purpose']],
        signing: ['signing', ['signing']],
        'chain-purpose': ['client-leaf', ['root']],
        chain: ['leaf', ['root']],
        'missing-chain': ['leaf', ['root']],
        intermediate: ['leaf', ['intermediate']],
        bundle: ['leaf', ['other', 'intermediate', 'root']],
        descendant: ['descendant', ['server']]
      };
      const [leaf, anchors, hostname = 'api.example.test'] = cases[name];
      const cert = pem(leaf + '.pem') + (leaf === 'leaf' && name !== 'missing-chain' ? pem('intermediate.pem') : '');
      let incoming, outgoing;
      incoming = new Duplex({ read() {}, write(chunk, encoding, callback) { outgoing.push(Buffer.from(chunk)); callback(); } });
      outgoing = new Duplex({ read() {}, write(chunk, encoding, callback) { incoming.push(Buffer.from(chunk)); callback(); } });
      const server = new tls.TLSSocket(incoming, { isServer: true, secureContext: tls.createSecureContext({ cert, key: pem(leaf + '.key') }) });
      server.on('error', () => {});
      const result = await new Promise((resolve, reject) => {
        const client = tls.connect({ socket: outgoing, servername: hostname, ...caOptions([anchors.map(anchor => pem(anchor + '.pem')).join('\\n')]) });
        const timer = setTimeout(() => { client.destroy(); server.destroy(); reject(new Error('TLS handshake timed out')); }, 5000);
        const finish = value => { clearTimeout(timer); client.destroy(); server.destroy(); resolve(value); };
        client.on('secureConnect', () => finish({ authorized: client.authorized }));
        client.on('error', error => finish({ authorized: false, code: error.code }));
      });
      console.log(JSON.stringify(result));
    `);
  });
  afterAll(() => {
    if (!dir) return;
    const path = relative(tempRoot, realpathSync(dir));
    if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('Unexpected certificate fixture path');
    rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });

  describe.each(['Node', 'Electron'])('%s', runtime => {
    it.each([
      ['trusted', true, undefined],
      ['untrusted', false, /SELF_SIGNED|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE)/],
      ['hostname', false, /ERR_TLS_CERT_ALTNAME_INVALID/],
      ['expired', false, /CERT_HAS_EXPIRED/],
      ['purpose', false, /INVALID_PURPOSE|SELF_SIGNED|UNABLE_TO_GET_ISSUER_CERT/],
      ['any-purpose', false, /INVALID_PURPOSE|SELF_SIGNED|UNABLE_TO_GET_ISSUER_CERT/],
      ['signing', false, /INVALID_PURPOSE|SSL/],
      ['chain-purpose', false, /INVALID_PURPOSE/],
      ['chain', true, undefined],
      ['missing-chain', false, /UNABLE_TO_GET_ISSUER_CERT/],
      ['intermediate', false, /UNABLE_TO_GET_ISSUER_CERT/],
      ['bundle', true, undefined],
      ['descendant', false, /INVALID_CA|KEYUSAGE_NO_CERTSIGN|UNABLE_TO_GET_ISSUER_CERT|UNSPECIFIED/]
    ] as const)('%s', (name, authorized, error) => {
      const binary = runtime === 'Node' ? process.execPath : join(root, 'node_modules/electron/dist', readFileSync(join(root, 'node_modules/electron/path.txt'), 'utf8').trim());
      // In-memory TLS avoids antivirus interception of loopback HTTPS fixtures.
      const output = execFileSync(binary, ['--experimental-strip-types', join(dir, 'probe.mjs'), join(__dirname, 'ca.ts'), name], {
        cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(runtime === 'Electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
      });
      const result = JSON.parse(output);
      expect(result.authorized).toBe(authorized);
      if (error) expect(result.code).toMatch(error);
    });
  });

  describe('CA file for an environment', () => {
    const pem = (...names: string[]): string => names.map(name => readFileSync(join(dir, `${name}.pem`), 'utf8')).join('\n');

    it('keeps the self-signed server roots of a bundle', () => {
      expect(caFileAnchors(pem('other', 'intermediate', 'root'))).toHaveLength(2);
    });

    it.each([
      ['an intermediate only', ['intermediate']],
      ['a root for client authentication only', ['client']]
    ])('rejects %s', (_, names) => {
      expect(() => caFileAnchors(pem(...names))).toThrow(/no self-signed root certificate/);
    });

    it('rejects files without PEM certificates', () => {
      expect(() => caFileAnchors('not a certificate')).toThrow(/no PEM certificates/);
    });

    it('rejects unreadable certificates', () => {
      expect(() => caFileAnchors('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow(/can't be read/);
    });
  });
});
