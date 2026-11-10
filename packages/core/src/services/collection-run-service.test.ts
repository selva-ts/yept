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
import type { AppHost } from './host';
import { CookieService } from './cookie-service';
import { EnvService } from './env-service';
import { RunService, withoutData } from './run-service';
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

// A request file: GET of a URL, with an optional tests script.
const getFile = (name: string, seq: number, url: string, tests = ''): string => `info:
  name: ${name}
  type: http
  seq: ${seq}

http:
  method: GET
  url: "${url}"
${tests ? `
runtime:
  scripts:
    - type: tests
      code: |-
        ${tests}
` : ''}
settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: false
`;
const API_KEY = 'synthetic-api-key-123';

let dir: string, identity: IdentityStore, workspace: Workspace, runs: RunService, runner: CollectionRunService, events: RunnerEvent[];
let travel: TreeNode, slow: TreeNode, data: TreeNode;
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
  // A collection for data files: environment values the rows override, and a secret that a test puts in its name.
  mkdirSync(join(root, 'data', 'environments'), { recursive: true });
  writeFileSync(join(root, 'data', 'opencollection.yml'), 'opencollection: 1.0.0\n\ninfo:\n  name: Data\n');
  writeFileSync(join(root, 'data', 'environments', 'local.yml'), `name: local\nvariables:\n  - name: baseUrl\n    value: ${base}\n  - name: name\n    value: from-env\n  - name: city\n    value: env-city\n  - secret: true\n    name: apiKey\n`);
  writeFileSync(join(root, 'data', 'Who.yml'), getFile('Who', 1, '{{baseUrl}}/echo?name={{name}}&city={{city}}'));
  writeFileSync(join(root, 'data', 'Key.yml'), getFile('Key', 2, '{{baseUrl}}/echo?key={{apiKey}}', 'test("key is " + res.body.query.key, function () { expect(res.body.query.key).to.equal("nope"); });'));
  identity = new IdentityStore(join(dir, 'identity.db'));
  workspace = new Workspace(root, identity, { trash: async () => {} });
  const snapshot = await workspace.load();
  travel = snapshot.collections.find((c) => c.name === 'Sample Travel')!;
  slow = snapshot.collections.find((c) => c.name === 'Slow')!;
  data = snapshot.collections.find((c) => c.name === 'Data')!;
  const host = {
    userDataPath: () => dir,
    appVersion: () => '0.0.0-test',
    sandboxWorkerPath: new URL('../engine/sandbox/worker.mjs', import.meta.url),
    cipher: { encrypt: (plain: string) => Buffer.from(plain).toString('base64'), decrypt: (data: string) => Buffer.from(data, 'base64').toString() }
  };
  const env = new EnvService(() => workspace, host);
  env.setSecret(travel.id, 'local', 'clientSecret', CLIENT_SECRET);
  env.setSecret(data.id, 'local', 'apiKey', API_KEY);
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

// ---------- data files, iterations, delay and reports ----------

/** Dialogs that pick the given file and save to the given path. */
const dialogs = (open: string | null, save: string | null): Pick<AppHost, 'openDialog' | 'saveDialog'> => ({
  openDialog: async () => (open ? { canceled: false, filePaths: [open] } : { canceled: true, filePaths: [] }),
  saveDialog: async () => (save ? { canceled: false, filePath: save } : { canceled: true })
});
const sentUrls = (): string[] => events.flatMap((e) => (e.type === 'step-end' && e.result ? [e.result.request.url] : []));

it('runs once per data file row, the row values over environment values for that iteration only', async () => {
  const csv = join(dir, 'people.csv');
  writeFileSync(csv, '﻿name,city\r\nAsha,"Chennai, TN"\r\nRavi,\r\n"Meera ""M""",Pune\r\n');
  const withData = new CollectionRunService(() => workspace, runs, (e) => events.push(e), dialogs(csv, null));
  const info = await withData.pickDataFile();
  expect(info).toEqual({ path: csv, name: 'people.csv', format: 'csv', rows: 3, columns: ['name', 'city'] });
  const result = await withData.start('runner-data', data.id, { environment: 'local', stopOnFailure: false, dataFile: csv });
  expect(result.iterations).toBe(3);
  expect(result.steps.map((s) => `${s.iteration} ${s.name}`)).toEqual(['1 Who', '1 Key', '2 Who', '2 Key', '3 Who', '3 Key']);
  const who = sentUrls().filter((u) => u.startsWith(`${base}/echo?name=`));
  expect(who.map((u) => Object.fromEntries(new URL(u).searchParams))).toEqual([{ name: 'Asha', city: 'Chennai, TN' }, { name: 'Meera "M"', city: 'Pune' }]);
  // An empty cell is an empty value, which is unresolved as in an environment: that request is not sent.
  expect(result.steps[2]).toMatchObject({ iteration: 2, status: 'error', reason: 'Not sent: Unresolved variable: city' });
  // Afterwards the environment's own values are back: nothing from the file stays in its runtime variables.
  events = [];
  const after = await withData.start('runner-after', data.id, { environment: 'local', stopOnFailure: false });
  expect(after.iterations).toBe(1);
  expect(sentUrls()[0]).toBe(`${base}/echo?name=from-env&city=env-city`);
});

