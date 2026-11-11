// Proxy routing: which proxy each URL uses, and requests through a local test proxy (plain HTTP, CONNECT tunnels,
// sign-in, redirects, OAuth2 token requests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureServer, CLIENT_ID, CLIENT_SECRET } from '../../../../../fixtures/server/server.mjs';
import { createTestProxy, type ProxySeen } from '../../../../../fixtures/server/proxy.mjs';
import { emptyAuth, type AuthConfig, type RequestDoc } from '../../shared/model';
import { emptyEnvLayer } from '../env/variables';
import { run, type RunOptions } from '../runner/runner';
import { ProxyError, ProxyRouter, bypasses, isLoopback, parseProxyUrl, parseSystemProxy, type ProxyConfig } from './proxy';

const config = (over: Partial<ProxyConfig> = {}): ProxyConfig => ({ mode: 'system', url: '', bypass: '', username: '', password: '', ...over });
const u = (s: string): URL => new URL(s);

describe('bypass lists', () => {
  it.each([
    ['example.test', 'example.test', true],
    ['example.test', 'api.example.test', true],
    ['.example.test', 'example.test', true],
    ['*.example.test', 'api.example.test', true],
    ['*.example.test', 'example.test', false],
    ['example.test', 'badexample.test', false],
    ['*', 'anything.test', true],
    ['10.0.0.0/8', '10.1.2.3', true],
    ['10.0.0.0/8', '11.1.2.3', false],
    ['192.168.*', '192.168.4.5', true],
    ['<local>', 'intranet', true],
    ['<local>', 'intranet.example.test', false],
    ['api.example.test:8443', 'api.example.test', false],
    ['  a.test ;\n b.test', 'b.test', true]
  ])('%j matches %s: %s', (list, host, expected) => {
    expect(bypasses(list, host, 443)).toBe(expected);
  });

  it('matches a port when the entry names one', () => {
    expect(bypasses('api.example.test:8443', 'api.example.test', 8443)).toBe(true);
  });

  it('never sends localhost or loopback addresses through a proxy', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]']) expect(isLoopback(h)).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
  });
});

