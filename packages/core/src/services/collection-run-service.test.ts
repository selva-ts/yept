// The collection run service: tree order through the full request pipeline, progress events, the environment chosen
// for the run, folder runs, one run at a time, cancel, and history entries for each request.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixtureServer, CLIENT_SECRET } from '../../../../fixtures/server/server.mjs';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import type { RunnerEvent } from '@yept/core/shared/collection-run';
import type { TreeNode } from '@yept/core/shared/model';
import { CollectionRunService } from './collection-run-service';
import { CookieService } from './cookie-service';
import { EnvService } from './env-service';
import { RunService } from './run-service';
import { SettingsService } from './settings-service';

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

const HANG = `info:
  name: Hang
  type: http
  seq: 1

http:
  method: GET
  url: "{{baseUrl}}/hang"

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: false
`;

let dir: string, identity: IdentityStore, workspace: Workspace, runs: RunService, runner: CollectionRunService, events: RunnerEvent[];
let travel: TreeNode, slow: TreeNode;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yept-collection-run-'));
  const root = join(dir, 'ws');
  // The sample collection, pointed at the fixture server, and a collection whose only request never gets an answer.
  cpSync(join(__dirname, '../../../../fixtures/collections/sample-travel'), join(root, 'travel'), { recursive: true });
  const envFile = join(root, 'travel', 'environments', 'local.yml');
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace('http://localhost:4010', base));
  mkdirSync(join(root, 'slow', 'environments'), { recursive: true });
  writeFileSync(join(root, 'slow', 'opencollection.yml'), 'opencollection: 1.0.0\n\ninfo:\n  name: Slow\n');
  writeFileSync(join(root, 'slow', 'environments', 'local.yml'), `name: local\nvariables:\n  - name: baseUrl\n    value: ${base}\n`);
  writeFileSync(join(root, 'slow', 'Hang.yml'), HANG);
  identity = new IdentityStore(join(dir, 'identity.db'));
  workspace = new Workspace(root, identity, { trash: async () => {} });
  const snapshot = await workspace.load();
  travel = snapshot.collections.find((c) => c.name === 'Sample Travel')!;
  slow = snapshot.collections.find((c) => c.name === 'Slow')!;
  const host = {
    userDataPath: () => dir,
    appVersion: () => '0.0.0-test',
    sandboxWorkerPath: new URL('../engine/sandbox/worker.mjs', import.meta.url),
    cipher: { encrypt: (plain: string) => Buffer.from(plain).toString('base64'), decrypt: (data: string) => Buffer.from(data, 'base64').toString() }
  };
  const env = new EnvService(() => workspace, host);
  env.setSecret(travel.id, 'local', 'clientSecret', CLIENT_SECRET);
  env.setActive(travel.id, 'local');
  const settings = new SettingsService(host);
  runs = new RunService(env, settings, new CookieService(() => workspace, env, settings, host), host);
  events = [];
  runner = new CollectionRunService(() => workspace, runs, (e) => events.push(e));
});
afterEach(async () => {
  await runs.close();
  identity.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const folder = (name: string): TreeNode => travel.children!.find((c) => c.name === name)!;

it('runs the saved requests of a collection in tree order, with the chosen environment, and reports each step', async () => {
  const result = await runner.start('runner-1', travel.id, { environment: 'local', stopOnFailure: false });
  expect(result.ended).toBe('completed');
  expect(result.steps.map((s) => `${s.folder} | ${s.name} ${s.status} ${s.httpStatus}`)).toEqual(['Auth | Login passed 200', 'Bookings | List bookings passed 200']);
  expect(result.summary).toMatchObject({ total: 2, passed: 2, failed: 0, errors: 0 });
  expect(result.summary.tests.passed).toBeGreaterThanOrEqual(4);
  // A start and an end per step, in order, all for this run.
  expect(events.map((e) => `${e.type} ${e.index}`)).toEqual(['step-start 0', 'step-end 0', 'step-start 1', 'step-end 1']);
  expect(events.every((e) => e.runnerId === 'runner-1')).toBe(true);
  const start = events[0] as Extract<RunnerEvent, { type: 'step-start' }>;
  expect(start).toMatchObject({ collectionId: travel.id, environment: 'local', url: '{{baseUrl}}/auth/token' });
  expect(start.step.status).toBe('running');
  const end = events[3] as Extract<RunnerEvent, { type: 'step-end' }>;
  expect(end.result?.status).toBe(200);
  expect(end.step.runId).toBe(result.steps[1].runId);
  // Each request is in its history, under its own run id.
  for (const step of result.steps) expect(runs.history.get(step.runId)?.summary.requestId).toBe(step.requestId);
});

it('uses the environment chosen for the run, not the active one', async () => {
  const result = await runner.start('runner-2', travel.id, { environment: null, stopOnFailure: false });
  // Without an environment there is no base URL, so nothing is sent.
  expect(result.steps.map((s) => s.status)).toEqual(['error', 'error']);
  expect(result.steps[0].reason).toMatch(/^Not sent/);
  expect(events.filter((e) => e.type === 'step-start').every((e) => e.type === 'step-start' && e.environment === '')).toBe(true);
});

it('stops after the first failure when asked', async () => {
  const result = await runner.start('runner-3', travel.id, { environment: null, stopOnFailure: true });
  expect(result.ended).toBe('stopped');
  expect(result.steps.map((s) => s.status)).toEqual(['error', 'skipped']);
});

it('runs only the requests under a folder', async () => {
  const result = await runner.start('runner-4', folder('Bookings').id, { environment: 'local', stopOnFailure: false });
  expect(result.steps.map((s) => `${s.folder}|${s.name}`)).toEqual(['|List bookings']);
  // Without the login before it, the token variable is unresolved, so the request is not sent.
  expect(result.steps[0].status).toBe('error');
  expect(result.steps[0].reason).toMatch(/^Not sent: .*accessToken/);
});

it('refuses requests, unknown nodes and unknown environments', async () => {
  const request = folder('Auth').children![0];
  await expect(runner.start('r', request.id, { environment: null, stopOnFailure: false })).rejects.toThrow(/no longer exists/);
  await expect(runner.start('r', 'not-a-node', { environment: null, stopOnFailure: false })).rejects.toThrow(/no longer exists/);
  await expect(runner.start('r', travel.id, { environment: 'nowhere', stopOnFailure: false })).rejects.toThrow('Environment not found: nowhere');
  expect(events).toEqual([]);
});

it('runs one collection at a time and cancels the run going on', async () => {
  const running = runner.start('runner-5', slow.id, { environment: 'local', stopOnFailure: false });
  await vi.waitFor(() => expect(events.some((e) => e.type === 'step-start')).toBe(true));
  await expect(runner.start('runner-6', travel.id, { environment: 'local', stopOnFailure: false })).rejects.toThrow(/already going on/);
  // Another run's id cancels nothing.
  runner.cancel('runner-6');
  await new Promise((r) => setTimeout(r, 50));
  expect(events.some((e) => e.type === 'step-end')).toBe(false);
  runner.cancel('runner-5');
  const result = await running;
  expect(result.ended).toBe('cancelled');
  expect(result.steps.map((s) => s.status)).toEqual(['cancelled']);
  // The next run can start once this one has ended.
  const next = await runner.start('runner-7', folder('Auth').id, { environment: 'local', stopOnFailure: false });
  expect(next.steps.map((s) => s.status)).toEqual(['passed']);
});
