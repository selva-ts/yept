// Request pipeline: environments, inherited auth, token extraction, scripts in the sandbox, masking, TLS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureServer, CLIENT_ID, CLIENT_SECRET } from '../../../../../fixtures/server/server.mjs';
import { DEFAULT_OAUTH2, type AuthConfig, type RequestDoc, type SettingsDoc } from '../../shared/model';
import { SandboxHost } from '../sandbox/host';
import { emptyEnvLayer, type VarLayers } from '../env/variables';
import { run, type RunOptions } from './runner';

let server: Server;
let base = '';
let sandbox: SandboxHost;

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sandbox = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 1500 });
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await sandbox.close();
});

const noAuth: AuthConfig = { mode: 'none', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', placement: 'header' }, oauth2: { ...DEFAULT_OAUTH2 } };
const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't', method: 'GET', url: '{{baseUrl}}/echo', params: [], headers: [],
  body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: noAuth, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const settings = (over: Partial<SettingsDoc> = {}): SettingsDoc => ({ name: 'c', headers: [], auth: noAuth, vars: [], script: { req: '', res: '' }, tests: '', docs: '', ...over });

const login = doc({
  method: 'POST',
  url: '{{baseUrl}}/auth/token',
  auth: { ...noAuth, mode: 'basic', basic: { username: '{{clientId}}', password: '{{clientSecret}}' } },
  body: { mode: 'formUrlEncoded', json: '', text: '', xml: '', formUrlEncoded: [{ name: 'grant_type', value: 'client_credentials', enabled: true }], multipartForm: [] },
  vars: { req: [], res: [{ name: 'accessToken', value: 'res.body.access_token', enabled: true }] }
});
const bookings = doc({ url: '{{baseUrl}}/bookings', auth: { ...noAuth, mode: 'inherit' } });
const collectionWithBearer = settings({ auth: { ...noAuth, mode: 'bearer', bearer: { token: '{{accessToken}}' } }, headers: [{ name: 'X-Client', value: 'yept', enabled: true }] });

function env(secrets: Record<string, string> = { clientSecret: CLIENT_SECRET }): VarLayers {
  return {
    collection: [],
    environment: { ...emptyEnvLayer(), file: { baseUrl: base, clientId: CLIENT_ID }, secrets },
    folders: [],
    request: [],
    runtime: {}
  };
}
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'r', environment: 'local', secretNames: ['clientSecret', 'accessToken'], sandbox,
  inherited: { collection: collectionWithBearer, folders: [] }, defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, ...over
});

