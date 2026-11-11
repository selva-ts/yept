// Client certificates: host patterns, reading PFX and PEM files with clear errors, and sending to a server that
// requires a certificate, directly and through a proxy tunnel.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestProxy } from '../../../../../fixtures/server/proxy.mjs';
import { emptyAuth, type ClientCertificate, type RequestDoc } from '../../shared/model';
import { emptyEnvLayer } from '../env/variables';
import { run, type RunOptions } from '../runner/runner';
import { ProxyRouter } from './proxy';
import { ClientCertificateError, certificateFor, hostMatches, loadClientCertificates } from './client-certs';

describe('host patterns', () => {
  it.each([
    ['api.example.test', 'api.example.test', 443, true],
    ['api.example.test', 'API.example.test', 443, true],
    ['api.example.test', 'other.api.example.test', 443, false],
    ['*.example.test', 'api.example.test', 443, true],
    ['*.example.test', 'example.test', 443, false],
    ['api.example.test:8443', 'api.example.test', 443, false],
    ['api.example.test:8443', 'api.example.test', 8443, true],
    ['127.0.0.1', '127.0.0.1', 50000, true],
    ['', 'api.example.test', 443, false]
  ])('%s covers %s:%d: %s', (pattern, host, port, expected) => {
    expect(hostMatches(pattern, host, port)).toBe(expected);
  });

  it('the first matching certificate wins', () => {
    const list = [{ host: 'api.example.test' }, { host: '*.example.test' }];
    expect(certificateFor(list, 'api.example.test', 443)).toBe(list[0]);
    expect(certificateFor(list, 'other.example.test', 443)).toBe(list[1]);
    expect(certificateFor(list, 'example.test', 443)).toBeUndefined();
  });
});

