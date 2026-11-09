import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import { CollectionRunService } from '@yept/core/services/collection-run-service';
import { CookieService } from '@yept/core/services/cookie-service';
import { EnvService } from '@yept/core/services/env-service';
import { RunService } from '@yept/core/services/run-service';
import { SettingsService } from '@yept/core/services/settings-service';
import type { RunnerResult } from '@yept/core/shared/collection-run';
import type { TreeNode } from '@yept/core/shared/model';
import type { TestApi } from '../../src/extension';
import type { TreeItem } from '../../src/collections';

// The collection runner panel and the Dev Tools view in the real extension. The workspace is this suite's own copy of
// every sample collection under fixtures/, pointed at the local fixture server, plus a collection whose only request
// never gets an answer (for cancel).

async function until(condition: () => boolean | Promise<boolean>, what: string, tries = 150): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

/** What both sides must agree on: everything but run ids and timings. */
const comparable = (r: RunnerResult) => ({
  ended: r.ended,
  summary: r.summary,
  steps: r.steps.map((s) => ({
    name: s.name, folder: s.folder, method: s.method, status: s.status, reason: s.reason, httpStatus: s.httpStatus, tests: s.tests,
    testResults: s.testResults.map((t) => ({ name: t.name, kind: t.kind, status: t.status, message: t.message }))
  }))
});