describe('login, token extraction and inherited auth', () => {
  it('extracts the token into local secrets and uses it for an inheriting request', async () => {
    const layers = env();
    const first = await run(login, opts({ layers }));
    expect(first.result.status).toBe(200);
    expect(first.result.extractions).toEqual([{ variable: 'accessToken', expression: 'res.body.access_token', ok: true, target: 'secret' }]);
    const token = first.updates.secrets.accessToken;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.updates.runtime.accessToken).toBeUndefined(); // secrets don't linger in runtime vars

    const second = await run(bookings, opts({ layers: env({ clientSecret: CLIENT_SECRET, accessToken: token! }) }));
    expect(second.result.status).toBe(200);
    const sent = Object.fromEntries(second.result.request.headers);
    expect(sent.Authorization).toBe('••••••'); // masked in results
    expect(sent['X-Client']).toBe('yept'); // collection header inherited
    expect(JSON.stringify(second.result)).not.toContain(token!);
  });

  it('a failed login clears the token instead of keeping the old one', async () => {
    const r = await run(login, opts({ layers: env({ clientSecret: 'wrong', accessToken: 'old-token-value' }) }));
    expect(r.result.status).toBe(401);
    expect(r.result.extractions[0]).toMatchObject({ ok: false, message: 'Response was 401, not 2xx' });
    expect('accessToken' in r.updates.secrets && r.updates.secrets.accessToken === undefined).toBe(true);
  });

  it('a request inheriting bearer auth without a token is not sent', async () => {
    const r = await run(bookings, opts({ layers: env() }));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toBe('Unresolved variable: accessToken');
  });

  it('non-secret extraction targets go to runtime variables', async () => {
    const r = await run(login, opts({ layers: env(), secretNames: ['clientSecret'] }));
    expect(r.result.extractions[0]).toMatchObject({ ok: true, target: 'runtime' });
    expect(r.updates.runtime.accessToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('folder auth overrides collection auth for inheriting requests', async () => {
    const folder = settings({ auth: { ...noAuth, mode: 'apikey', apikey: { key: 'X-Api-Key', value: '{{apiKey}}', placement: 'header' } } });
    const layers = env();
    layers.environment.file.apiKey = 'k-123';
    const r = await run(doc({ auth: { ...noAuth, mode: 'inherit' } }), opts({ layers, inherited: { collection: collectionWithBearer, folders: [folder] } }));
    const echoed = JSON.parse(r.result.body.text);
    expect(echoed.headers['x-api-key']).toBe('k-123');
    expect(echoed.headers.authorization).toBeUndefined();
  });

  it('API keys can go in the query string', async () => {
    const r = await run(doc({ auth: { ...noAuth, mode: 'apikey', apikey: { key: 'api_key', value: 'k 1', placement: 'queryparams' } } }), opts({ layers: env() }));
    expect(JSON.parse(r.result.body.text).query).toEqual({ api_key: 'k 1' });
  });

  it('unsupported auth modes stop with a clear message', async () => {
    const r = await run(doc({ auth: { ...noAuth, mode: 'digest' } }), opts({ layers: env() }));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/digest.*isn't supported/);
  });

  it('OAuth2 flows other than client credentials stop with a clear message', async () => {
    const r = await run(doc({ auth: { ...noAuth, mode: 'oauth2', oauth2: { ...noAuth.oauth2, grantType: 'authorization_code' } } }), opts({ layers: env() }));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/OAuth2 "authorization_code" isn't supported.*only client credentials/);
  });
});

describe('scripts', () => {
  it('pre-request scripts run collection-first, can set headers and variables', async () => {
    const collection = settings({ script: { req: 'req.setHeader("X-From-Collection", "1"); bru.setVar("trace", "abc");', res: '' } });
    const own = doc({ headers: [{ name: 'X-Trace', value: '{{trace}}', enabled: true }], script: { req: 'req.setHeader("X-From-Request", bru.getVar("trace") + "-r");', res: '' } });
    const r = await run(own, opts({ layers: env(), inherited: { collection, folders: [] } }));
    const h = JSON.parse(r.result.body.text).headers;
    expect(h['x-from-collection']).toBe('1');
    expect(h['x-from-request']).toBe('abc-r');
    expect(h['x-trace']).toBe('abc');
    expect(r.updates.runtime.trace).toBe('abc');
  });

  it('post-response scripts see the response; bru.setVar on a secret name goes to secrets', async () => {
    const own = doc({ method: 'POST', url: '{{baseUrl}}/echo', body: { mode: 'json', json: '{"a":1}', text: '', xml: '', formUrlEncoded: [], multipartForm: [] }, script: { req: '', res: 'bru.setVar("accessToken", "tok-" + res.body.method); bru.setVar("plain", String(res.status)); console.log("done", res.status);' } });
    const r = await run(own, opts({ layers: env() }));
    expect(r.updates.secrets.accessToken).toBe('tok-POST');
    expect(r.updates.runtime.plain).toBe('200');
    expect(r.result.console).toEqual([{ stage: 'post-response', level: 'log', text: 'done 200' }]);
  });

  it('bru.setEnvVar changes last for the session only', async () => {
    const r = await run(doc({ script: { req: 'bru.setEnvVar("region", "eu");', res: '' } }), opts({ layers: env() }));
    expect(r.updates.session).toEqual({ region: 'eu' });
  });

  it('a failing pre-request script stops the request', async () => {
    const r = await run(doc({ script: { req: 'throw new Error("boom")', res: '' } }), opts({ layers: env() }));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/Pre-request script failed: .*boom/);
  });

  it('a runaway pre-request script is stopped and reported', async () => {
    const r = await run(doc({ script: { req: 'while (true) {}', res: '' } }), opts({ layers: env() }));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/timed out after 1500 ms/);
    // The sandbox recovers for the next run.
    const next = await run(doc(), opts({ layers: env() }));
    expect(next.result.status).toBe(200);
  });

  it('a failing post-response script is an error, but the response still shows', async () => {
    const r = await run(doc({ script: { req: '', res: 'undefinedFunction()' } }), opts({ layers: env() }));
    expect(r.result.outcome).toBe('http');
    expect(r.result.scriptErrors[0]).toMatchObject({ stage: 'post-response' });
  });
});

