// bru.sendRequest: the Bruno call and return shapes (promise and callback forms, axios-style errors), scripts
// converted from Postman, masking, the per-script limit, the shared time limit, cancel, cookies and no recursion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postmanTranslation } from '@usebruno/converters';
import { createFixtureServer, CLIENT_ID, CLIENT_SECRET } from '../../../../../fixtures/server/server.mjs';
import { DEFAULT_OAUTH2, type AuthConfig, type RequestDoc, type SettingsDoc } from '../../shared/model';
import { SandboxHost } from '../sandbox/host';
import { emptyEnvLayer, type VarLayers } from '../env/variables';
import { CookieStore } from '../cookies/cookie-store';
import { run, type RunOptions } from './runner';
import { MAX_SCRIPT_REQUESTS, ScriptRequestError, prepareScriptRequest, scriptOptions } from './script-requests';

let server: Server;
let base = '';
// Normal scripts get a generous limit so a slow machine cannot time them out; the runaway-script test uses its own short one.
let sandbox: SandboxHost;
let quick: SandboxHost;
let dir = '';

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sandbox = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 10000 });
  quick = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 2000 });
  dir = mkdtempSync(join(tmpdir(), 'yept-send-'));
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await sandbox.close();
  await quick.close();
  rmSync(dir, { recursive: true, force: true });
});

const noAuth: AuthConfig = { mode: 'none', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', placement: 'header' }, oauth2: { ...DEFAULT_OAUTH2 } };
const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't', method: 'GET', url: '{{baseUrl}}/echo', params: [], headers: [],
  body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: noAuth, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const pre = (script: string, over: Partial<RequestDoc> = {}): RequestDoc => doc({ ...over, script: { req: script, res: '' } });
const settings = (over: Partial<SettingsDoc> = {}): SettingsDoc => ({ name: 'c', headers: [], auth: noAuth, vars: [], script: { req: '', res: '' }, tests: '', docs: '', ...over });
const layers = (): VarLayers => ({
  collection: [],
  environment: { ...emptyEnvLayer(), file: { baseUrl: base, clientId: CLIENT_ID }, secrets: { clientSecret: CLIENT_SECRET } },
  folders: [],
  request: [],
  runtime: {}
});
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'r1', sandbox, layers: layers(), environment: 'dev', secretNames: ['clientSecret', 'accessToken'], defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, ...over
});

