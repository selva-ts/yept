import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { TreeItem } from '../../src/collections';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) { if (check()) return; await delay(50); }
  throw new Error(`Timed out waiting for ${what}`);
}
function all(items: TreeItem[]): TreeItem[] { return items.flatMap((item) => [item, ...all(item.children)]); }
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const file = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else result.push(`${file}:${await readFile(file, 'base64')}`);
  }
  return result.sort();
}
function git(cwd: string, ...args: string[]): void {
  let result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && /permission denied/i.test(result.stderr)) {
    console.error('Git first run failed:', result.stderr);
    result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    console.error('Git retry:', result.status === 0 ? 'passed' : result.stderr);
  }
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

export async function run(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 2);
  const [first, second] = folders!;
  const added = process.env.YEPT_TEST_ADDED!;
  const clone = process.env.YEPT_TEST_CLONE!;
  const baseline = await Promise.all([files(first.uri.fsPath), files(second.uri.fsPath), files(added)]);
  const path = resolve(__dirname, '../../..').toLowerCase();
  const extension = vscode.extensions.all.find((item) => resolve(item.extensionPath).toLowerCase() === path);
  assert.ok(extension);
  let api: TestApi;
  let panel: vscode.WebviewPanel | undefined;
  const checks: [string, () => Promise<void>][] = [
    ['contributes the container and activates on the view', async () => {
      const manifest = extension.packageJSON;
      assert.ok(manifest.contributes.viewsContainers.activitybar.some((c: any) => c.id === 'yept'));
      assert.ok(manifest.contributes.views.yept.some((v: any) => v.id === 'yept.collections'));
      assert.ok(manifest.activationEvents.includes('onView:yept.collections'));
      assert.ok(!manifest.activationEvents.includes('*') && !manifest.activationEvents.includes('onStartupFinished'));
      assert.equal(extension.isActive, false, 'The extension should activate lazily');
      await vscode.commands.executeCommand('yept.collections.focus');
      await until(() => extension.isActive, 'view activation');
      assert.ok(extension.exports, 'The extension returns its test API only when run for tests');
      api = extension.exports as TestApi;
      await api.ready;
    }],
    ['shows both roots and the sample folders and requests', async () => {
      const roots = api.collections.getChildren();
      assert.deepEqual(roots.map((item) => item.name), ['First', 'Second']);
      for (const root of roots) {
        const nodes = all(root.children);
        for (const name of ['Sample Travel', 'Auth', 'Bookings', 'Login', 'List bookings']) assert.ok(nodes.some((n) => n.name === name), name);
      }
    }],
    ['lists requests from both folders in the quick pick', async () => {
      const window = vscode.window as { showQuickPick: (items: readonly vscode.QuickPickItem[]) => Thenable<unknown> };
      const pick = window.showQuickPick;
      let choices: readonly vscode.QuickPickItem[] = [];
      window.showQuickPick = async (items) => { choices = await items; return undefined; };
      try { await vscode.commands.executeCommand('yept.openRequest'); }
      finally { window.showQuickPick = pick; }
      assert.ok(choices.some((item) => item.label === 'Login' && item.description?.startsWith('First ·')));
      assert.ok(choices.some((item) => item.label === 'Login' && item.description?.startsWith('Second ·')));
    }],
    ['opens and sends the second folder request and records its history', async () => {
      const root = api.collections.getChildren()[1];
      const item = all(root.children).find((n) => n.name === 'Login');
      assert.ok(item && item.kind === 'request');
      const command = api.collections.getTreeItem(item).command;
      assert.ok(command);
      panel = await vscode.commands.executeCommand<vscode.WebviewPanel>(command.command, ...command.arguments!);
      assert.ok(panel?.webview.html.includes(`data-request-id="${item.requestId}"`));
      const service = api.services.get(second.uri.fsPath);
      assert.ok(service && item.requestId);
      const loaded = await service.handlers.invoke('requests:get', item.requestId) as any;
      await service.handlers.invoke('env:set-active', loaded.collectionId, 'local');
      const runId = randomUUID();
      const result = await service.handlers.invoke('runs:start', runId, item.requestId, loaded.doc) as any;
      assert.equal(result.result.status, 200);
      assert.equal(service.runs.history.list(item.requestId).length, 1);
      assert.deepEqual(await Promise.all([files(first.uri.fsPath), files(second.uri.fsPath), files(added)]), baseline);
    }],
    ['does not reload its own request save', async () => {
      const service = api.services.get(second.uri.fsPath);
      const item = all(api.collections.getChildren()[1].children).find((node) => node.name === 'Login');
      assert.ok(service && item && item.kind === 'request' && item.requestId);
      const file = join(second.uri.fsPath, 'Auth', 'Login.yml');
      const original = await readFile(file);
      await delay(1200);
      let changes = 0;
      const subscription = api.collections.onDidChangeTreeData(() => { changes++; });
      try {
        const request = await service.handlers.invoke('requests:get', item.requestId) as any;
        await service.handlers.invoke('requests:save', item.requestId, request.doc);
        await delay(1200);
        assert.equal(changes, 1, 'The save refreshes once and its filesystem events are ignored');
      } finally {
        subscription.dispose();
        await writeFile(file, original);
        await delay(1200);
      }
    }],
    ['updates for external add, change, rename and delete', async () => {
      const source = join(second.uri.fsPath, 'Auth', 'Login.yml');
      const file = join(second.uri.fsPath, 'Auth', 'Extra.yml');
      const moved = join(second.uri.fsPath, 'Auth', 'Moved.yml');
      const sample = await readFile(source, 'utf8');
      const names = () => all(api.collections.getChildren()).map((item) => item.name);
      await delay(1000);
      await writeFile(file, sample.replace('name: Login', 'name: Extra'));
      await until(() => names().includes('Extra'), 'added request');
      await writeFile(file, sample.replace('name: Login', 'name: Changed'));
      await until(() => names().includes('Changed'), 'changed request');
      const changed = all(api.collections.getChildren()).find((item) => item.name === 'Changed');
      assert.ok(changed && changed.kind === 'request');
      await rename(file, moved);
      await until(() => all(api.collections.getChildren()).some((item) => item.kind === 'request' && item.path.endsWith('Moved.yml')), 'renamed request');
      assert.equal(all(api.collections.getChildren()).find((item) => item.kind === 'request' && item.path.endsWith('Moved.yml'))?.id, changed.id);
      await rm(moved);
      await until(() => !names().includes('Changed'), 'deleted request');
      assert.deepEqual(await files(second.uri.fsPath), baseline[1]);
    }],
    ['shows a workspace folder added while running', async () => {
      assert.ok(vscode.workspace.updateWorkspaceFolders(2, 0, { uri: vscode.Uri.file(added), name: 'Added' }));
      await until(() => api.collections.getChildren().some((item) => item.name === 'Added'), 'added workspace folder');
      assert.ok(all(api.collections.getChildren().find((item) => item.name === 'Added')!.children).some((item) => item.name === 'Login'));
    }],
    ['updates the tree after a real git pull', async () => {
      const sample = await readFile(join(clone, 'Auth', 'Login.yml'), 'utf8');
      await writeFile(join(clone, 'Auth', 'Pulled.yml'), sample.replace('name: Login', 'name: Pulled'));
      git(clone, 'add', '.');
      git(clone, 'commit', '-m', 'Add synthetic request');
      git(clone, 'push');
      await delay(1000);
      git(added, 'pull', '--ff-only');
      await until(() => all(api.collections.getChildren()).some((item) => item.name === 'Pulled'), 'pulled request');
    }],
    ['discovers and removes collections when markers change', async () => {
      const empty = vscode.Uri.file(process.env.YEPT_TEST_EMPTY!).fsPath;
      try {
        assert.ok(vscode.workspace.updateWorkspaceFolders(3, 0, { uri: vscode.Uri.file(empty), name: 'Empty' }));
        await until(() => api.collections.getChildren().some((item) => item.name === 'Empty'), 'empty root');
        await api.collections.settled();
        const marker = join(empty, 'opencollection.yml');
        const markerText = await readFile(join(first.uri.fsPath, 'opencollection.yml'));
        const discovered = () => api.collections.getChildren().find((item) => item.name === 'Empty')?.children.length === 1;
        // VS Code installs the marker watcher for a newly added root asynchronously; recreate the marker until it is seen.
        for (let attempt = 1; ; attempt++) {
          await writeFile(marker, markerText);
          try { await until(discovered, 'new collection marker', 20); break; } catch (error) { if (attempt === 10) throw error; }
          // Pause after deleting so the watcher reports a delete and a create, not a coalesced change.
          await rm(marker);
          await delay(300);
        }
        await rm(marker);
        await until(() => api.collections.getChildren().find((item) => item.name === 'Empty')?.children.length === 0, 'removed collection marker');
        await writeFile(join(empty, 'Ping.bru'), 'meta {\n  name: Ping\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://api.example.test/ping\n  body: none\n  auth: none\n}\n');
        await writeFile(join(empty, 'Broken.bru'), 'not a valid request');
        await writeFile(join(empty, 'bruno.json'), JSON.stringify({ version: '1', name: 'Synthetic', type: 'collection' }));
        await until(() => all(api.collections.getChildren().find((item) => item.name === 'Empty')!.children).some((item) => item.name === 'Ping'), 'read-only collection');
        const nodes = all(api.collections.getChildren().find((item) => item.name === 'Empty')!.children);
        const ping = nodes.find((item) => item.name === 'Ping');
        const problem = nodes.find((item) => item.name === 'Broken.bru');
        assert.ok(ping && ping.kind === 'request' && ping.readOnly && ping.method === 'GET');
        assert.ok(problem && problem.kind === 'problem' && api.collections.getTreeItem(problem).tooltip);
      } finally {
        const index = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.uri.fsPath === empty) ?? -1;
        if (index >= 0) {
          vscode.workspace.updateWorkspaceFolders(index, 1);
          await until(() => !api.collections.getChildren().some((item) => item.name === 'Empty'), 'removed workspace folder');
          await api.collections.settled();
        }
      }
    }],
    ['closes the panel of a deleted request without unsaved changes', async () => {
      const item = all(api.collections.getChildren()[1].children).find((n) => n.name === 'Login');
      assert.ok(item && item.kind === 'request');
      const file = join(second.uri.fsPath, 'Auth', 'Login.yml');
      const contents = await readFile(file);
      assert.ok(panel);
      let closed = false;
      panel.onDidDispose(() => { closed = true; });
      try {
        await rm(file);
        await until(() => closed, 'the removed request panel to close');
      } finally { await writeFile(file, contents); }
    }],
    ['creation commands cancel safely and route new items to the chosen root and folder', async () => {
      const empty = vscode.Uri.file(join(process.env.YEPT_TEST_EMPTY!, 'creation-workspace')).fsPath;
      await mkdir(empty, { recursive: true });
      await delay(250);
      const win = vscode.window as any;
      const originals = { showQuickPick: win.showQuickPick, showInputBox: win.showInputBox, showInformationMessage: win.showInformationMessage, showOpenDialog: win.showOpenDialog, showErrorMessage: win.showErrorMessage };
      const before = await Promise.all([files(first.uri.fsPath), files(second.uri.fsPath)]);
      const name = 'UI creation check';
      try {
        assert.ok(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders!.length, 0, { uri: vscode.Uri.file(empty), name: 'Creation' }));
        await until(() => !!api.collections.workspace(empty), 'creation workspace');
        await api.collections.settled();
        win.showQuickPick = async () => undefined;
        win.showOpenDialog = async () => undefined;
        await vscode.commands.executeCommand('yept.newCollection');
        await vscode.commands.executeCommand('yept.newRequest');
        await vscode.commands.executeCommand('yept.openCollection');
        assert.ok(!api.collections.snapshots().find((s) => s.root === empty)!.collections.some((c) => c.name === name));
        win.showQuickPick = async (items: any[]) => items.find((i) => i.root === empty);
        win.showInputBox = async () => undefined;
        await vscode.commands.executeCommand('yept.newCollection');
        win.showInputBox = async () => name;
        await vscode.commands.executeCommand('yept.newCollection');
        const root = api.collections.getChildren().find((i) => i.name === 'Creation')!;
        const collection = root.children.find((i) => i.name === name)!;
        assert.ok(collection);
        assert.equal(api.collections.getParent(collection)?.id, root.id);
        const workspace = api.collections.workspace(empty)!;
        const collectionId = workspace.snapshot().collections.find((c) => c.name === name)!.id;
        const folderId = await workspace.createFolder(collectionId, 'Nested');
        api.collections.saved(empty);
        const folder = all(api.collections.getChildren()).find((i) => i.id === JSON.stringify([empty, 'folder', folderId]))!;
        assert.ok(folder);
        const requestCount = workspace.liveRequestIds().size;
        win.showInputBox = async () => undefined;
        await vscode.commands.executeCommand('yept.newRequest', folder);
        assert.equal(workspace.liveRequestIds().size, requestCount);
        win.showInputBox = async () => 'Created request';
        await vscode.commands.executeCommand('yept.newRequest', folder);
        const request = all(api.collections.getChildren()).find((i) => i.name === 'Created request');
        assert.ok(request?.kind === 'request');
        assert.equal(api.collections.rootForRequest(request.requestId!), empty);
        assert.equal(api.collections.getParent(request)?.id, folder.id);
        assert.equal(api.collections.getTreeItem(request).description, 'GET');
        const requestFile = join(empty, name, 'Nested', 'Created request.yml');
        const requestText = await readFile(requestFile, 'utf8');
        assert.ok(requestText.includes('Created request'));
        await writeFile(requestFile, requestText.replace('name: Created request', 'name: Renamed request'));
        await until(() => all(api.collections.getChildren()).some((i) => i.name === 'Renamed request'), 'new collection watcher');
        const folderCount = vscode.workspace.workspaceFolders!.length;
        win.showOpenDialog = async () => [vscode.Uri.file(join(empty, name))];
        win.showInformationMessage = async () => { throw new Error('Already open collection should not prompt to add a folder'); };
        await vscode.commands.executeCommand('yept.openCollection');
        assert.equal(vscode.workspace.workspaceFolders!.length, folderCount);
        let errorMessage = '';
        win.showErrorMessage = async (message: string) => { errorMessage = message; };
        win.showOpenDialog = async () => [vscode.Uri.file(empty)];
        await vscode.commands.executeCommand('yept.openCollection');
        assert.match(errorMessage, /no opencollection.yml or bruno.json/);
        // Restrict the command's snapshots to the empty root to exercise the first-request guidance.
        const snapshots = api.collections.snapshots.bind(api.collections);
        const another = vscode.Uri.file(join(process.env.YEPT_TEST_EMPTY!, 'guided-workspace')).fsPath;
        await mkdir(another);
        assert.ok(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders!.length, 0, { uri: vscode.Uri.file(another), name: 'Guided' }));
        await until(() => !!api.collections.workspace(another), 'guided workspace');
        await api.collections.settled();
        try {
          api.collections.snapshots = () => snapshots().filter((s) => s.root === another);
          const answers = ['Guided collection', 'First request'];
          win.showInformationMessage = async () => 'New Collection';
          win.showInputBox = async () => answers.shift();
          await vscode.commands.executeCommand('yept.newRequest');
          assert.ok(all(api.collections.getChildren()).some((i) => i.name === 'First request'));
        } finally {
          api.collections.snapshots = snapshots;
          const index = vscode.workspace.workspaceFolders!.findIndex((f) => f.uri.fsPath === another);
          if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
          await until(() => !api.collections.workspace(another), 'guided folder removal');
          await api.collections.settled();
          await rm(another, { recursive: true, force: true });
        }
        assert.deepEqual(await Promise.all([files(first.uri.fsPath), files(second.uri.fsPath)]), before);
      } finally {
        Object.assign(win, originals);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        const index = vscode.workspace.workspaceFolders?.findIndex((f) => f.uri.fsPath === empty) ?? -1;
        if (index >= 0) {
          vscode.workspace.updateWorkspaceFolders(index, 1);
          await until(() => !api.collections.workspace(empty), 'creation folder removal');
          await api.collections.settled();
        }
        await rm(join(empty, name), { recursive: true, force: true });
      }
    }],
    ['opens external collections through a cancellable workspace flow', async () => {
      const external = vscode.Uri.file(await mkdtemp(join(dirname(process.env.YEPT_TEST_EMPTY!), 'external-collection-'))).fsPath;
      const folderIndex = () => vscode.workspace.workspaceFolders?.findIndex((f) => f.uri.fsPath === external) ?? -1;
      await writeFile(join(external, 'bruno.json'), JSON.stringify({ version: '1', name: 'External synthetic', type: 'collection' }));
      const win = vscode.window as any;
      const originals = { showOpenDialog: win.showOpenDialog, showInformationMessage: win.showInformationMessage };
      try {
        win.showOpenDialog = async () => [vscode.Uri.file(external)];
        win.showInformationMessage = async () => undefined;
        await vscode.commands.executeCommand('yept.openCollection');
        assert.equal(folderIndex(), -1);
        win.showInformationMessage = async () => 'Add to Workspace';
        await vscode.commands.executeCommand('yept.openCollection');
        await until(() => !!api.collections.workspace(external), 'opened external collection');
        await api.collections.settled();
        assert.ok(api.collections.snapshots().find((s) => s.root === external)?.collections.some((c) => c.name === 'External synthetic' && c.readOnly));
      } finally {
        Object.assign(win, originals);
        const index = folderIndex();
        if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
        await until(() => folderIndex() < 0 && !api.collections.workspace(external), 'external collection removal');
        await api.collections.settled();
        await rm(external, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      }
    }]
  ];
  const failures: Error[] = [];
  for (const [name, run] of checks) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}`, error); failures.push(new Error(name, { cause: error })); }
  }
  panel?.dispose();
  console.log(`Tree extension host checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Tree extension host checks failed');
}