describe('masking', () => {
  it('masks secret values in the sent URL, headers, timeline and console', async () => {
    const layers = env({ clientSecret: CLIENT_SECRET, apiToken: 'super-secret-123' });
    const r = await run(
      doc({ url: '{{baseUrl}}/echo?token={{apiToken}}', headers: [{ name: 'X-Token', value: '{{apiToken}}', enabled: true }], script: { req: '', res: 'console.log(bru.getEnvVar("apiToken"))' } }),
      opts({ layers })
    );
    const visible = JSON.stringify({ ...r.result, body: null });
    expect(visible).not.toContain('super-secret-123');
    expect(r.result.request.url).toContain('token=••••••');
  });
});

// Self-signed HTTPS needs openssl (ships with Git for Windows); skipped when it isn't on PATH.
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('TLS', () => {
  let tlsServer: https.Server;
  let tlsBase = '';
  let certDir = '';
  let intercepted = '';
  beforeAll(async () => {
    // A throwaway CA and a server certificate signed by it, like a company root CA.
    certDir = mkdtempSync(join(tmpdir(), 'yept-tls-'));
    const f = (n: string): string => join(certDir, n);
    const ssl = (...args: string[]): void => void execFileSync('openssl', args, { stdio: 'ignore' });
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '1', '-subj', '/CN=Yept Test CA');
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('key.pem'), '-out', f('leaf.csr'), '-subj', '/CN=127.0.0.1');
    writeFileSync(f('ext.cnf'), ['subjectAltName=IP:127.0.0.1', ''].join(String.fromCharCode(10)));
    ssl('x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('cert.pem'), '-days', '1', '-extfile', f('ext.cnf'));
    tlsServer = https.createServer({ key: readFileSync(f('key.pem')), cert: readFileSync(f('cert.pem')) }, (_req, res) => res.end('secure'));
    await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', () => r()));
    tlsBase = `https://127.0.0.1:${(tlsServer.address() as AddressInfo).port}`;
    // Antivirus TLS inspection (e.g. Norton Web Shield) can re-sign even loopback certificates, replacing our test CA.
    const issuer = await new Promise<string>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: (tlsServer.address() as AddressInfo).port, rejectUnauthorized: false }, () => {
        resolve(String(s.getPeerCertificate().issuer?.CN ?? ''));
        s.end();
      });
      s.on('error', () => resolve(''));
    });
    intercepted = issuer !== 'Yept Test CA' ? issuer : '';
  });
  afterAll(() => {
    tlsServer?.closeAllConnections();
    tlsServer?.close();
    rmSync(certDir, { recursive: true, force: true });
  });

  it('rejects an untrusted certificate as a TLS network error', async () => {
    const r = await run(doc({ url: `${tlsBase}/` }), opts({ layers: env() }));
    expect(r.result.outcome).toBe('network');
    expect(r.result.error?.message).toMatch(/^TLS error/);
  });

  it('accepts it with skip-verify', async () => {
    const skip = await run(doc({ url: `${tlsBase}/` }), opts({ layers: env(), tls: { skipVerify: true } }));
    expect(skip.result.error?.message ?? skip.result.body.text).toBe('secure');
  });

  it('records the TLS protocol, cipher and certificate, including who issued it', async () => {
    const r = await run(doc({ url: `${tlsBase}/` }), opts({ layers: env(), tls: { skipVerify: true } }));
    const h = r.result.hops!.at(-1)!;
    expect(h.connection.tls?.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(h.connection.tls?.cipher).toBeTruthy();
    // On a machine whose antivirus re-signs TLS, the issuer is the antivirus root: that's what this view is for.
    expect(h.connection.tls?.certificate?.issuer).toContain(`CN=${intercepted || 'Yept Test CA'}`);
    expect(h.connection.tls?.certificate?.validTo).toBeTruthy();
    if (!h.timings.reused) expect(h.timings.tls).toBeGreaterThanOrEqual(0);
  });

  it('accepts it when its CA is added', async (ctx) => {
    if (intercepted) {
      console.warn(`Skipped: TLS on this machine is intercepted and re-signed by "${intercepted}"`);
      ctx.skip();
    }
    const ca = await run(doc({ url: `${tlsBase}/` }), opts({ layers: env(), tls: { skipVerify: false, ca: [readFileSync(join(certDir, 'ca.pem'), 'utf8')] } }));
    expect(ca.result.error?.message ?? ca.result.outcome).toBe('http');
  });
});
