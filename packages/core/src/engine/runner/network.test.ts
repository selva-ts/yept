// What the Network tab shows: each request on the wire, its timings, connection details and the headers really sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixtureServer } from '../../../../../fixtures/server/server.mjs';
import { DEFAULT_OAUTH2, type AuthConfig, type RequestDoc } from '../../shared/model';
import { SandboxHost } from '../sandbox/host';
import { run, type RunOptions } from './runner';

let server: Server;
let base = '';
let sandbox: SandboxHost;

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sandbox = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 10000 });
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await sandbox.close();
});

const noAuth: AuthConfig = { mode: 'none', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', placement: 'header' }, oauth2: { ...DEFAULT_OAUTH2 } };
const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't', method: 'GET', url: `${base}/echo`, params: [], headers: [],
  body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: noAuth, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({ runId: 'r', sandbox, defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, ...over });

describe('network recording', () => {
  it('records one hop with the headers actually sent, timings and the remote address', async () => {
    const r = await run(doc({ url: `${base}/echo?x=1`, headers: [{ name: 'X-Trace', value: 't1', enabled: true }] }), opts());
    const hops = r.result.hops!;
    expect(hops).toHaveLength(1);
    const [h] = hops;
    expect(h).toMatchObject({ method: 'GET', url: `${base}/echo?x=1`, status: 200 });
    const sent = Object.fromEntries(h.requestHeaders.map(([k, v]) => [k.toLowerCase(), v]));
    // Headers Yept and the HTTP stack add are listed too, not only the ones in the request.
    expect(sent['x-trace']).toBe('t1');
    expect(sent['user-agent']).toMatch(/^Yept/);
    expect(sent.host).toBe(new URL(base).host);
    expect(sent.accept).toBeTruthy();
    expect(h.responseHeaders.some(([k]) => k === 'content-type')).toBe(true);
    expect(h.connection).toMatchObject({ remoteAddress: '127.0.0.1', remotePort: Number(new URL(base).port), httpVersion: '1.1' });
    expect(h.connection.tls).toBeUndefined();
    expect(h.timings.total).toBeGreaterThanOrEqual(0);
    expect(h.timings.wait).toBeGreaterThanOrEqual(0);
    expect(h.timings.download).toBeGreaterThanOrEqual(0);
    // An IP address needs no DNS lookup; a new connection has a connect phase, a reused one doesn't.
    expect(h.timings.dns).toBeUndefined();
    if (!h.timings.reused) expect(h.timings.connect).toBeGreaterThanOrEqual(0);
    else expect(h.timings.connect).toBeUndefined();
  });

  it('records each redirect as its own hop, final request last', async () => {
    const r = await run(doc({ url: `${base}/redirect/2` }), opts());
    const hops = r.result.hops!;
    expect(hops.map((h) => [h.url.replace(base, ''), h.status])).toEqual([
      ['/redirect/2', 302],
      ['/redirect/1', 302],
      ['/echo', 200]
    ]);
    expect(hops[0].responseHeaders).toContainEqual(['location', '/redirect/1']);
    expect(r.result.timeline.filter((t) => t.label.startsWith('Redirect'))).toHaveLength(2);
  });

  it('records the redirect hop only when redirects are off', async () => {
    const r = await run(doc({ url: `${base}/redirect/1`, settings: { ...doc().settings, followRedirects: false } }), opts());
    expect(r.result.status).toBe(302);
    expect(r.result.hops!.map((h) => h.status)).toEqual([302]);
  });

  it('keeps a partial hop when the connection fails', async () => {
    const r = await run(doc({ url: 'http://127.0.0.1:1/' }), opts());
    expect(r.result.outcome).toBe('network');
    expect(r.result.hops).toHaveLength(1);
    expect(r.result.hops![0].status).toBeUndefined();
  });

  it('has no hops when nothing was sent', async () => {
    const r = await run(doc({ url: '{{missing}}/x' }), opts());
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.hops).toBeUndefined();
  });

  it('masks credentials in hop headers, and keeps the unmasked request for Copy as cURL', async () => {
    const r = await run(doc({ auth: { ...noAuth, mode: 'bearer', bearer: { token: 'tok-very-secret' } } }), opts());
    const shown = JSON.stringify(r.result.hops);
    expect(shown).not.toContain('tok-very-secret');
    expect(r.result.hops![0].requestHeaders).toContainEqual(['Authorization', '••••••']);
    expect(r.sent?.headers).toContainEqual(['Authorization', 'Bearer tok-very-secret']);
  });

  it('keeps console output from a pre-request script when the request then cannot be prepared', async () => {
    const r = await run(doc({ url: '{{missing}}/x', script: { req: 'console.log("before"); console.warn("careful")', res: '' } }), opts());
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.console).toEqual([
      { stage: 'pre-request', level: 'log', text: 'before' },
      { stage: 'pre-request', level: 'warn', text: 'careful' }
    ]);
  });
});