// The one environment each sample collection has.
const ENVIRONMENTS: Record<string, string> = { 'Sample Travel': 'local', 'Sample ASP.NET API': 'local', DummyJSON: 'public' };
const CLIENT_SECRET = 'sample-secret';

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'The tests need a workspace folder');
  let api: TestApi | undefined;
  const service = () => {
    const found = api && [...api.services.entries()].find(([path]) => resolve(path).toLowerCase() === resolve(root).toLowerCase())?.[1];
    assert.ok(found, 'No services for the workspace folder');
    return found;
  };
  const invoke = (channel: string, ...args: unknown[]) => service().handlers.invoke(channel, ...args) as Promise<any>;
  const collections = (): TreeNode[] => api!.collections.snapshots()[0].collections;
  const collection = (name: string): TreeNode => {
    const found = collections().find((c) => c.name === name);
    assert.ok(found, `Missing collection ${name}`);
    return found;
  };
  const treeItem = (kind: string, name: string): TreeItem => {
    const find = (items: TreeItem[]): TreeItem | undefined => {
      for (const item of items) {
        if (item.kind === kind && item.name === name) return item;
        const child = find(api!.collections.getChildren(item));
        if (child) return child;
      }
      return undefined;
    };
    const found = find(api!.collections.getChildren());
    assert.ok(found, `Missing ${kind} ${name} in the tree`);
    return found;
  };
  const shown = () => api!.devtools().shown;

  // The same run straight through core, on the same files, with its own local data.
  const coreData = await mkdtemp(join(tmpdir(), 'yept-runner-core-'));
  const identity = new IdentityStore(join(coreData, 'identity.db'));
  const coreWorkspace = new Workspace(root, identity, { trash: async () => {} });
  const coreHost = {
    userDataPath: () => coreData,
    appVersion: () => String(vscode.extensions.all.find((e) => e.id === 'yept.yept-vscode')?.packageJSON.version ?? '0.9.0'),
    sandboxWorkerPath: resolve(__dirname, '../../../dist/worker.cjs'),
    cipher: { encrypt: (plain: string) => Buffer.from(plain).toString('base64'), decrypt: (data: string) => Buffer.from(data, 'base64').toString() }
  };
  const coreEnv = new EnvService(() => coreWorkspace, coreHost);
  const coreSettings = new SettingsService(coreHost);
  const coreRuns = new RunService(coreEnv, coreSettings, new CookieService(() => coreWorkspace, coreEnv, coreSettings, coreHost), coreHost);
  const core = new CollectionRunService(() => coreWorkspace, coreRuns, () => {});
  const coreCollection = (name: string): TreeNode => coreWorkspace.snapshot().collections.find((c) => c.name === name)!;

  let networkBefore = 0;
  const checks: [string, () => Promise<void>][] = [
    ['activates and resolves the Dev Tools view', async () => {
      const extension = vscode.extensions.all.find((e) => resolve(e.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
      assert.ok(extension, 'Development extension was not loaded');
      api = await extension.activate() as TestApi | undefined;
      assert.ok(api);
      await api.ready;
      assert.deepEqual(collections().map((c) => c.name).sort(), ['DummyJSON', 'Sample ASP.NET API', 'Sample Travel', 'Slow']);
      assert.equal(api.devtools().resolved, false);
      await vscode.commands.executeCommand('yept.showDevTools');
      await until(() => api!.devtools().ready && !!shown(), 'the Dev Tools page to load');
      assert.deepEqual(shown(), { runs: 0, lines: 0 });
      await coreWorkspace.load();
    }],
    ['Run Collection opens the runner panel with the collection planned', async () => {
      await vscode.commands.executeCommand('yept.runCollection', treeItem('collection', 'Sample Travel'));
      await until(() => api!.runner()?.state?.target?.name === 'Sample Travel', 'the runner page to show the collection');
      const runner = api!.runner()!;
      assert.equal(runner.state!.target!.kind, 'collection');
      assert.equal(runner.state!.planned, 2);
      assert.equal(runner.state!.run, null);
      assert.equal(runner.panel.title, 'Run Sample Travel');
    }],
    ['Run Folder shows the folder in the same panel', async () => {
      const panel = api!.runner()!.panel;
      await vscode.commands.executeCommand('yept.runFolder', treeItem('folder', 'Bookings'));
      await until(() => api!.runner()?.state?.target?.name === 'Bookings', 'the runner page to show the folder');
      assert.equal(api!.runner()!.panel, panel);
      assert.equal(api!.runner()!.state!.target!.kind, 'folder');
      assert.equal(api!.runner()!.state!.planned, 1);
    }],
    ['runs each sample collection with the same results as core', async () => {
      // The sample's client secret is stored locally on both sides, as a user would enter it.
      // The other samples' logins are sent too, with synthetic credentials the fixture server doesn't know.
      const secrets: [string, string, string, string][] = [['Sample Travel', 'local', 'clientSecret', CLIENT_SECRET], ['Sample ASP.NET API', 'local', 'password', 'synthetic-password'],
        ['DummyJSON', 'public', 'username', 'synthetic-user'], ['DummyJSON', 'public', 'password', 'synthetic-password']];
      for (const [name, environment, variable, value] of secrets) {
        await invoke('env:set-secret', collection(name).id, environment, variable, value);
        coreEnv.setSecret(coreCollection(name).id, environment, variable, value);
      }
      for (const name of ['Sample Travel', 'Sample ASP.NET API', 'DummyJSON']) {
        const options = { environment: ENVIRONMENTS[name], stopOnFailure: false };
        const fromExtension = await invoke('runner:start', randomUUID(), collection(name).id, options) as RunnerResult;
        const fromCore = await core.start(randomUUID(), coreCollection(name).id, options);
        assert.deepEqual(comparable(fromExtension), comparable(fromCore), `${name} differs`);
        assert.ok(fromExtension.steps.length > 0, `${name} has no requests`);
        console.log(`  ${name}: ${fromExtension.steps.map((s) => `${s.name} ${s.status}${s.httpStatus ? ` ${s.httpStatus}` : ''}${s.reason ? ` (${s.reason})` : ''}`).join('; ')}`);
      }
      // The sample travel collection logs in and lists bookings with its tests passing.
      const travel = await invoke('runner:start', randomUUID(), collection('Sample Travel').id, { environment: 'local', stopOnFailure: false }) as RunnerResult;
      assert.deepEqual(travel.steps.map((s) => `${s.name} ${s.status}`), ['Login passed', 'List bookings passed']);
    }],
    ['Dev Tools shows each request of the runs in Network and Console', async () => {
      // Two requests in each sample collection, and the travel collection once more.
      await until(() => (shown()?.runs ?? 0) >= 8, 'the runs in Dev Tools');
      assert.ok(shown()!.lines > shown()!.runs, 'Console lines for the runs');
      networkBefore = shown()!.runs;
    }],
    ['a request panel send reaches Dev Tools', async () => {
      const login = collection('Sample Travel').children!.find((c) => c.name === 'Auth')!.children![0];
      const doc = (await invoke('requests:get', login.id)).doc;
      await invoke('runs:start', randomUUID(), login.id, doc);
      await until(() => shown()!.runs === networkBefore + 1, 'the send in Network');
    }],
    ['runs only the requests under a folder', async () => {
      const bookings = collection('Sample Travel').children!.find((c) => c.name === 'Bookings')!;
      const result = await invoke('runner:start', randomUUID(), bookings.id, { environment: 'local', stopOnFailure: false }) as RunnerResult;
      assert.deepEqual(result.steps.map((s) => `${s.name} ${s.status}`), ['List bookings passed']);
      const fromCore = await core.start(randomUUID(), coreWorkspace.snapshot().collections.find((c) => c.name === 'Sample Travel')!.children!.find((c) => c.name === 'Bookings')!.id, { environment: 'local', stopOnFailure: false });
      assert.deepEqual(comparable(result), comparable(fromCore));
    }],
    ['runs one collection at a time and cancels the run going on', async () => {
      const before = shown()!.runs;
      const runnerId = randomUUID();
      const running = invoke('runner:start', runnerId, collection('Slow').id, { environment: 'local', stopOnFailure: false }) as Promise<RunnerResult>;
      await until(() => shown()!.runs === before + 1, 'the hanging request in Network');
      await assert.rejects(invoke('runner:start', randomUUID(), collection('Sample Travel').id, { environment: 'local', stopOnFailure: false }), /already going on/);
      await invoke('runner:cancel', runnerId);
      const result = await running;
      assert.equal(result.ended, 'cancelled');
      assert.deepEqual(result.steps.map((s) => s.status), ['cancelled']);
    }],
    ['closing the runner panel leaves no runner behind', async () => {
      api!.runner()!.panel.dispose();
      await until(() => !api!.runner(), 'the runner panel to close');
      assert.equal(api!.runnerStatus(), undefined);
    }]
  ];
  const failures: Error[] = [];
  try {
    for (const [name, check] of checks) {
      try {
        await check();
        console.log(`PASS ${name}`);
      } catch (error) {
        console.error(`FAIL ${name}`, error);
        failures.push(new Error(name, { cause: error }));
      }
    }
  } finally {
    api?.runner()?.panel.dispose();
    await coreRuns.close();
    identity.close();
    await rm(coreData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`Runner checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Runner checks failed');
}
