// The collection runner loop: order, stop at a failure or carry on, cancel, and a real run through the request
// pipeline against the fixture server (login → create → read → delete, variables carried from step to step).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixtureServer, CLIENT_ID, CLIENT_SECRET } from '../../../../../fixtures/server/server.mjs';
import { emptyAuth, type AuthConfig, type RequestDoc, type RunResult } from '../../shared/model';
import type { RunnerPlanItem } from '../../shared/collection-run';
import { SandboxHost } from '../sandbox/host';
import { emptyEnvLayer, type VarLayers } from '../env/variables';
import { runSequence } from './collection-runner';
import { run } from './runner';

const item = (name: string): RunnerPlanItem => ({ requestId: `id:${name}`, name, method: 'GET', folder: '' });
const plan = ['A', 'B', 'C', 'D'].map(item);
const result = (over: Partial<RunResult> = {}): RunResult => ({
  runId: 'r', outcome: 'http', status: 200, durationMs: 1, sizeBytes: 0, headers: [],
  body: { text: '', contentType: '', truncated: false, binary: false },
  request: { method: 'GET', url: 'https://api.example.test/', headers: [] },
  timeline: [], environment: '', scriptErrors: [], extractions: [], console: [], tests: [], testsState: 'none',
  ...over
});
const ids = (): (() => string) => {
  let n = 0;
  return () => `run-${++n}`;
};

