// Cookie jars: per collection and environment, sent and stored automatically, redirects included,
// the request's own Cookie header wins, session cookies never reach disk, and bru.cookies in scripts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureServer } from '../../../../../fixtures/server/server.mjs';
import { emptyAuth, type AuthConfig, type RequestDoc } from '../../shared/model';
import { SandboxHost } from '../sandbox/host';
import { run, type RunOptions } from '../runner/runner';
import type { Cipher } from '../env/local-store';
import { CookieStore } from './cookie-store';

let server: Server;
let base = '';
let sandbox: SandboxHost;
let dir = '';

// Reversible but not plain text, so the "nothing unencrypted on disk" check means something.
const cipher: Cipher = {
  encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
  decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString()
};

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sandbox = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 3000 });
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await sandbox.close();
});

let store: CookieStore;
const file = (): string => join(dir, 'cookies.json');
const fresh = (): CookieStore => {
  dir = mkdtempSync(join(tmpdir(), 'yept-cookies-'));
  store = new CookieStore(file(), cipher);
  return store;
};
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const noAuth: AuthConfig = { ...emptyAuth(), mode: 'none' };
const doc = (url: string, over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't', method: 'GET', url: `${base}${url}`, params: [], headers: [],
  body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: noAuth, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const COLLECTION = 'C:\\ws\\Sample Travel';
const opts = (env = 'dev', collection = COLLECTION, over: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'r', sandbox, defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, environment: env, cookies: store.forRun(collection, env), ...over
});
const echoed = (r: Awaited<ReturnType<typeof run>>): Record<string, string> => JSON.parse(r.result.body.text).cookies;

describe('automatic cookies', () => {
  it('stores Set-Cookie and sends it on the next request to the same host', async () => {
    fresh();
    const set = await run(doc('/cookies/set?sid=abc&theme=dark'), opts());
    expect(set.result.cookies).toEqual({ source: 'none', sent: [], stored: ['sid', 'theme'] });
    const echo = await run(doc('/cookies/echo'), opts());
    expect(echoed(echo)).toEqual({ sid: 'abc', theme: 'dark' });
    expect(echo.result.cookies).toMatchObject({ source: 'jar', sent: ['sid', 'theme'] });
    // Never shown in the result, like Authorization.
    expect(echo.result.request.headers).toContainEqual(['Cookie', '••••••']);
  });

  it('keeps environments and collections apart', async () => {
    fresh();
    await run(doc('/cookies/set?sid=dev-session'), opts('dev'));
    expect(echoed(await run(doc('/cookies/echo'), opts('uat')))).toEqual({});
    expect(echoed(await run(doc('/cookies/echo'), opts('dev', 'C:\\ws\\Other')))).toEqual({});
    // Collection paths compare case-insensitively only on Windows.
    const expected = process.platform === 'win32' ? { sid: 'dev-session' } : {};
    expect(echoed(await run(doc('/cookies/echo'), opts('dev', COLLECTION.toUpperCase())))).toEqual(expected);
  });

  it('respects the cookie path', async () => {
    fresh();
    await run(doc('/cookies/set?scoped=1&path=/cookies/echo'), opts());
    await run(doc('/cookies/set?wide=1'), opts());
    expect(echoed(await run(doc('/cookies/echo'), opts()))).toEqual({ scoped: '1', wide: '1' });
    const elsewhere = await run(doc('/echo'), opts());
    expect(JSON.parse(elsewhere.result.body.text).headers.cookie).toBe('wide=1');
  });

  it('a Cookie header set on the request wins over the jar', async () => {
    fresh();
    await run(doc('/cookies/set?sid=from-jar'), opts());
    const r = await run(doc('/cookies/echo', { headers: [{ name: 'Cookie', value: 'sid=mine', enabled: true }] }), opts());
    expect(echoed(r)).toEqual({ sid: 'mine' });
    expect(r.result.cookies?.source).toBe('request');
    expect(r.result.cookieDetails).toEqual([expect.objectContaining({ name: 'sid', direction: 'sent', source: 'request' })]);
    expect(r.cookieValues).toEqual(['mine']);
    expect(JSON.stringify(r.result.cookieDetails)).not.toContain('mine');
  });

  it("'Don't send stored cookies' sends none but still stores new ones", async () => {
    fresh();
    await run(doc('/cookies/set?sid=abc'), opts());
    const settings = { ...doc('').settings, sendCookies: false };
    expect(echoed(await run(doc('/cookies/echo', { settings }), opts()))).toEqual({});
    await run(doc('/cookies/set?later=1', { settings }), opts());
    expect(echoed(await run(doc('/cookies/echo'), opts()))).toEqual({ sid: 'abc', later: '1' });
  });

  it('stores cookies from a redirect and sends them on the next hop', async () => {
    fresh();
    const r = await run(doc('/cookies/redirect'), opts());
    expect(echoed(r)).toEqual({ hop: '1' });
    expect(r.result.cookies?.stored).toEqual(['hop']);
    expect(r.result.hops!.map((h) => h.status)).toEqual([302, 200]);
    expect(r.result.cookieDetails).toEqual([
      expect.objectContaining({ hop: 0, direction: 'received', name: 'hop' }),
      expect.objectContaining({ hop: 1, direction: 'sent', name: 'hop', source: 'jar' })
    ]);
    expect(r.cookieValues).toEqual(['1', '1']);
  });

  it('does nothing when automatic cookies are off', async () => {
    fresh();
    const off = opts('dev', COLLECTION, { cookies: undefined });
    await run(doc('/cookies/set?sid=abc'), off);
    expect(store.list(COLLECTION, 'dev')).toEqual([]);
  });
});

