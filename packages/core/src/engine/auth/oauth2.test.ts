// OAuth2 client credentials: token fetch and cache, renewal, the one retry after a 401, masking, and the file format.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixtureServer, CLIENT_ID, CLIENT_SECRET } from '../../../../../fixtures/server/server.mjs';
import { DEFAULT_OAUTH2, emptyAuth, type AuthConfig, type OAuth2Config, type RequestDoc } from '../../shared/model';
import { emptyEnvLayer, type VarLayers } from '../env/variables';
import { run, type RunOptions } from '../runner/runner';
import { applyRequestDoc, parseRequestFile, stringifyRequestFile, toRequestDoc } from '../workspace/bruno-adapter';
import { TokenCache } from './oauth2';

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

const tokenRequests = async (): Promise<number> => (await (await fetch(`${base}/auth/stats`)).json()).tokenRequests;
const revokeAll = async (): Promise<void> => void (await fetch(`${base}/auth/revoke`, { method: 'POST' }));

const oauth = (over: Partial<OAuth2Config> = {}): AuthConfig => ({
  ...emptyAuth(),
  mode: 'oauth2',
  oauth2: { ...DEFAULT_OAUTH2, accessTokenUrl: '{{baseUrl}}/auth/token', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', ...over }
});
const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't', method: 'GET', url: '{{baseUrl}}/bookings', params: [], headers: [],
  body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: oauth(), vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const layers = (secret = CLIENT_SECRET): VarLayers => ({
  collection: [], folders: [], request: [], runtime: {},
  environment: { ...emptyEnvLayer(), file: { baseUrl: base, clientId: CLIENT_ID }, secrets: { clientSecret: secret } }
});
const opts = (cache: TokenCache, scope = 'collection\u0000dev', over: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'r', environment: 'dev', layers: layers(), secretNames: ['clientSecret'], defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024,
  oauth2: { cache, scope }, ...over
});