describe('runSequence', () => {
  it('runs every request in plan order, one at a time, with its own run id', async () => {
    const order: string[] = [];
    let inFlight = 0;
    const events: string[] = [];
    const r = await runSequence(plan, {
      stopOnFailure: false,
      newRunId: ids(),
      runStep: async (p, runId) => {
        expect(++inFlight).toBe(1);
        order.push(`${p.name}:${runId}`);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return result({ runId });
      },
      onStepStart: (i, s) => events.push(`start ${i} ${s.status}`),
      onStepEnd: (i, s) => events.push(`end ${i} ${s.status}`)
    });
    expect(order).toEqual(['A:run-1', 'B:run-2', 'C:run-3', 'D:run-4']);
    expect(events).toEqual(['start 0 running', 'end 0 no-tests', 'start 1 running', 'end 1 no-tests', 'start 2 running', 'end 2 no-tests', 'start 3 running', 'end 3 no-tests']);
    expect(r.ended).toBe('completed');
    expect(r.steps.map((s) => s.runId)).toEqual(['run-1', 'run-2', 'run-3', 'run-4']);
  });

  const failing = (p: RunnerPlanItem, runId: string): Promise<RunResult> =>
    Promise.resolve(p.name === 'B' ? result({ runId, testsState: 'ran', tests: [{ name: 'ok', kind: 'test', status: 'failed', source: 'request' }] }) : result({ runId }));

  it('carries on after a failure by default', async () => {
    const r = await runSequence(plan, { stopOnFailure: false, newRunId: ids(), runStep: failing });
    expect(r.steps.map((s) => s.status)).toEqual(['no-tests', 'failed', 'no-tests', 'no-tests']);
    expect(r.ended).toBe('completed');
  });

  it('stops after the first failure when asked, and marks the rest as not run', async () => {
    const sent: string[] = [];
    const r = await runSequence(plan, { stopOnFailure: true, newRunId: ids(), runStep: (p, id) => { sent.push(p.name); return failing(p, id); } });
    expect(sent).toEqual(['A', 'B']);
    expect(r.ended).toBe('stopped');
    expect(r.steps.map((s) => s.status)).toEqual(['no-tests', 'failed', 'skipped', 'skipped']);
    expect(r.steps[2].reason).toBe('Not run: stopped after "B" failed');
    expect(r.summary).toMatchObject({ total: 4, failed: 1, skipped: 2, noTests: 1, tests: { passed: 0, failed: 1, errors: 0 } });
  });

  it('counts a request error as a failure for stopping, and a step that throws as an error', async () => {
    const r = await runSequence(plan, {
      stopOnFailure: true,
      newRunId: ids(),
      runStep: async (p) => {
        if (p.name === 'B') throw new Error('Request file not found');
        return result();
      }
    });
    expect(r.steps.map((s) => s.status)).toEqual(['no-tests', 'error', 'skipped', 'skipped']);
    expect(r.steps[1].reason).toBe('Request file not found');
    expect(r.summary.errors).toBe(1);

    const network = await runSequence(plan, { stopOnFailure: true, newRunId: ids(), runStep: async () => result({ outcome: 'network', status: undefined, error: { message: 'ECONNREFUSED' } }) });
    expect(network.steps.map((s) => s.status)).toEqual(['error', 'skipped', 'skipped', 'skipped']);
  });

  it('a failure in the last request is not reported as stopped', async () => {
    const r = await runSequence([item('A'), item('B')], { stopOnFailure: true, newRunId: ids(), runStep: failing });
    expect(r.ended).toBe('completed');
  });

  it('cancel stops the request in flight and skips the rest', async () => {
    const ac = new AbortController();
    const sent: string[] = [];
    const r = await runSequence(plan, {
      stopOnFailure: false,
      signal: ac.signal,
      newRunId: ids(),
      runStep: (p, runId) => {
        sent.push(p.name);
        if (p.name !== 'B') return Promise.resolve(result({ runId }));
        // The request sees the cancel through the same signal and ends as cancelled.
        return new Promise((resolve) => {
          ac.signal.addEventListener('abort', () => resolve(result({ runId, outcome: 'cancelled', status: undefined, error: { message: 'Cancelled' } })));
          setTimeout(() => ac.abort(), 10);
        });
      }
    });
    expect(sent).toEqual(['A', 'B']);
    expect(r.ended).toBe('cancelled');
    expect(r.steps.map((s) => s.status)).toEqual(['no-tests', 'cancelled', 'skipped', 'skipped']);
    expect(r.steps[3].reason).toBe('Not run: the run was cancelled');
    expect(r.summary).toMatchObject({ cancelled: 1, skipped: 2 });
  });

  it('cancel between requests sends nothing more', async () => {
    const ac = new AbortController();
    const sent: string[] = [];
    const r = await runSequence(plan, {
      stopOnFailure: false,
      signal: ac.signal,
      newRunId: ids(),
      runStep: async (p) => {
        sent.push(p.name);
        if (p.name === 'A') ac.abort();
        return result();
      }
    });
    expect(sent).toEqual(['A']);
    expect(r.ended).toBe('cancelled');
    expect(r.steps.map((s) => s.status)).toEqual(['no-tests', 'skipped', 'skipped', 'skipped']);
  });

  it('a step that throws after cancel is cancelled, not an error', async () => {
    const ac = new AbortController();
    const r = await runSequence([item('A'), item('B')], {
      stopOnFailure: false,
      signal: ac.signal,
      newRunId: ids(),
      runStep: async () => {
        ac.abort();
        throw new Error('aborted');
      }
    });
    expect(r.steps.map((s) => s.status)).toEqual(['cancelled', 'skipped']);
  });
});