describe('bru.sendRequest call shapes', () => {
  it('promise form: a pre-request login whose token the request then uses', async () => {
    const script = `
      const res = await bru.sendRequest({
        method: 'POST',
        url: bru.getEnvVar('baseUrl') + '/auth/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: { grant_type: 'client_credentials', client_id: bru.getEnvVar('clientId'), client_secret: bru.getEnvVar('clientSecret') }
      });
      bru.setVar('status', String(res.status));
      bru.setVar('statusText', res.statusText);
      bru.setVar('contentType', res.headers['content-type']);
      bru.setVar('hasTime', String(typeof res.responseTime === 'number'));
      bru.setEnvVar('accessToken', res.data.access_token);
      console.log('token', res.data.access_token);
    `;
    const out = await run(pre(script, { url: '{{baseUrl}}/bookings', auth: { ...noAuth, mode: 'bearer', bearer: { token: '{{accessToken}}' } } }), opts());
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.result.status).toBe(200);
    expect(out.updates.runtime).toMatchObject({ status: '200', statusText: 'OK', contentType: 'application/json', hasTime: 'true' });
    const token = out.updates.secrets.accessToken!;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    // One child run, shown with the parent's environment and masked like the parent.
    const [child] = out.result.scriptRequests!;
    expect(child.stage).toBe('pre-request');
    expect(child.result.runId).toBe('r1.1');
    expect(child.result.environment).toBe('dev');
    expect(child.result.request.method).toBe('POST');
    expect(child.result.requestBody).toContain('client_secret=••••••');
    expect(JSON.stringify(child.result)).not.toContain(CLIENT_SECRET);
    expect(child.result.hops).toHaveLength(1);
    // The token the script set as a secret is masked in the parent's console and timeline.
    expect(out.result.console.map((c) => c.text)).toEqual(['token ••••••']);
    expect(JSON.stringify(out.result.console)).not.toContain(token);
    expect(out.result.timeline.find((t) => t.label === 'Script request')?.detail).toMatch(/^pre-request: POST http:\/\/127\.0\.0\.1:\d+\/auth\/token → 200/);
    // The unmasked request stays in the main process for Copy as cURL with secrets.
    expect(out.scriptRequests?.[0].runId).toBe('r1.1');
    expect(out.scriptRequests?.[0].sent?.body).toContain(`client_secret=${CLIENT_SECRET}`);
  });

  it('accepts a URL string, params and an object body sent as JSON', async () => {
    const script = `
      const a = await bru.sendRequest(bru.getEnvVar('baseUrl') + '/echo');
      bru.setVar('aMethod', a.data.method);
      const b = await bru.sendRequest({ method: 'put', url: bru.getEnvVar('baseUrl') + '/echo', params: { q: 'a b', n: 2 }, data: { hello: 'world' } });
      bru.setVar('bMethod', b.data.method);
      bru.setVar('bQuery', JSON.stringify(b.data.query));
      bru.setVar('bType', b.data.headers['content-type']);
      bru.setVar('bBody', b.data.body);
      bru.setVar('bAgent', b.data.headers['user-agent']);
    `;
    const out = await run(pre(script), opts());
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.updates.runtime).toMatchObject({ aMethod: 'GET', bMethod: 'PUT', bQuery: '{"q":"a b","n":"2"}', bType: 'application/json', bBody: '{"hello":"world"}' });
    expect(out.updates.runtime.bAgent).toMatch(/^Yept/);
    expect(out.result.scriptRequests).toHaveLength(2);
  });

  it('promise form rejects for a non-2xx status with an axios-shaped error', async () => {
    const script = `
      try {
        await bru.sendRequest({ url: bru.getEnvVar('baseUrl') + '/status/404' });
        bru.setVar('reached', 'yes');
      } catch (e) {
        bru.setVar('message', e.message);
        bru.setVar('code', e.code);
        bru.setVar('status', String(e.status));
        bru.setVar('responseStatus', String(e.response.status));
        bru.setVar('responseBody', JSON.stringify(e.response.data));
      }
    `;
    const out = await run(pre(script), opts());
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.updates.runtime).toMatchObject({ message: 'Request failed with status code 404', code: 'ERR_BAD_REQUEST', status: '404', responseStatus: '404', responseBody: '{"status":404}' });
    expect(out.updates.runtime.reached).toBeUndefined();
    // The request still shows in Network.
    expect(out.result.scriptRequests?.[0].result.status).toBe(404);
  });

  it('callback form: (null, res) on success, (err with status, null) on failure', async () => {
    const script = `
      await bru.sendRequest({ url: bru.getEnvVar('baseUrl') + '/echo' }, (err, res) => {
        bru.setVar('okErr', String(err));
        bru.setVar('okPath', res.data.path);
      });
      await bru.sendRequest({ url: bru.getEnvVar('baseUrl') + '/status/500' }, function (err, res) {
        bru.setVar('failStatus', String(err.status));
        bru.setVar('failCode', err.code);
        bru.setVar('failRes', String(res));
      });
    `;
    const out = await run(pre(script), opts());
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.updates.runtime).toMatchObject({ okErr: 'null', okPath: '/echo', failStatus: '500', failCode: 'ERR_BAD_RESPONSE', failRes: 'null' });
  });

  it('a network failure rejects with the reason and the run reports the script error', async () => {
    const script = `await bru.sendRequest({ url: 'http://127.0.0.1:1/nothing-listens-here' });`;
    const out = await run(pre(script), opts());
    expect(out.result.outcome).toBe('prepare_error');
    expect(out.result.scriptErrors[0].message).toMatch(/Connection refused/);
    expect(out.result.scriptRequests?.[0].result.outcome).toBe('network');
  });

  it('options it cannot send fail in the script, with nothing sent', async () => {
    const out = await run(pre(`
      for (const o of [{}, { url: 'ftp://example.test/x' }, { url: bru.getEnvVar('baseUrl'), method: 'BREW' }]) {
        try { await bru.sendRequest(o); } catch (e) { console.log(e.message); }
      }
    `), opts());
    expect(out.result.console.map((c) => c.text)).toEqual([
      'bru.sendRequest needs a url',
      'bru.sendRequest: only http and https URLs can be sent (ftp:)',
      'bru.sendRequest: method "BREW" isn\'t supported'
    ]);
    expect(out.result.scriptRequests).toBeUndefined();
  });
});

