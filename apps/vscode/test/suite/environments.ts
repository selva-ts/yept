import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { EnvironmentList } from '@yept/core/shared/ipc';
import type { RequestDoc } from '@yept/core/shared/model';
import type { TestApi } from '../../src/extension';

// Environments in the real extension: secrets in the keychain-backed store, the status bar, the commands, and
// Login → token → protected call in each environment. The workspace is a copy of the sample collection whose
// environment keeps its secrets as secrets; the fixture server's client secret is entered through the extension.
const CLIENT_SECRET = 'sample-secret';

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).includes(needle)) hits.push(path);
  }
  return hits;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

async function acceptFirstChoice<T>(opening: () => Thenable<T>): Promise<T> {
  const window = vscode.window as { showQuickPick: (...args: unknown[]) => Thenable<unknown> };
  const show = window.showQuickPick;
  let shown = false;
  window.showQuickPick = (...args) => { shown = true; return show.apply(vscode.window, args); };
  try {
    let settled = false;
    const result = Promise.resolve(opening()).finally(() => { settled = true; });
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (shown && !settled) await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }
    return await result;
  } finally {
    window.showQuickPick = show;
  }
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'The tests need a workspace folder');
  let api: TestApi | undefined;
  let panel: vscode.WebviewPanel | undefined;
  let collectionId = '';
  let loginId = '';
  let bookingsId = '';
  const service = () => {
    const found = api && [...api.services.entries()].find(([path]) => resolve(path).toLowerCase() === resolve(root).toLowerCase())?.[1];
    assert.ok(found, 'No services for the workspace folder');
    return found;
  };
  const invoke = <T>(channel: string, ...args: unknown[]) => service().handlers.invoke(channel, ...args) as Promise<T>;
  const send = async (requestId: string) => {
    const doc = (await invoke<{ doc: RequestDoc }>('requests:get', requestId)).doc;
    return (await invoke<{ result: { status?: number; outcome: string } }>('runs:start', randomUUID(), requestId, doc)).result;
  };
  const status = () => api?.environmentStatus();

  const checks: [string, () => Promise<void>][] = [
    ['activates with the environment commands', async () => {
      const extension = vscode.extensions.all.find((e) => resolve(e.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
      assert.ok(extension, 'Development extension was not loaded');
      api = await extension.activate() as TestApi | undefined;
      assert.ok(api);
      await api.ready;
      const commands = await vscode.commands.getCommands(true);
      for (const command of ['yept.selectEnvironment', 'yept.manageEnvironments']) assert.ok(commands.includes(command), command);
      const snapshot = api.collections.snapshots()[0];
      collectionId = snapshot.collections[0].id;
      const ids = (node: any): any[] => [node, ...(node.children ?? []).flatMap(ids)];
      const requests = snapshot.collections.flatMap(ids).filter((n) => n.kind === 'request');
      loginId = requests.find((n) => n.name === 'Login')?.id;
      bookingsId = requests.find((n) => n.name === 'List bookings')?.id;
      assert.ok(loginId && bookingsId, 'Missing sample requests');
    }],
    ['shows the environment in the status bar while a request panel is open', async () => {
      panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('yept.openRequest', loginId);
      assert.ok(panel);
      await until(() => status() === '$(server-environment) No environment', 'the status bar');
    }],
    ['stores secrets through the extension and creates a second environment', async () => {
      await invoke('env:set-secret', collectionId, 'local', 'clientSecret', CLIENT_SECRET);
      const local = (await invoke<EnvironmentList>('env:list', collectionId)).environments.find((e) => e.name === 'local');
      assert.ok(local);
      await invoke('env:save', collectionId, null, { name: 'second', variables: local.variables.map(({ name, value, secret, enabled }) => ({ name, value, secret, enabled })) });
      await invoke('env:set-secret', collectionId, 'second', 'clientSecret', CLIENT_SECRET);
      assert.equal(await invoke('env:reveal-secret', collectionId, 'second', 'clientSecret'), CLIENT_SECRET);
    }],
    ['logs in and calls the protected endpoint in each environment, with tokens kept per environment', async () => {
      for (const name of ['local', 'second']) {
        await invoke('env:set-active', collectionId, name);
        await until(() => status() === `$(server-environment) ${name}`, `the status bar to show ${name}`);
        // No token in this environment yet: {{accessToken}} is unresolved, so the call is blocked before sending.
        const blocked = await send(bookingsId);
        assert.equal(blocked.outcome, 'prepare_error', `${name}: no token yet`);
        assert.equal((await send(loginId)).status, 200, `${name}: login`);
        assert.equal((await send(bookingsId)).status, 200, `${name}: protected call`);
      }
    }],
    ['switches environment from the status bar quick pick', async () => {
      await acceptFirstChoice(() => vscode.commands.executeCommand('yept.selectEnvironment'));
      await until(() => status() === '$(server-environment) No environment', 'the status bar to clear');
      assert.equal((await invoke<EnvironmentList>('env:list', collectionId)).active, null);
    }],
    ['opens the environment editor from the command and the tree', async () => {
      assert.ok(panel && api);
      await vscode.commands.executeCommand('yept.manageEnvironments');
      assert.ok(panel.visible);
      const item = api.collections.getChildren().find((i) => i.kind === 'collection');
      assert.ok(item);
      await vscode.commands.executeCommand('yept.manageEnvironments', item);
      assert.ok(panel.visible);
    }],
    ['keeps secret values out of the workspace and unreadable in local storage', async () => {
      assert.ok(api);
      assert.deepEqual(await filesContaining(root, CLIENT_SECRET), []);
      assert.deepEqual(await filesContaining(api.storage, CLIENT_SECRET), []);
      const shared = await readFile(join(root, 'environments', 'second.yml'), 'utf8');
      assert.match(shared, /clientSecret/);
    }],
    ['applies yept.* settings without a reload', async () => {
      assert.ok(api);
      const config = vscode.workspace.getConfiguration('yept');
      assert.equal(api.settings().cookies, true);
      await config.update('cookies.automatic', false, vscode.ConfigurationTarget.Global);
      await config.update('history.runsPerRequest', 3, vscode.ConfigurationTarget.Global);
      try {
        await until(() => api!.settings().cookies === false && api!.settings().historyRunsPerRequest === 3, 'the settings to apply');
        assert.equal((await invoke<{ enabled: boolean }>('cookies:list', collectionId)).enabled, false);
      } finally {
        await config.update('cookies.automatic', undefined, vscode.ConfigurationTarget.Global);
        await config.update('history.runsPerRequest', undefined, vscode.ConfigurationTarget.Global);
      }
    }],
    ['removes an environment', async () => {
      await invoke('env:remove', collectionId, 'second');
      assert.deepEqual((await readdir(join(root, 'environments'))).sort(), ['local.yml']);
      // A folder reload already under way may still list it for a moment; the next reload settles it.
      let names: string[] = [];
      for (let i = 0; i < 30 && names.join() !== 'local'; i++) {
        names = (await invoke<EnvironmentList>('env:list', collectionId)).environments.map((e) => e.name);
        if (names.join() !== 'local') await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(names, ['local']);
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
    panel?.dispose();
  }
  console.log(`Environment checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Environment checks failed');
}