describe('runSequence through the request pipeline', () => {
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

  const noAuth: AuthConfig = { ...emptyAuth(), mode: 'none' };
  const bearer: AuthConfig = { ...noAuth, mode: 'bearer', bearer: { token: '{{accessToken}}' } };
  const doc = (over: Partial<RequestDoc>): RequestDoc => ({
    name: 't', method: 'GET', url: '', params: [], headers: [],
    body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
    auth: noAuth, vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
    settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
    ...over
  });
  const docs: Record<string, RequestDoc> = {
    // The login is sent by a script (bru.sendRequest); the request itself checks the token works.
    Login: doc({
      url: '{{baseUrl}}/bookings',
      auth: bearer,
      script: {
        req: `const r = await bru.sendRequest({ method: "POST", url: bru.getEnvVar("baseUrl") + "/auth/token", headers: { "Content-Type": "application/x-www-form-urlencoded" }, data: { grant_type: "client_credentials", client_id: "${CLIENT_ID}", client_secret: bru.getEnvVar("clientSecret") } });
bru.setVar("accessToken", r.data.access_token);`,
        res: ''
      },
      tests: 'test("logged in", () => expect(res.status).to.equal(200));'
    }),
    Create: doc({
      method: 'POST',
      url: '{{baseUrl}}/bookings',
      auth: bearer,
      body: { mode: 'json', json: '{"traveller":"Alex Example","destination":"Porto"}', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
      vars: { req: [], res: [{ name: 'bookingId', value: 'res.body.id', enabled: true }] },
      tests: 'test("created", () => expect(res.status).to.equal(201));'
    }),
    Read: doc({ url: '{{baseUrl}}/bookings/{{bookingId}}', auth: bearer, tests: 'test("found", () => expect(res.body.destination).to.equal("Porto"));' }),
    Delete: doc({ method: 'DELETE', url: '{{baseUrl}}/bookings/{{bookingId}}', auth: bearer }),
    'Read deleted': doc({ url: '{{baseUrl}}/bookings/{{bookingId}}', auth: bearer, tests: 'test("gone", () => expect(res.status).to.equal(404));' }),
    Hang: doc({ url: '{{baseUrl}}/hang' })
  };

  /** Like RunService.start for a run without an environment: runtime values carried from one request to the next. */
  const pipeline = (signal?: AbortSignal) => {
    let runtime: Record<string, string> = {};
    return async (p: RunnerPlanItem, runId: string): Promise<RunResult> => {
      const layers: VarLayers = { collection: [], environment: { ...emptyEnvLayer(), file: { baseUrl: base }, secrets: { clientSecret: CLIENT_SECRET } }, folders: [], request: [], runtime: { ...runtime } };
      const out = await run(docs[p.name], { runId, sandbox, layers, environment: 'dev', secretNames: ['clientSecret'], defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, signal });
      runtime = out.updates.runtime;
      return out.result;
    };
  };

  it('login → create → read → delete, each request using what the ones before it set', async () => {
    const order = ['Login', 'Create', 'Read', 'Delete', 'Read deleted'].map(item);
    const r = await runSequence(order, { stopOnFailure: true, newRunId: ids(), runStep: pipeline() });
    expect(r.steps.map((s) => `${s.name} ${s.status} ${s.httpStatus}`)).toEqual([
      'Login passed 200',
      'Create passed 201',
      'Read passed 200',
      'Delete no-tests 204',
      'Read deleted passed 404'
    ]);
    expect(r.ended).toBe('completed');
    // Five steps: the login the script sent is inside the first step's result, not a step of its own.
    expect(r.summary).toMatchObject({ total: 5, passed: 4, noTests: 1, tests: { passed: 4, failed: 0, errors: 0 } });
  });

  it('stops at a failed step when asked: without the login the rest is not sent', async () => {
    const order = ['Read', 'Create', 'Delete'].map(item);
    const r = await runSequence(order, { stopOnFailure: true, newRunId: ids(), runStep: pipeline() });
    expect(r.steps.map((s) => s.status)).toEqual(['error', 'skipped', 'skipped']);
    expect(r.steps[0].reason).toMatch(/^Not sent: Unresolved variables?: .*accessToken/);
  });

  it('cancel aborts the request in flight', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const r = await runSequence(['Hang', 'Login'].map(item), { stopOnFailure: false, signal: ac.signal, newRunId: ids(), runStep: pipeline(ac.signal) });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.steps.map((s) => s.status)).toEqual(['cancelled', 'skipped']);
    expect(r.ended).toBe('cancelled');
  });
});