describe('scripts converted from Postman', () => {
  it('runs pm.sendRequest login, string-URL and promise-chain scripts after conversion', async () => {
    const postman = [
      `pm.sendRequest({
        url: pm.environment.get("baseUrl") + "/auth/token",
        method: "POST",
        header: [{ key: "Content-Type", value: "application/x-www-form-urlencoded" }],
        body: { mode: "urlencoded", urlencoded: [
          { key: "grant_type", value: "client_credentials" },
          { key: "client_id", value: pm.environment.get("clientId") },
          { key: "client_secret", value: pm.environment.get("clientSecret") }
        ] }
      }, function (err, res) {
        pm.environment.set("accessToken", res.json().access_token);
        pm.variables.set("loginCode", String(res.code));
      });`,
      `pm.sendRequest(pm.environment.get("baseUrl") + "/echo", (err, response) => { pm.variables.set("echoPath", response.json().path); });`,
      `const r = { url: pm.environment.get("baseUrl") + "/echo", method: "POST", header: { "Content-Type": "application/json" }, body: { mode: "raw", raw: JSON.stringify({ a: 1 }) } };
      pm.sendRequest(r).then((res) => { pm.variables.set("echoBody", res.json().body); });`
    ].map((s) => postmanTranslation(s));
    expect(postman.every((s) => s.includes('bru.sendRequest'))).toBe(true);
    const out = await run(pre(postman.join('\n'), { url: '{{baseUrl}}/bookings', auth: { ...noAuth, mode: 'bearer', bearer: { token: '{{accessToken}}' } } }), opts());
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.result.status).toBe(200);
    expect(out.updates.runtime).toMatchObject({ loginCode: '200', echoPath: '/echo', echoBody: '{"a":1}' });
    expect(out.result.scriptRequests).toHaveLength(3);
  });
});