describe('storage', () => {
  it('keeps persistent cookies across restarts, never session cookies, and nothing in plain text', async () => {
    fresh();
    await run(doc('/cookies/set?persistent-value-123=1&max-age=3600'), opts());
    await run(doc('/cookies/set?session-value-456=1'), opts());
    const raw = readFileSync(file(), 'utf8');
    expect(raw).not.toContain('persistent-value-123');
    expect(raw).not.toContain('session-value-456');
    expect(raw).not.toContain('127.0.0.1');
    const reopened = new CookieStore(file(), cipher);
    expect(reopened.list(COLLECTION, 'dev').map((c) => c.name)).toEqual(['persistent-value-123']);
    expect(reopened.list(COLLECTION, 'dev')[0].expires).toBeTruthy();
  });

  it('drops expired cookies', () => {
    fresh();
    store.upsert(COLLECTION, 'dev', { name: 'old', value: '1', domain: 'api.example.test', path: '/', expires: new Date(Date.now() - 1000).toISOString(), secure: false, httpOnly: false, sameSite: '', hostOnly: true });
    store.upsert(COLLECTION, 'dev', { name: 'new', value: '1', domain: 'api.example.test', path: '/', expires: new Date(Date.now() + 60_000).toISOString(), secure: false, httpOnly: false, sameSite: '', hostOnly: true });
    expect(store.list(COLLECTION, 'dev').map((c) => c.name)).toEqual(['new']);
    expect(new CookieStore(file(), cipher).list(COLLECTION, 'dev').map((c) => c.name)).toEqual(['new']);
  });

  it('adds, edits, removes and clears by domain', () => {
    fresh();
    const c = { name: 'a', value: '1', domain: 'api.example.test', path: '/', expires: null, secure: true, httpOnly: true, sameSite: 'lax', hostOnly: true };
    store.upsert(COLLECTION, 'dev', c);
    store.upsert(COLLECTION, 'dev', { ...c, name: 'b' });
    store.upsert(COLLECTION, 'dev', { ...c, domain: 'other.example.test' });
    store.upsert(COLLECTION, 'dev', { ...c, name: 'a2', value: '2' }, { domain: c.domain, path: '/', name: 'a' });
    expect(store.list(COLLECTION, 'dev').map((x) => `${x.domain}/${x.name}=${x.value}`)).toEqual(['api.example.test/a2=2', 'api.example.test/b=1', 'other.example.test/a=1']);
    expect(store.list(COLLECTION, 'dev')[0]).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax', hostOnly: true, expires: null });
    store.remove(COLLECTION, 'dev', { domain: 'api.example.test', path: '/', name: 'b' });
    store.clear(COLLECTION, 'dev', 'other.example.test');
    expect(store.list(COLLECTION, 'dev').map((x) => x.name)).toEqual(['a2']);
    store.clear(COLLECTION, 'dev');
    expect(store.count(COLLECTION, 'dev')).toBe(0);
  });

  it('rejects cookie names and values that would break the header', () => {
    fresh();
    const c = { name: 'bad name', value: '1', domain: 'api.example.test', path: '/', expires: null, secure: false, httpOnly: false, sameSite: '', hostOnly: true };
    expect(() => store.upsert(COLLECTION, 'dev', c)).toThrow(/names cannot contain/);
    expect(() => store.upsert(COLLECTION, 'dev', { ...c, name: 'ok', value: 'a;b' })).toThrow(/values cannot contain/);
  });
});

describe('bru.cookies in scripts', () => {
  it('reads, adds and removes cookies; changes come back to the jar', async () => {
    fresh();
    await run(doc('/cookies/set?sid=abc&old=1'), opts());
    const script = [
      'bru.setVar("seen", bru.cookies.get("sid"));',
      'bru.setVar("has", String(bru.cookies.has("old")));',
      'await bru.cookies.upsert({ key: "lang", value: "en" });',
      'await bru.cookies.remove("old");'
    ].join('\n');
    const r = await run(doc('/cookies/echo', { script: { req: script, res: '' } }), opts());
    expect(r.result.scriptErrors).toEqual([]);
    expect(r.updates.runtime).toMatchObject({ seen: 'abc', has: 'true' });
    expect(store.list(COLLECTION, 'dev').map((c) => c.name).sort()).toEqual(['lang', 'sid']);
    // The pre-request change is already in this request's Cookie header.
    expect(echoed(r)).toEqual({ sid: 'abc', lang: 'en' });
  });

  it('jar() reaches other URLs and clear() empties this jar only', async () => {
    fresh();
    await run(doc('/cookies/set?sid=abc'), opts('uat'));
    const script = [
      'const jar = bru.cookies.jar();',
      'await jar.setCookie("https://api.example.test/", "token", "t1");',
      'const c = await jar.getCookie("https://api.example.test/", "token");',
      'bru.setVar("token", c.value);'
    ].join('\n');
    const r = await run(doc('/echo', { script: { req: '', res: script } }), opts());
    expect(r.updates.runtime.token).toBe('t1');
    expect(store.list(COLLECTION, 'dev').map((c) => `${c.domain}/${c.name}`)).toEqual(['api.example.test/token']);
    await run(doc('/echo', { script: { req: '', res: 'await bru.cookies.jar().clear();' } }), opts());
    expect(store.count(COLLECTION, 'dev')).toBe(0);
    expect(store.count(COLLECTION, 'uat')).toBe(1);
  });

  it('says why when automatic cookies are off', async () => {
    fresh();
    const r = await run(doc('/echo', { script: { req: 'bru.cookies.jar()', res: '' } }), opts('dev', COLLECTION, { cookies: undefined }));
    expect(r.result.scriptErrors[0]?.message).toMatch(/automatic cookies are turned off/);
  });
});