it('takes a row back out of the runtime variables unless a script changed it', () => {
  const before = { token: 'abc', name: 'old' };
  // name and city came from the row; a script changed city; token was set by a script earlier.
  expect(withoutData({ token: 'abc', name: 'Asha', city: 'set-by-script', extra: '1' }, { name: 'Asha', city: 'Chennai' }, before))
    .toEqual({ token: 'abc', name: 'old', city: 'set-by-script', extra: '1' });
  expect(withoutData({ name: 'Asha' }, { name: 'Asha' }, {})).toEqual({});
});

it('reads only data files chosen in its dialog, and reads them again when a run starts', async () => {
  const json = join(dir, 'rows.json');
  writeFileSync(json, '[{ "name": "One" }]');
  await expect(runner.start('r', data.id, { environment: 'local', stopOnFailure: false, dataFile: json })).rejects.toThrow('Choose the data file again.');
  const withData = new CollectionRunService(() => workspace, runs, (e) => events.push(e), dialogs(json, null));
  expect((await withData.pickDataFile())?.rows).toBe(1);
  writeFileSync(json, '[{ "name": "One" }, { "name": "Two" }]');
  const result = await withData.start('runner-json', data.id, { environment: 'local', stopOnFailure: false, dataFile: json });
  expect(result.iterations).toBe(2);
  // A file that has become unusable stops the run before anything is sent.
  writeFileSync(json, '{ "name": "One" }');
  events = [];
  await expect(withData.start('runner-bad', data.id, { environment: 'local', stopOnFailure: false, dataFile: json })).rejects.toThrow(/array of objects/);
  expect(events).toEqual([]);
  // A cancelled dialog, and a file that can't be used.
  expect(await new CollectionRunService(() => workspace, runs, () => {}, dialogs(null, null)).pickDataFile()).toBeNull();
  const bad = join(dir, 'bad.csv');
  writeFileSync(bad, 'a,a\n1,2\n');
  await expect(new CollectionRunService(() => workspace, runs, () => {}, dialogs(bad, null)).pickDataFile()).rejects.toThrow('named twice');
});

it('repeats the plan without a data file and waits between requests', async () => {
  const t0 = Date.now();
  const result = await runner.start('runner-repeat', data.id, { environment: 'local', stopOnFailure: false, iterations: 2, delayMs: 60 });
  expect(result.steps.map((s) => `${s.iteration} ${s.name}`)).toEqual(['1 Who', '1 Key', '2 Who', '2 Key']);
  // Three waits between four requests.
  expect(Date.now() - t0).toBeGreaterThanOrEqual(170);
});

it('cancel during the wait between requests ends the run at once', async () => {
  const running = runner.start('runner-wait', data.id, { environment: 'local', stopOnFailure: false, iterations: 5, delayMs: 30_000 });
  await vi.waitFor(() => expect(events.some((e) => e.type === 'step-end')).toBe(true));
  const t0 = Date.now();
  runner.cancel('runner-wait');
  const result = await running;
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(result.ended).toBe('cancelled');
  expect(result.steps.filter((s) => s.status === 'skipped')).toHaveLength(9);
});

it('exports JUnit and HTML reports with secrets and credential headers redacted', async () => {
  const xmlPath = join(dir, 'results.xml');
  const htmlPath = join(dir, 'report.html');
  let save = xmlPath;
  const reporting = new CollectionRunService(() => workspace, runs, (e) => events.push(e), { ...dialogs(null, null), saveDialog: async () => ({ canceled: false, filePath: save }) });
  await expect(reporting.exportReport('nothing-yet', 'junit')).rejects.toThrow(/no longer available/);
  await reporting.start('runner-travel', travel.id, { environment: 'local', stopOnFailure: false });
  const login = events.find((e) => e.type === 'step-end' && e.step.name === 'Login') as Extract<RunnerEvent, { type: 'step-end' }>;
  const token = JSON.parse(login.result!.body.text).access_token as string;
  expect(token.length).toBeGreaterThan(8);
  await reporting.start('runner-key', data.id, { environment: 'local', stopOnFailure: false, iterations: 2 });

  expect(await reporting.exportReport('runner-travel', 'junit')).toBe(xmlPath);
  save = htmlPath;
  expect(await reporting.exportReport('runner-travel', 'html')).toBe(htmlPath);
  for (const text of [readFileSync(xmlPath, 'utf8'), readFileSync(htmlPath, 'utf8')]) {
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(Buffer.from(`sample-client:${CLIENT_SECRET}`).toString('base64'));
    expect(text).not.toContain(token);
    expect(text).toContain('status is 200');
  }
  expect(readFileSync(htmlPath, 'utf8')).toContain('«redacted»');
  // A secret in a URL and in a test's name and message is masked as history masks it.
  save = xmlPath;
  await reporting.exportReport('runner-key', 'junit');
  save = htmlPath;
  await reporting.exportReport('runner-key', 'html');
  for (const text of [readFileSync(xmlPath, 'utf8'), readFileSync(htmlPath, 'utf8')]) {
    expect(text).not.toContain(API_KEY);
    expect(text).toContain('«secret:apiKey»');
    expect(text).toMatch(/iteration 2/i);
  }
  // The live results the page gets are not what the report is built from.
  expect(events.some((e) => e.type === 'step-end' && !!e.result?.tests.some((t) => t.name.includes(API_KEY)))).toBe(true);
  // A cancelled save dialog writes nothing.
  const quiet = new CollectionRunService(() => workspace, runs, () => {}, dialogs(null, null));
  await quiet.start('runner-quiet', data.id, { environment: 'local', stopOnFailure: false });
  expect(await quiet.exportReport('runner-quiet', 'html')).toBeNull();
});