describe('proxy addresses', () => {
  it('reads host, port and sign-in', () => {
    expect(parseProxyUrl('http://user%40corp:p%3Ass@proxy.example.test:3128', 'manual')).toEqual({
      protocol: 'http:', host: 'proxy.example.test', port: 3128, username: 'user@corp', password: 'p:ss', source: 'manual'
    });
    expect(parseProxyUrl('proxy.example.test:8080', 'manual')).toMatchObject({ protocol: 'http:', port: 8080 });
    expect(parseProxyUrl('https://proxy.example.test', 'manual')).toMatchObject({ protocol: 'https:', port: 443 });
  });

  it('refuses SOCKS, other schemes and empty addresses in plain words', () => {
    expect(() => parseProxyUrl('socks5://proxy.example.test:1080', 'manual')).toThrow(/SOCKS proxy, which Yept doesn't support/);
    expect(() => parseProxyUrl('ftp://proxy.example.test', 'manual')).toThrow(/must start with http:\/\/ or https:\/\//);
    expect(() => parseProxyUrl(' ', 'manual')).toThrow('The proxy address is empty');
  });

  it('reads the system answer, skipping SOCKS entries', () => {
    expect(parseSystemProxy('DIRECT')).toBeNull();
    expect(parseSystemProxy('PROXY proxy.example.test:8080; DIRECT')).toMatchObject({ host: 'proxy.example.test', port: 8080, source: 'system' });
    expect(parseSystemProxy('SOCKS5 s.example.test:1080; HTTPS secure.example.test:443')).toMatchObject({ protocol: 'https:', host: 'secure.example.test' });
    expect(() => parseSystemProxy('SOCKS5 s.example.test:1080')).toThrow(/only offer a proxy Yept doesn't support \(SOCKS5\)/);
  });
});

describe('routing', () => {
  it('off and loopback are always direct', () => {
    expect(new ProxyRouter(config({ mode: 'off' }), { env: { HTTPS_PROXY: 'http://p.example.test:1' } }).peek(u('https://api.example.test'))).toBeNull();
    expect(new ProxyRouter(config({ mode: 'manual', url: 'http://p.example.test:1' })).peek(u('http://localhost:4010/x'))).toBeNull();
  });

  it('manual uses its proxy outside the bypass list, with the saved sign-in', () => {
    const r = new ProxyRouter(config({ mode: 'manual', url: 'p.example.test:3128', bypass: '*.internal.example.test', username: 'alex', password: 'synthetic' }));
    expect(r.peek(u('https://api.example.test/x'))).toMatchObject({ host: 'p.example.test', port: 3128, username: 'alex', password: 'synthetic', source: 'manual' });
    expect(r.peek(u('https://svc.internal.example.test/x'))).toBeNull();
  });

  it('a bad manual address stops with an explanation', () => {
    expect(() => new ProxyRouter(config({ mode: 'manual', url: 'socks5://p.example.test' })).peek(u('https://api.example.test'))).toThrow(ProxyError);
  });

  it('system mode prefers the environment variable for the scheme, honouring NO_PROXY', async () => {
    const env = { https_proxy: 'http://env.example.test:8080', NO_PROXY: 'skip.example.test' };
    const asked: string[] = [];
    const r = new ProxyRouter(config(), { env, system: async (url) => (asked.push(url), 'PROXY os.example.test:3128') });
    expect(await r.resolve(u('https://api.example.test'))).toMatchObject({ host: 'env.example.test', source: 'environment' });
    expect(await r.resolve(u('https://skip.example.test'))).toBeNull();
    // No HTTP_PROXY: the operating system decides plain HTTP.
    expect(await r.resolve(u('http://api.example.test'))).toMatchObject({ host: 'os.example.test', source: 'system' });
    expect(asked).toEqual(['http://api.example.test/']);
  });

  it('caches the system answer per origin, and needs it before peek can say', async () => {
    let calls = 0;
    const r = new ProxyRouter(config(), { system: async () => (calls++, 'PROXY os.example.test:3128') });
    expect(r.peek(u('http://api.example.test/a'))).toBeUndefined();
    await r.resolve(u('http://api.example.test/a'));
    expect(r.peek(u('http://api.example.test/b'))).toMatchObject({ host: 'os.example.test' });
    await r.resolve(u('http://api.example.test/c'));
    expect(calls).toBe(1);
  });

  it('the same settings give the same key', () => {
    expect(new ProxyRouter(config()).key).toBe(new ProxyRouter(config()).key);
    expect(new ProxyRouter(config()).key).not.toBe(new ProxyRouter(config({ password: 'other' })).key);
  });
});

describe('requests through a proxy', () => {
  let fixture: Server;
  let fixturePort = 0;
  const listen = async (s: Server): Promise<number> => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return (s.address() as AddressInfo).port;
  };
  const proxies: Server[] = [];
  const startProxy = async (o: { username?: string; password?: string } = {}): Promise<{ port: number; seen: ProxySeen[] }> => {
    const p = createTestProxy({ target: { host: '127.0.0.1', port: fixturePort }, ...o });
    proxies.push(p.server);
    return { port: await listen(p.server), seen: p.seen };
  };

  beforeAll(async () => {
    fixture = createFixtureServer();
    fixturePort = await listen(fixture);
  });
  afterAll(() => {
    for (const s of [fixture, ...proxies]) {
      s.closeAllConnections();
      s.close();
    }
  });

  const noAuth: AuthConfig = { ...emptyAuth(), mode: 'none' };
  const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
    name: 't', method: 'GET', url: 'http://api.example.test/echo', params: [], headers: [],
    body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
    auth: noAuth, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
    settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
    ...over
  });
  const opts = (proxy: ProxyRouter, over: Partial<RunOptions> = {}): RunOptions => ({
    runId: 'r', proxy, defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024,
    layers: { collection: [], environment: emptyEnvLayer(), folders: [], request: [], runtime: {} }, ...over
  });
  const manual = (port: number, over: Partial<ProxyConfig> = {}): ProxyRouter => new ProxyRouter(config({ mode: 'manual', url: `http://127.0.0.1:${port}`, ...over }));

  it('sends plain HTTP to the proxy with the full URL and shows the proxy in Network', async () => {
    const { port, seen } = await startProxy();
    const r = await run(doc(), opts(manual(port)));
    expect(r.result.status).toBe(200);
    expect(JSON.parse(r.result.body.text).headers['x-via-test-proxy']).toBe('1');
    expect(seen).toEqual([{ kind: 'http', method: 'GET', url: 'http://api.example.test/echo', auth: false }]);
    const hop = r.result.hops![0];
    expect(hop.connection).toMatchObject({ proxy: `127.0.0.1:${port}`, proxySource: 'manual' });
    expect(r.result.timeline.find((t) => t.label === 'Request sent')?.detail).toBe(`GET http://api.example.test/echo via proxy 127.0.0.1:${port}`);
  });

  it('signs in to the proxy and keeps the credentials out of the result', async () => {
    const { port, seen } = await startProxy({ username: 'alex', password: 'synthetic-proxy-pass' });
    const denied = await run(doc(), opts(manual(port)));
    expect(denied.result.status).toBe(407);
    const r = await run(doc(), opts(manual(port, { username: 'alex', password: 'synthetic-proxy-pass' })));
    expect(r.result.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ kind: 'http', auth: true });
    // The proxy strips it, so the API never sees it; Network shows the header masked.
    expect(JSON.parse(r.result.body.text).headers['proxy-authorization']).toBeUndefined();
    expect(r.result.hops![0].requestHeaders).toContainEqual(['Proxy-Authorization', '••••••']);
    expect(JSON.stringify({ ...r.result, body: null })).not.toContain(Buffer.from('alex:synthetic-proxy-pass').toString('base64'));
    expect(JSON.stringify(r.sent)).not.toContain('Proxy-Authorization');
  });

  it('follows redirects through the proxy', async () => {
    const { port, seen } = await startProxy();
    const r = await run(doc({ url: 'http://api.example.test/redirect/2' }), opts(manual(port)));
    expect(r.result.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['http://api.example.test/redirect/2', 'http://api.example.test/redirect/1', 'http://api.example.test/echo']);
    expect(r.result.hops!.every((h) => h.connection.proxy === `127.0.0.1:${port}`)).toBe(true);
  });

  it('tunnels plain HTTP when only the system can say, as for a redirect to a new host', async () => {
    // first.example.test redirects to second.example.test; the test proxy sends both hosts here.
    const hosts = http.createServer((req, res) => {
      if (req.headers.host === 'first.example.test') {
        res.writeHead(302, { Location: 'http://second.example.test/done' });
        return res.end();
      }
      res.end(`${req.headers.host} ${req.url}`);
    });
    proxies.push(hosts);
    const p = createTestProxy({ target: { host: '127.0.0.1', port: await listen(hosts) } });
    proxies.push(p.server);
    const port = await listen(p.server);
    const router = new ProxyRouter(config(), { system: async () => `PROXY 127.0.0.1:${port}` });
    const r = await run(doc({ url: 'http://first.example.test/start' }), opts(router));
    expect(r.result.body.text).toBe('second.example.test /done');
    expect(p.seen).toEqual([
      { kind: 'http', method: 'GET', url: 'http://first.example.test/start', auth: false },
      { kind: 'connect', authority: 'second.example.test:80', auth: false }
    ]);
    expect(r.result.hops!.map((h) => h.connection.proxySource)).toEqual(['system', 'system']);
  });

  it('gets an OAuth2 token through the proxy too', async () => {
    const { port, seen } = await startProxy();
    const oauth2 = { ...emptyAuth().oauth2, grantType: 'client_credentials', accessTokenUrl: 'http://api.example.test/auth/token', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, autoFetchToken: true };
    const r = await run(doc({ url: 'http://api.example.test/bookings', auth: { ...noAuth, mode: 'oauth2', oauth2 } }), opts(manual(port)));
    expect(r.result.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['http://api.example.test/auth/token', 'http://api.example.test/bookings']);
  });

  it('stops before sending when the proxy setting is wrong', async () => {
    const r = await run(doc(), opts(new ProxyRouter(config({ mode: 'manual', url: 'socks5://127.0.0.1:1' }))));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/SOCKS proxy/);
  });

  it('names the proxy when it cannot be reached', async () => {
    const closed = createTestProxy();
    const port = await listen(closed.server);
    closed.server.close();
    const r = await run(doc({ url: 'https://api.example.test/echo' }), opts(manual(port)));
    expect(r.result.outcome).toBe('network');
    expect(r.result.error?.message).toBe(`Couldn't reach the proxy 127.0.0.1:${port}: connection refused`);
  });

  // HTTPS through a tunnel needs a TLS server: openssl (ships with Git for Windows) makes its certificate.
  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(!hasOpenssl)('HTTPS through a CONNECT tunnel', () => {
    let tlsServer: https.Server;
    let tlsPort = 0;
    let certDir = '';
    let tunnel: { port: number; seen: ProxySeen[] };
    let ca = '';
    // Antivirus TLS inspection can re-sign even loopback certificates; then only skip-verify gets through.
    let intercepted = '';
    beforeAll(async () => {
      // A throwaway CA and a certificate for api.example.test signed by it.
      certDir = mkdtempSync(join(tmpdir(), 'yept-proxy-tls-'));
      const f = (n: string): string => join(certDir, n);
      const ssl = (...args: string[]): void => void execFileSync('openssl', args, { stdio: 'ignore' });
      ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '1', '-subj', '/CN=Yept Proxy Test CA');
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('key.pem'), '-out', f('leaf.csr'), '-subj', '/CN=api.example.test');
      writeFileSync(f('ext.cnf'), 'subjectAltName=DNS:api.example.test\n');
      ssl('x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('cert.pem'), '-days', '1', '-extfile', f('ext.cnf'));
      ca = readFileSync(f('ca.pem'), 'utf8');
      tlsServer = https.createServer({ key: readFileSync(f('key.pem')), cert: readFileSync(f('cert.pem')) }, (req, res) => res.end(`secure ${req.headers.host}`));
      tlsPort = await listen(tlsServer);
      intercepted = await new Promise<string>((resolve) => {
        const s = tls.connect({ host: '127.0.0.1', port: tlsPort, servername: 'api.example.test', rejectUnauthorized: false }, () => {
          resolve(String(s.getPeerCertificate().issuer?.CN ?? ''));
          s.end();
        });
        s.on('error', () => resolve(''));
      }).then((issuer) => (issuer !== 'Yept Proxy Test CA' ? issuer : ''));
      const p = createTestProxy({ target: { host: '127.0.0.1', port: tlsPort }, username: 'alex', password: 'synthetic-proxy-pass' });
      proxies.push(p.server);
      tunnel = { port: await listen(p.server), seen: p.seen };
    });
    afterAll(() => {
      tlsServer?.closeAllConnections();
      tlsServer?.close();
      rmSync(certDir, { recursive: true, force: true });
    });

    it('tunnels with sign-in and checks the API certificate, not the proxy', async () => {
      const router = manual(tunnel.port, { username: 'alex', password: 'synthetic-proxy-pass' });
      if (intercepted) console.warn(`Certificate check skipped: TLS on this machine is intercepted and re-signed by "${intercepted}"`);
      const r = await run(doc({ url: 'https://api.example.test/hello' }), opts(router, { tls: { skipVerify: !!intercepted, ca: [ca] } }));
      expect(r.result.error).toBeUndefined();
      expect(r.result.body.text).toBe('secure api.example.test');
      expect(tunnel.seen.at(-1)).toEqual({ kind: 'connect', authority: 'api.example.test:443', auth: true });
      const hop = r.result.hops![0];
      expect(hop.connection).toMatchObject({ proxy: `127.0.0.1:${tunnel.port}`, proxySource: 'manual', tls: { certificate: { subject: 'CN=api.example.test' } } });
      if (!intercepted) expect(hop.connection.tls?.certificate?.issuer).toBe('CN=Yept Proxy Test CA');
      expect(hop.timings.connect).toBeGreaterThanOrEqual(0);
      expect(hop.timings.reused).toBe(false);
      expect(hop.connection.remoteAddress).toBe('127.0.0.1');
      expect(hop.connection.remotePort).toBe(tunnel.port);
      // The proxy's sign-in is on the CONNECT only, never in the request the API sees.
      expect(hop.requestHeaders.some(([k]) => k.toLowerCase() === 'proxy-authorization')).toBe(false);
    });

    it('explains a refused sign-in', async () => {
      const r = await run(doc({ url: 'https://api.example.test/hello' }), opts(manual(tunnel.port, { username: 'alex', password: 'wrong' }), { tls: { skipVerify: true } }));
      expect(r.result.outcome).toBe('network');
      expect(r.result.error?.message).toBe(`The proxy 127.0.0.1:${tunnel.port} didn't accept the username and password (407 Proxy Authentication Required)`);
      const none = await run(doc({ url: 'https://api.example.test/hello' }), opts(manual(tunnel.port), { tls: { skipVerify: true } }));
      expect(none.result.error?.message).toMatch(/needs a username and password \(407 Proxy Authentication Required\)\. Add them in Settings$/);
    });
  });
});