// Certificates come from openssl (ships with Git for Windows); skipped when it isn't on PATH.
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('with certificate files', () => {
  let dir = '';
  const f = (n: string): string => join(dir, n);
  const PASS = 'sample-cert-pass';
  let server: https.Server;
  let port = 0;
  let ca = '';
  // Antivirus TLS inspection can re-sign even loopback connections; then no client certificate reaches the server.
  let intercepted = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yept-mtls-'));
    const ssl = (...args: string[]): void => void execFileSync('openssl', args, { stdio: 'ignore' });
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '1', '-subj', '/CN=Yept mTLS Test CA');
    const sign = (name: string, subject: string, ext: string): void => {
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f(`${name}.key`), '-out', f(`${name}.csr`), '-subj', subject);
      writeFileSync(f(`${name}.cnf`), `${ext}\n`);
      ssl('x509', '-req', '-in', f(`${name}.csr`), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f(`${name}.pem`), '-days', '1', '-extfile', f(`${name}.cnf`));
    };
    sign('server', '/CN=api.example.test', 'subjectAltName=DNS:api.example.test,IP:127.0.0.1');
    sign('client', '/CN=sample-client/O=Yept Tests', 'extendedKeyUsage=clientAuth');
    sign('other', '/CN=other-client', 'extendedKeyUsage=clientAuth');
    // AES and SHA-256, which OpenSSL 3 reads without its legacy provider (LibreSSL's defaults are older).
    ssl('pkcs12', '-export', '-in', f('client.pem'), '-inkey', f('client.key'), '-out', f('client.pfx'), '-passout', `pass:${PASS}`, '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256');
    ssl('pkey', '-in', f('client.key'), '-aes256', '-passout', `pass:${PASS}`, '-out', f('client-encrypted.key'));
    ca = readFileSync(f('ca.pem'), 'utf8');

    server = https.createServer({ key: readFileSync(f('server.key')), cert: readFileSync(f('server.pem')), ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const peer = (req.socket as tls.TLSSocket).getPeerCertificate();
      res.end(`client ${peer?.subject?.CN ?? 'none'} host ${req.headers.host}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    intercepted = await new Promise<string>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, cert: readFileSync(f('client.pem')), key: readFileSync(f('client.key')) }, () => {
        resolve(String(s.getPeerCertificate().issuer?.CN ?? ''));
        s.end();
      });
      s.on('error', () => resolve(''));
    }).then((issuer) => (issuer && issuer !== 'Yept mTLS Test CA' ? issuer : ''));
  });
  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cert = (over: Partial<ClientCertificate>): ClientCertificate => ({ host: '127.0.0.1', pfxFile: '', certFile: '', keyFile: '', ...over });

  describe('reading', () => {
    it('reads a PEM pair and a PFX with its passphrase', async () => {
      const [pem] = await loadClientCertificates([cert({ certFile: f('client.pem'), keyFile: f('client.key') })], {});
      expect(pem.cert?.length).toBeGreaterThan(0);
      expect(pem.key?.length).toBeGreaterThan(0);
      const [pfx] = await loadClientCertificates([cert({ pfxFile: f('client.pfx') })], { '127.0.0.1': PASS });
      expect(pfx).toMatchObject({ host: '127.0.0.1', passphrase: PASS });
      const [encrypted] = await loadClientCertificates([cert({ certFile: f('client.pem'), keyFile: f('client-encrypted.key') })], { '127.0.0.1': PASS });
      expect(encrypted.passphrase).toBe(PASS);
    });

    it('explains a wrong or missing passphrase, a key that does not match and a missing file', async () => {
      const load = (c: ClientCertificate, passphrase?: string): Promise<unknown> => loadClientCertificates([c], passphrase ? { [c.host]: passphrase } : {});
      await expect(load(cert({ pfxFile: f('client.pfx') }), 'wrong')).rejects.toThrow("Can't use the client certificate for 127.0.0.1: the passphrase is wrong");
      await expect(load(cert({ pfxFile: f('client.pfx') }))).rejects.toThrow('the client certificate for 127.0.0.1: it needs a passphrase');
      await expect(load(cert({ certFile: f('client.pem'), keyFile: f('client-encrypted.key') }), 'wrong')).rejects.toThrow('the passphrase is wrong');
      await expect(load(cert({ certFile: f('client.pem'), keyFile: f('other.key') }))).rejects.toThrow("the key doesn't belong to the certificate");
      await expect(load(cert({ pfxFile: f('client.pem') }))).rejects.toThrow("it isn't a PFX (PKCS#12) file");
      await expect(load(cert({ pfxFile: f('missing.pfx') }))).rejects.toThrow(/Can't read the client certificate for 127\.0\.0\.1 \(.*missing\.pfx\): the file is missing/);
      await expect(load(cert({ certFile: f('client.pem') }))).rejects.toThrow('The client certificate for 127.0.0.1 needs its key file');
      await expect(load(cert({}))).rejects.toBeInstanceOf(ClientCertificateError);
    });
  });

  describe('sending', () => {
    const doc = (url: string): RequestDoc => ({
      name: 't', method: 'GET', url, params: [], headers: [],
      body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
      auth: { ...emptyAuth(), mode: 'none' }, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
      settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true }
    });
    const opts = async (certs: ClientCertificate[], passphrases: Record<string, string> = {}, over: Partial<RunOptions> = {}): Promise<RunOptions> => ({
      runId: 'r', defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024,
      layers: { collection: [], environment: emptyEnvLayer(), folders: [], request: [], runtime: {} },
      tls: { skipVerify: false, ca: [ca], clientCertificates: await loadClientCertificates(certs, passphrases) },
      ...over
    });
    const skipped = (): boolean => {
      if (intercepted) console.warn(`Skipped: TLS on this machine is intercepted and re-signed by "${intercepted}"`);
      return !!intercepted;
    };

    it('without a certificate the server refuses, in plain words', async () => {
      if (skipped()) return;
      const r = await run(doc(`https://127.0.0.1:${port}/`), await opts([]));
      expect(r.result.outcome).toBe('network');
      expect(r.result.error?.message).toMatch(/^TLS error: the server requires a client certificate\. Add one for this host in the environment's TLS settings$|^Connection reset$/);
    });

    it('presents a PEM certificate and shows its subject in Network', async () => {
      if (skipped()) return;
      const r = await run(doc(`https://127.0.0.1:${port}/`), await opts([cert({ certFile: f('client.pem'), keyFile: f('client-encrypted.key') })], { '127.0.0.1': PASS }));
      expect(r.result.error).toBeUndefined();
      expect(r.result.body.text).toBe(`client sample-client host 127.0.0.1:${port}`);
      expect(r.result.hops![0].connection.tls?.clientCertificate).toBe('CN=sample-client, O=Yept Tests');
      expect(JSON.stringify(r.result)).not.toContain(PASS);
    });

    it('offers nothing to hosts the pattern does not cover', async () => {
      if (skipped()) return;
      const r = await run(doc(`https://127.0.0.1:${port}/`), await opts([cert({ host: 'api.example.test', pfxFile: f('client.pfx') })], { 'api.example.test': PASS }));
      expect(r.result.outcome).toBe('network');
      expect(r.result.hops?.[0]?.connection.tls?.clientCertificate).toBeUndefined();
    });

    it('a certificate the server does not trust is refused', async () => {
      if (skipped()) return;
      // Self-signed, so the server's CA doesn't cover it.
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('stray.key'), '-out', f('stray.pem'), '-days', '1', '-subj', '/CN=stray-client'], { stdio: 'ignore' });
      const r = await run(doc(`https://127.0.0.1:${port}/`), await opts([cert({ certFile: f('stray.pem'), keyFile: f('stray.key') })]));
      expect(r.result.outcome).toBe('network');
      expect(r.result.error?.message).toMatch(/^TLS error: the server didn't accept the client certificate \(ERR_SSL_\w+\)$|^Connection reset$/);
    });

    it('presents a PFX through a proxy tunnel', async () => {
      if (skipped()) return;
      const p = createTestProxy({ target: { host: '127.0.0.1', port } });
      await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', () => r()));
      try {
        const router = new ProxyRouter({ mode: 'manual', url: `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`, bypass: '', username: '', password: '' });
        const r = await run(doc('https://api.example.test/'), await opts([cert({ host: '*.example.test', pfxFile: f('client.pfx') })], { '*.example.test': PASS }, { proxy: router }));
        expect(r.result.error).toBeUndefined();
        expect(r.result.body.text).toBe('client sample-client host api.example.test');
        expect(r.result.hops![0].connection).toMatchObject({ proxySource: 'manual', tls: { clientCertificate: 'CN=sample-client, O=Yept Tests' } });
        expect(p.seen).toEqual([{ kind: 'connect', authority: 'api.example.test:443', auth: false }]);
      } finally {
        p.server.closeAllConnections();
        p.server.close();
      }
    });
  });
});