describe('limits', () => {
  it(`allows ${MAX_SCRIPT_REQUESTS} requests per script`, async () => {
    const script = `
      let sent = 0;
      try {
        for (let i = 0; i < ${MAX_SCRIPT_REQUESTS + 1}; i++) { await bru.sendRequest(bru.getEnvVar('baseUrl') + '/echo?i=' + i); sent++; }
      } catch (e) { bru.setVar('limit', e.message); }
      bru.setVar('sent', String(sent));
    `;
    const out = await run(pre(script), opts());
    expect(out.updates.runtime).toMatchObject({ sent: String(MAX_SCRIPT_REQUESTS), limit: `bru.sendRequest: a script can send at most ${MAX_SCRIPT_REQUESTS} requests` });
    expect(out.result.scriptRequests).toHaveLength(MAX_SCRIPT_REQUESTS);
  });

  it('each script has its own allowance; requests from several stages are all listed', async () => {
    const send = `await bru.sendRequest(bru.getEnvVar('baseUrl') + '/echo');`;
    const out = await run(doc({ script: { req: send, res: send }, tests: `${send}\ntest('ok', () => expect(res.status).to.equal(200));` }), opts({ inherited: { collection: settings({ script: { req: send, res: '' } }), folders: [] } }));
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.result.tests.map((t) => t.status)).toEqual(['passed']);
    expect(out.result.scriptRequests?.map((s) => s.stage)).toEqual(['pre-request', 'pre-request', 'post-response', 'tests']);
    expect(out.result.scriptRequests?.map((s) => s.result.runId)).toEqual(['r1.1', 'r1.2', 'r1.3', 'r1.4']);
  });

  it("doesn't run collection or request scripts for the requests a script sends", async () => {
    // The collection's pre-request script would send again if it ran for its own request.
    const collection = settings({ script: { req: `await bru.sendRequest(bru.getEnvVar('baseUrl') + '/echo');`, res: '' }, headers: [{ name: 'X-Collection', value: 'yes', enabled: true }] });
    const out = await run(doc(), opts({ inherited: { collection, folders: [] } }));
    expect(out.result.scriptRequests).toHaveLength(1);
    // Nor collection headers or auth: the script's options are the whole request.
    expect(out.result.scriptRequests?.[0].result.request.headers.map(([k]) => k.toLowerCase())).not.toContain('x-collection');
  });

  it('shares the script time limit and stops the request it is waiting for', async () => {
    const started = Date.now();
    const out = await run(pre(`await bru.sendRequest(bru.getEnvVar('baseUrl') + '/hang');`), opts({ sandbox: quick }));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.result.outcome).toBe('prepare_error');
    expect(out.result.scriptErrors[0].message).toMatch(/timed out after 2000 ms.*waiting for bru\.sendRequest/);
    expect(out.result.scriptRequests?.[0].result.outcome).toBe('cancelled');
  });

  it('cancelling the run stops the script and its request', async () => {
    const ac = new AbortController();
    // Cancels as soon as the script's request arrives, and never answers it.
    const hang = createServer(() => ac.abort());
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}/`;
    const out = await run(pre(`await bru.sendRequest('${url}');`), opts({ signal: ac.signal }));
    hang.closeAllConnections();
    hang.close();
    expect(out.result.outcome).toBe('cancelled');
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.result.scriptRequests?.[0].result.outcome).toBe('cancelled');
  });

  it('a script request uses the request timeout given in its options', async () => {
    const out = await run(pre(`try { await bru.sendRequest({ url: bru.getEnvVar('baseUrl') + '/hang', timeout: 200 }); } catch (e) { bru.setVar('code', e.code); }`), opts());
    expect(out.updates.runtime.code).toBe('ECONNABORTED');
    expect(out.result.scriptRequests?.[0].result.outcome).toBe('timeout');
  });
});

describe('cookies', () => {
  it('uses the run cookie jar: stored cookies reach the request and bru.cookies', async () => {
    const store = new CookieStore(join(dir, 'cookies.json'), { encrypt: (s) => s, decrypt: (s) => s });
    const cookies = store.forRun('C:\\ws\\Sample', 'dev');
    const script = `
      bru.cookies.jar().setCookie(bru.getEnvVar('baseUrl'), 'fromScript', 'one');
      const r = await bru.sendRequest(bru.getEnvVar('baseUrl') + '/cookies/set?sid=abc');
      bru.setVar('sentToLogin', r.headers['set-cookie'].join(' | '));
      const sid = await bru.cookies.jar().getCookie(bru.getEnvVar('baseUrl'), 'sid');
      bru.setVar('sid', sid.value);
    `;
    const out = await run(pre(script, { url: '{{baseUrl}}/cookies/echo' }), opts({ cookies }));
    expect(out.result.scriptErrors).toEqual([]);
    expect(out.updates.runtime).toMatchObject({ sid: 'abc', sentToLogin: 'sid=abc; Path=/' });
    expect(JSON.parse(out.result.body.text).cookies).toEqual({ fromScript: 'one', sid: 'abc' });
    expect(out.result.scriptRequests?.[0].result.cookies).toEqual({ source: 'jar', sent: ['fromScript'], stored: ['sid'] });
  });
});

describe('prepareScriptRequest', () => {
  it('builds form, multipart and basic-auth requests like axios', () => {
    const form = prepareScriptRequest(scriptOptions({ url: 'api.example.test/token', method: 'post', headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: { a: '1 2', b: 3 } }), 'UA');
    expect(form).toMatchObject({ method: 'POST', url: 'http://api.example.test/token', data: 'a=1+2&b=3' });
    const parts = prepareScriptRequest(scriptOptions({ url: 'https://api.example.test/u', headers: { 'Content-Type': 'multipart/form-data' }, data: { name: 'x', tags: ['a', 'b'] } }), 'UA');
    expect(parts.multipart?.map((p) => `${p.name}=${p.value}`)).toEqual(['name=x', 'tags=a', 'tags=b']);
    const basic = prepareScriptRequest(scriptOptions({ url: 'https://api.example.test', auth: { username: 'u', password: 'p' } }), 'UA');
    expect(basic.headers).toEqual({ 'User-Agent': 'UA', Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
    const based = prepareScriptRequest(scriptOptions({ baseURL: 'https://api.example.test/v1/', url: '/items' }), 'UA');
    expect(based.url).toBe('https://api.example.test/v1/items');
    expect(prepareScriptRequest(scriptOptions({ url: 'https://api.example.test', data: 'raw text' }), 'UA').headers).toEqual({ 'User-Agent': 'UA' });
  });

  it('rejects options that are not a request', () => {
    expect(() => scriptOptions(42)).toThrow(ScriptRequestError);
    expect(() => scriptOptions({ url: 'https://api.example.test', headers: 'x' })).toThrow(/headers/);
  });
});