describe('OAuth2 client credentials', () => {
  it('fetches a token on the first send and reuses it until it expires', async () => {
    const cache = new TokenCache();
    const before = await tokenRequests();
    const first = await run(doc(), opts(cache));
    expect(first.result.status).toBe(200);
    expect(first.result.oauth2).toMatchObject({ token: 'fetched' });
    expect(first.result.oauth2?.expiresAt).toBeTruthy();
    expect(first.result.timeline.find((t) => t.label === 'OAuth2 token')?.detail).toMatch(/^New token from .*\/auth\/token, expires in 60 min$/);
    const second = await run(doc(), opts(cache));
    expect(second.result.status).toBe(200);
    expect(second.result.oauth2).toMatchObject({ token: 'cached' });
    expect((await tokenRequests()) - before).toBe(1);
  });

  it('never shows the token or the client secret, and keeps them out of what history stores', async () => {
    const r = await run(doc(), opts(new TokenCache()));
    const sent = r.sent!.headers.find(([k]) => k === 'Authorization')![1];
    expect(sent).toMatch(/^Bearer [0-9a-f-]{36}$/);
    const token = sent.slice('Bearer '.length);
    const visible = JSON.stringify({ ...r.result, body: null });
    expect(visible).not.toContain(token);
    expect(visible).not.toContain(CLIENT_SECRET);
    expect(r.secrets.map((s) => s.value)).toEqual(expect.arrayContaining([token, CLIENT_SECRET]));
  });

  it('renews an expired token before sending', async () => {
    const cache = new TokenCache();
    // A 1-second token counts as expired at once (tokens are renewed a little early).
    const short = oauth({ accessTokenUrl: '{{baseUrl}}/auth/token?expires_in=1' });
    const before = await tokenRequests();
    await run(doc({ auth: short }), opts(cache));
    const again = await run(doc({ auth: short }), opts(cache));
    expect(again.result.status).toBe(200);
    expect(again.result.oauth2?.token).toBe('renewed');
    expect((await tokenRequests()) - before).toBe(2);
  });

  it('keeps tokens apart per environment and per configuration', async () => {
    const cache = new TokenCache();
    const before = await tokenRequests();
    await run(doc(), opts(cache, 'collection\u0000dev'));
    await run(doc(), opts(cache, 'collection\u0000uat'));
    const scoped = await run(doc({ auth: oauth({ scope: 'bookings.read' }) }), opts(cache, 'collection\u0000dev'));
    expect(scoped.result.oauth2?.token).toBe('fetched');
    expect((await tokenRequests()) - before).toBe(3);
    expect(cache.status('collection\u0000dev', { accessTokenUrl: `${base}/auth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scope: 'bookings.read', credentialsPlacement: 'basic_auth_header' })).toMatchObject({ state: 'valid', scope: 'bookings.read' });
  });

  it('shares one token request between sends running at the same time', async () => {
    const cache = new TokenCache();
    const before = await tokenRequests();
    const all = await Promise.all([1, 2, 3].map(() => run(doc(), opts(cache))));
    expect(all.map((r) => r.result.status)).toEqual([200, 200, 200]);
    expect((await tokenRequests()) - before).toBe(1);
  });

  it('sends the client credentials in the body when asked', async () => {
    const r = await run(doc({ auth: oauth({ credentialsPlacement: 'body' }) }), opts(new TokenCache()));
    expect(r.result.status).toBe(200);
  });

  it('puts the token in the URL when asked, masked in what is shown', async () => {
    const r = await run(doc({ url: '{{baseUrl}}/bookings-by-query', auth: oauth({ tokenPlacement: 'url', tokenQueryKey: 'access_token' }) }), opts(new TokenCache()));
    expect(r.result.status).toBe(200);
    expect(r.result.request.url).toMatch(/\?access_token=••••••$/);
    expect(r.result.request.headers.some(([k]) => k === 'Authorization')).toBe(false);
  });

  it('after a 401 with a cached token, retries a GET once with a new token', async () => {
    const cache = new TokenCache();
    await run(doc(), opts(cache));
    await revokeAll();
    const r = await run(doc(), opts(cache));
    expect(r.result.status).toBe(200);
    expect(r.result.oauth2).toMatchObject({ token: 'renewed', retried: true });
    expect(r.result.hops!.map((h) => h.status)).toEqual([401, 200]);
    expect(r.result.timeline.some((t) => t.detail === 'Re-sent once with a new token')).toBe(true);
  });

  it('after a 401 with a cached token, does not re-send a POST, and the next send gets a new token', async () => {
    const cache = new TokenCache();
    const post = doc({ method: 'POST', body: { mode: 'json', json: '{"destination":"Oslo"}', text: '', xml: '', formUrlEncoded: [], multipartForm: [] } });
    await run(post, opts(cache));
    await revokeAll();
    const rejected = await run(post, opts(cache));
    expect(rejected.result.status).toBe(401);
    expect(rejected.result.hops).toHaveLength(1);
    expect(rejected.result.oauth2?.note).toMatch(/POST requests aren't re-sent automatically.*send again/);
    const next = await run(post, opts(cache));
    expect(next.result.status).toBe(201);
    expect(next.result.oauth2?.token).toBe('fetched');
  });

  it('does not retry when a token fetched for this very run is rejected', async () => {
    const r = await run(doc({ url: '{{baseUrl}}/status/401' }), opts(new TokenCache()));
    expect(r.result.status).toBe(401);
    expect(r.result.hops).toHaveLength(1);
    expect(r.result.oauth2?.retried).toBeUndefined();
  });

  it('with automatic fetching off and no token, says to use Get token', async () => {
    const r = await run(doc({ auth: oauth({ autoFetchToken: false }) }), opts(new TokenCache()));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/no OAuth2 token yet.*Get token/);
  });

  it('reports a rejected client without the secret, and sends nothing', async () => {
    const before = await tokenRequests();
    const r = await run(doc(), opts(new TokenCache(), 'x', { layers: layers('wrong-secret-value') }));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toBe('OAuth2 token request failed: The token endpoint answered 401 (invalid_client: Unknown client or wrong secret)');
    expect(r.result.hops).toBeUndefined();
    expect(JSON.stringify(r.result)).not.toContain('wrong-secret-value');
    expect((await tokenRequests()) - before).toBe(1);
  });

  it('checks the request before fetching a token: unresolved variables stop it first', async () => {
    const before = await tokenRequests();
    const r = await run(doc({ url: '{{baseUrl}}/bookings/{{missing}}' }), opts(new TokenCache()));
    expect(r.result.error?.message).toBe('Unresolved variable: missing');
    expect((await tokenRequests()) - before).toBe(0);
  });

  it('reports an unreachable token endpoint as not sent', async () => {
    const r = await run(doc({ auth: oauth({ accessTokenUrl: 'http://127.0.0.1:1/token' }) }), opts(new TokenCache()));
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toBe('OAuth2 token request failed: Connection refused');
  });
});

describe('OAuth2 in Bruno files', () => {
  const FILE = `info:
  name: Bookings
  type: http
  seq: 1

http:
  method: GET
  url: "{{baseUrl}}/bookings"
  auth:
    type: oauth2
    flow: client_credentials
    accessTokenUrl: "{{baseUrl}}/auth/token"
    credentials:
      clientId: "{{clientId}}"
      clientSecret: "{{clientSecret}}"
      placement: basic_auth_header
    scope: bookings.read
    tokenConfig:
      id: credentials
      placement:
        header: Bearer
      source: access_token
    settings:
      autoFetchToken: true
      autoRefreshToken: true

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: true
`;

  it('reads client credentials and writes the file back unchanged', () => {
    const item = parseRequestFile(FILE, 'yml');
    const d = toRequestDoc(item);
    expect(d.auth.mode).toBe('oauth2');
    expect(d.auth.oauth2).toMatchObject({ grantType: 'client_credentials', accessTokenUrl: '{{baseUrl}}/auth/token', clientId: '{{clientId}}', scope: 'bookings.read', tokenPlacement: 'header', tokenHeaderPrefix: 'Bearer', autoFetchToken: true, autoRefreshToken: true });
    expect(stringifyRequestFile(applyRequestDoc(item, d))).toBe(FILE);
  });

  it('saves edits and keeps the fields Yept does not edit', () => {
    const item = parseRequestFile(FILE, 'yml');
    const d = toRequestDoc(item);
    const out = stringifyRequestFile(applyRequestDoc(item, { ...d, auth: { ...d.auth, oauth2: { ...d.auth.oauth2, scope: 'bookings.write', credentialsPlacement: 'body' } } }));
    expect(out).toContain('scope: bookings.write');
    expect(out).toContain('placement: body');
    expect(out).toContain('id: credentials');
  });

  it('leaves other OAuth2 flows exactly as they were', () => {
    const other = FILE.replace('flow: client_credentials', 'flow: authorization_code');
    const item = parseRequestFile(other, 'yml');
    const d = toRequestDoc(item);
    expect(d.auth.oauth2.grantType).toBe('authorization_code');
    const before = stringifyRequestFile(item);
    expect(stringifyRequestFile(applyRequestDoc(item, { ...d, auth: { ...d.auth, oauth2: { ...d.auth.oauth2, scope: 'changed' } } }))).toBe(before);
  });
});
