import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixtureServer } from '../../../../../fixtures/server/server.mjs';
import { DEFAULT_OAUTH2, type RequestDoc } from '../../shared/model';
import { getAgents, prepare, run, PrepareError, setUserAgent } from './runner';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't',
  method: 'GET',
  url: `${base}/echo`,
  params: [],
  headers: [],
  body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: { mode: 'none', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', placement: 'header' }, oauth2: { ...DEFAULT_OAUTH2 } },
  vars: { req: [], res: [] },
  script: { req: '', res: '' },
  tests: '',
  assertions: [],
  docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const opts = (over: Partial<Parameters<typeof run>[1]> = {}) => ({ runId: 'r1', defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, ...over });

describe('prepare', () => {
  it('blocks unresolved variables and names them', () => {
    expect(() => prepare(doc({ url: '{{baseUrl}}/x', headers: [{ name: 'X-Id', value: '{{id}}', enabled: true }] }), {})).toThrow(PrepareError);
    expect(() => prepare(doc({ url: '{{baseUrl}}/x' }), {})).toThrow(/baseUrl/);
  });

  it('ignores variables in disabled headers', () => {
    expect(() => prepare(doc({ headers: [{ name: 'X', value: '{{nope}}', enabled: false }] }), {})).not.toThrow();
  });

  it('resolves dynamic variables without flagging them', () => {
    const p = prepare(doc({ url: `${base}/echo?id={{$guid}}` }), {});
    expect(p.url).toMatch(/id=[0-9a-f-]{36}/);
  });

  it('encodes the URL once (no double encoding)', () => {
    expect(prepare(doc({ url: `${base}/echo?q=a b` }), {}).url).toBe(`${base}/echo?q=a%20b`);
    expect(prepare(doc({ url: `${base}/echo?q=a%20b` }), {}).url).toBe(`${base}/echo?q=a%20b`);
  });

  it('fills path params', () => {
    const p = prepare(doc({ url: `${base}/users/:id/orders`, params: [{ name: 'id', value: 'a/b', enabled: true, type: 'path' }] }), {});
    expect(p.url).toBe(`${base}/users/a%2Fb/orders`);
  });

  it('adds http:// when the scheme is missing', () => {
    expect(prepare(doc({ url: 'localhost:4010/x' }), {}).url).toBe('http://localhost:4010/x');
  });

  it('keeps JSON bodies valid when interpolating', () => {
    const p = prepare(doc({ method: 'POST', body: { mode: 'json', json: '{"name":"{{name}}"}', text: '', xml: '', formUrlEncoded: [], multipartForm: [] } }), { name: 'Ann "A"' });
    expect(p.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(p.data!)).toEqual({ name: 'Ann "A"' });
  });

  it('escapes newlines and backslashes inside JSON strings, inserts raw values outside strings', () => {
    const json = '{"note":"{{note}}","count":{{count}},"literal":"a\\"{{x}}"}';
    const note = 'l1\nl2 \\ end';
    const p = prepare(doc({ method: 'POST', body: { mode: 'json', json, text: '', xml: '', formUrlEncoded: [], multipartForm: [] } }), { note, count: '3', x: 'y' });
    expect(JSON.parse(p.data!)).toEqual({ note, count: 3, literal: 'a"y' });
  });

  it('identifies as Yept unless the request sets a User-Agent', () => {
    expect(prepare(doc(), {}).headers['User-Agent']).toBe('Yept');
    setUserAgent('Yept/1.2.3');
    expect(prepare(doc(), {}).headers['User-Agent']).toBe('Yept/1.2.3');
    setUserAgent('Yept');
    expect(prepare(doc({ headers: [{ name: 'user-agent', value: 'custom', enabled: true }] }), {}).headers).toEqual({ 'user-agent': 'custom' });
  });

  it('encodes form bodies', () => {
    const p = prepare(doc({ method: 'POST', body: { mode: 'formUrlEncoded', json: '', text: '', xml: '', formUrlEncoded: [{ name: 'a', value: '1 2', enabled: true }, { name: 'b', value: 'x', enabled: false }], multipartForm: [] } }), {});
    expect(p.data).toBe('a=1+2');
    expect(p.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('run', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('sends %s exactly', async (method) => {
    const { result } = await run(doc({ method, body: { mode: 'text', json: '', text: 'hello', xml: '', formUrlEncoded: [], multipartForm: [] } }), opts());
    expect(result.outcome).toBe('http');
    expect(result.status).toBe(200);
    const echoed = JSON.parse(result.body.text);
    expect(echoed.method).toBe(method);
    expect(echoed.body).toBe('hello');
  });

  it('HEAD returns headers and no body', async () => {
    const { result } = await run(doc({ method: 'HEAD' }), opts());
    expect(result.outcome).toBe('http');
    expect(result.sizeBytes).toBe(0);
  });

  it('reports HTTP errors as http outcomes with their status', async () => {
    const { result } = await run(doc({ url: `${base}/status/503` }), opts());
    expect(result.outcome).toBe('http');
    expect(result.status).toBe(503);
  });

  it('times out with a distinct outcome', async () => {
    const { result } = await run(doc({ url: `${base}/hang`, settings: { ...doc().settings, timeoutMs: 300 } }), opts());
    expect(result.outcome).toBe('timeout');
    expect(result.status).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(290);
  });

  it('times out when the body stalls after headers', async () => {
    const { result } = await run(doc({ url: `${base}/stall-body`, settings: { ...doc().settings, timeoutMs: 400 } }), opts());
    expect(result.outcome).toBe('timeout');
  });

  it('cancels', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const { result } = await run(doc({ url: `${base}/hang` }), opts({ signal: ac.signal }));
    expect(result.outcome).toBe('cancelled');
  });

  it('reports connection refused as a network failure, not a status code', async () => {
    const { result } = await run(doc({ url: 'http://127.0.0.1:1/x' }), opts());
    expect(result.outcome).toBe('network');
    expect(result.status).toBeUndefined();
    expect(result.error?.message).toBe('Connection refused');
  });

  it('follows redirects up to the limit', async () => {
    const ok = await run(doc({ url: `${base}/redirect/3` }), opts());
    expect(ok.result.status).toBe(200);
    const loop = await run(doc({ url: `${base}/redirect-loop` }), opts());
    expect(loop.result.outcome).toBe('network');
    expect(loop.result.error?.message).toBe('Too many redirects');
  });

  it('does not follow redirects when disabled', async () => {
    const { result } = await run(doc({ url: `${base}/redirect/1`, settings: { ...doc().settings, followRedirects: false } }), opts());
    expect(result.status).toBe(302);
  });

  it('truncates at the processing limit and says so', async () => {
    const { result, bodyBytes } = await run(doc({ url: `${base}/big?mb=2` }), opts({ maxBodyBytes: 512 * 1024 }));
    expect(result.outcome).toBe('http');
    expect(result.body.truncated).toBe(true);
    expect(bodyBytes.length).toBe(512 * 1024);
  });

  it('flags binary bodies and keeps their bytes', async () => {
    const { result, bodyBytes } = await run(doc({ url: `${base}/binary` }), opts());
    expect(result.body.binary).toBe(true);
    expect(result.body.text).toBe('');
    expect(bodyBytes.length).toBe(8);
  });

  it('returns prepare_error without sending', async () => {
    const { result } = await run(doc({ url: '{{missing}}/x' }), opts());
    expect(result.outcome).toBe('prepare_error');
    expect(result.error?.message).toMatch(/missing/);
  });

  it('runs a frozen snapshot: later edits do not change an in-flight request', async () => {
    const d = doc({ url: `${base}/delay/200` });
    const p = run(d, opts());
    d.url = `${base}/status/500`;
    const { result } = await p;
    expect(result.status).toBe(200);
  });
});

describe('getAgents', () => {
  it('shares agents only for the same TLS settings', () => {
    // Same length and the same first 64 characters, as two certificates of one key type can have.
    const ca = (tail: string): string => `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}${tail}\n-----END CERTIFICATE-----\n`;
    const first = getAgents({ skipVerify: false, ca: [ca('one')] });
    expect(getAgents({ skipVerify: false, ca: [ca('one')] })).toBe(first);
    expect(getAgents({ skipVerify: false, ca: [ca('two')] })).not.toBe(first);
    expect(getAgents({ skipVerify: true, ca: [ca('one')] })).not.toBe(first);
    expect(getAgents({ skipVerify: false, ca: [ca('o'), ca('ne')] })).not.toBe(getAgents({ skipVerify: false, ca: [ca('on'), ca('e')] }));
  });
});
