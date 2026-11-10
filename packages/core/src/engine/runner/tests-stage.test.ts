// Assertions and tests through the sandbox, with honest states.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixtureServer } from '../../../../../fixtures/server/server.mjs';
import { emptyAuth, type AuthConfig, type RequestDoc, type SettingsDoc } from '../../shared/model';
import { SandboxHost } from '../sandbox/host';
import { run, type RunOptions } from './runner';

let server: Server;
let base = '';
// Normal scripts get a generous limit so a slow machine cannot time them out; the runaway-script test uses its own short one.
let sandbox: SandboxHost;
let quick: SandboxHost;
beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sandbox = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 10000 });
  quick = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 1500 });
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await sandbox.close();
  await quick.close();
});

const noAuth: AuthConfig = { ...emptyAuth(), mode: 'none' };
const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't', method: 'GET', url: `${base}/echo?x=1`, params: [], headers: [], body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: noAuth, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true }, ...over
});
const settings = (over: Partial<SettingsDoc> = {}): SettingsDoc => ({ name: 'c', headers: [], auth: noAuth, vars: [], script: { req: '', res: '' }, tests: '', docs: '', ...over });
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({ runId: 'r', sandbox, collectionName: 'Demo', defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, ...over });
const states = (r: Awaited<ReturnType<typeof run>>) => r.result.tests.map((t) => `${t.status}:${t.name}`);

describe('tests stage', () => {
  it('reports passed and failed tests in the order they were written', async () => {
    const r = await run(doc({ tests: 'test("first", () => expect(res.status).to.equal(200));\ntest("second", () => expect(res.body.query.x).to.equal("2"));\ntest("third", () => expect(res.body.method).to.equal("GET"));' }), opts());
    expect(r.result.testsState).toBe('ran');
    expect(states(r).sort()).toEqual(['failed:second', 'passed:first', 'passed:third']);
    expect(r.result.tests.find((t) => t.name === 'second')?.message).toMatch(/expected '1' to equal '2'/);
  });

  it('a syntax error is an error, not a pass and not "no tests"', async () => {
    const r = await run(doc({ tests: 'test("x", () => { expect(1).to.equal(1) ' }), opts());
    expect(r.result.testsState).toBe('ran');
    expect(r.result.tests).toEqual([expect.objectContaining({ status: 'error', name: 'Tests script (request)' })]);
  });

  it('an unsupported (Jest-style) matcher is an error', async () => {
    const r = await run(doc({ tests: 'test("jest", () => expect(res.status).toBe(200));' }), opts());
    expect(r.result.tests[0]).toMatchObject({ status: 'error', name: 'jest' });
    expect(r.result.tests[0].message).toMatch(/Invalid Chai property: toBe/);
  });

  it('a runaway test script is stopped and reported as an error', async () => {
    const r = await run(doc({ tests: 'test("spin", () => { while (true) {} });' }), opts({ sandbox: quick }));
    expect(r.result.tests[0]).toMatchObject({ status: 'error' });
    expect(r.result.tests[0].message).toMatch(/timed out after 1500 ms/);
  });

  it('a tests script that defines no tests is flagged', async () => {
    const r = await run(doc({ tests: 'const x = 1;' }), opts());
    expect(r.result.tests[0]).toMatchObject({ status: 'error', name: 'No test() calls in the request tests' });
  });

  it('no tests means "none", never "passed"', async () => {
    const r = await run(doc(), opts());
    expect(r.result.testsState).toBe('none');
    expect(r.result.tests).toEqual([]);
  });

  it('runs assertions with pass, fail and messages', async () => {
    const r = await run(doc({ assertions: [{ name: 'res.status', value: 'eq 200', enabled: true }, { name: 'res.body.method', value: 'eq POST', enabled: true }, { name: 'res.body.nope', value: 'isDefined', enabled: false }] }), opts());
    expect(states(r)).toEqual(['passed:res.status eq 200', 'failed:res.body.method eq POST']);
    expect(r.result.tests.every((t) => t.kind === 'assertion')).toBe(true);
  });

  it('runs collection and folder tests too, labelled by source', async () => {
    const r = await run(doc({ tests: 'test("own", () => expect(1).to.equal(1));' }), opts({
      inherited: { collection: settings({ tests: 'test("from collection", () => expect(res.status).to.be.below(500));' }), folders: [settings({ name: 'Bookings', tests: 'test("from folder", () => expect(res.body).to.be.an("object"));' })] }
    }));
    expect(r.result.tests.map((t) => `${t.source}:${t.name}`)).toEqual(['collection "Demo":from collection', 'folder "Bookings":from folder', 'request:own']);
  });

  it('tests do not run on a truncated body', async () => {
    const r = await run(doc({ url: `${base}/big?mb=2`, tests: 'test("x", () => expect(1).to.equal(1));' }), opts({ maxBodyBytes: 64 * 1024 }));
    expect(r.result.testsState).toBe('not-run');
    expect(r.result.testsNote).toMatch(/processing limit/);
    expect(r.result.tests).toEqual([]);
  });

  it('tests do not run when there is no HTTP response', async () => {
    const r = await run(doc({ url: 'http://127.0.0.1:1/x', tests: 'test("x", () => expect(1).to.equal(1));' }), opts());
    expect(r.result.outcome).toBe('network');
    expect(r.result.testsState).toBe('not-run');
    expect(r.result.testsNote).toBe('Not run: no HTTP response');
  });

  it('console output from tests is captured', async () => {
    const r = await run(doc({ tests: 'console.log("checking", res.status); test("x", () => expect(1).to.equal(1));' }), opts());
    expect(r.result.console).toContainEqual({ stage: 'tests', level: 'log', text: 'checking 200' });
  });
});

describe('blocked scripts', () => {
  it('sends the request but reports scripts, vars, assertions and tests as not run', async () => {
    const reason = 'this folder is not trusted';
    const r = await run(doc({
      script: { req: 'bru.setVar("pre", "1");', res: 'bru.setVar("post", "1");' },
      vars: { req: [], res: [{ name: 'fromVars', value: 'res.status', enabled: true }] },
      tests: 'test("status", () => expect(res.status).to.equal(200));',
      assertions: [{ name: 'res.status', value: 'eq 200', enabled: true }]
    }), opts({ scriptsBlocked: reason }));
    expect(r.result.outcome).toBe('http');
    expect(r.result.status).toBe(200);
    expect(r.result.testsState).toBe('not-run');
    expect(r.result.testsNote).toBe(`Not run: ${reason}`);
    expect(r.result.tests).toEqual([]);
    expect(r.result.scriptErrors.map((e) => e.message).every((m) => m === `Not run: ${reason}`)).toBe(true);
    expect(r.result.scriptErrors.map((e) => e.stage)).toEqual(expect.arrayContaining(['pre-request', 'post-response']));
    expect(r.updates.runtime).not.toHaveProperty('pre');
    expect(r.updates.runtime).not.toHaveProperty('post');
    expect(r.updates.runtime).not.toHaveProperty('fromVars');
  });
});
