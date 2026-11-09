import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { TreeNode } from '@yept/core/shared/model';
import type { TestApi } from '../../src/extension';
import type { TreeItem } from '../../src/collections';
import type { CollectionTreeItem } from '../../src/collection-tree-model';

// Import, export and paste cURL in the real extension, with VS Code's dialogs, prompts and messages stubbed. The
// workspace is this suite's own folder with one sample collection; the import sources are the synthetic fixtures.

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const flatten = (items: TreeItem[]): TreeItem[] => items.flatMap((item) => [item, ...flatten(item.children)]);
const flatNodes = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flatNodes(n.children ?? [])]);

interface Modal { message: string; detail?: string; items: string[] }

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const fixtures = process.env.YEPT_TEST_FIXTURES;
  assert.ok(root && fixtures);
  const extension = vscode.extensions.all.find((item) => resolve(item.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
  assert.ok(extension);
  const api = await extension.activate() as TestApi;
  assert.ok(api);
  await api.ready;

  const snapshot = () => api.collections.snapshots()[0];
  const collection = (name: string): TreeNode | undefined => snapshot().collections.find((c) => c.name === name);
  const requests = (name: string): { name: string; method?: string; path: string }[] =>
    flatNodes(collection(name)?.children ?? []).filter((n) => n.kind === 'request').map((n) => ({ name: n.name, method: n.method, path: n.path.split('/').slice(1).join('/') })).sort((a, b) => a.path.localeCompare(b.path));
  const item = (name: string, kind: CollectionTreeItem['kind']): TreeItem => {
    const found = flatten(api.collections.getChildren()).find((i) => i.name === name && i.kind === kind);
    assert.ok(found, `Missing tree item ${name}`);
    return found;
  };
  const folders = () => readdirSync(root).sort();
  // The Bookings folder of the imported .bru sample (other collections have one too).
  const bookings = (): TreeItem => {
    const found = flatten(api.collections.getChildren()).find((i) => i.kind === 'folder' && i.name === 'Bookings' && i.path.startsWith('Sample Bruno Travel/'));
    assert.ok(found, 'Missing the Bookings folder');
    return found;
  };

  const win = vscode.window as any;
  const original = { showQuickPick: win.showQuickPick, showOpenDialog: win.showOpenDialog, showSaveDialog: win.showSaveDialog, showInformationMessage: win.showInformationMessage, showWarningMessage: win.showWarningMessage, showErrorMessage: win.showErrorMessage, showInputBox: win.showInputBox };
  const clipboard = await vscode.env.clipboard.readText();
  const errors: string[] = [];
  const modals: Modal[] = [];
  const notices: string[] = [];
  // Answers for the modal prompts, by the start of their message; non-modal messages are recorded as notices.
  let answers: Record<string, string | undefined> = {};
  const answer = async (message: string, options?: any, ...items: any[]) => {
    if (!options?.modal) { notices.push(message); return undefined; }
    modals.push({ message, detail: options.detail, items });
    const key = Object.keys(answers).find((prefix) => message.startsWith(prefix));
    return key === undefined ? undefined : answers[key];
  };
  win.showInformationMessage = answer;
  win.showWarningMessage = answer;
  win.showErrorMessage = async (message: string) => { errors.push(message); };
  // The import source: the file or folder handed to the open dialog; credentials keep all ticked.
  let source: string | undefined;
  win.showOpenDialog = async (options: vscode.OpenDialogOptions) => {
    if (!source) return undefined;
    assert.equal(!!options.canSelectFolders, !basename(source).includes('.'));
    return [vscode.Uri.file(source)];
  };
  win.showQuickPick = async (picks: any[], options: any) => {
    if (options?.title === 'Yept: Import Collection') return picks.find((p) => p.folder === !basename(source ?? '').includes('.'));
    if (options?.canPickMany) return picks.filter((p) => p.picked);
    return undefined;
  };
  const importFrom = async (path: string, replies: Record<string, string | undefined>) => {
    source = path;
    answers = replies;
    modals.length = 0;
    notices.length = 0;
    await vscode.commands.executeCommand('yept.importCollection');
  };

  const checks: [string, () => Promise<void>][] = [
    ['imports each fixture format after its preview, and reveals it', async () => {
      const cases: [string, string, RegExp][] = [
        [join(fixtures, 'postman-sample.postman_collection.json'), 'Sample Postman Travel', /^Postman collection · 3 requests, /],
        [join(fixtures, 'insomnia-sample.json'), '', /^Insomnia export · 2 requests, /],
        [join(fixtures, 'openapi-sample.yaml'), '', /^OpenAPI document · \d+ requests?, /],
        [join(fixtures, 'bruno-sample'), 'Sample Bruno Travel', /^Bruno \.bru collection · 3 requests, 2 folders, 1 environment\./]
      ];
      for (const [path, expected, summary] of cases) {
        const before = new Set(snapshot().collections.map((c) => c.name));
        await importFrom(path, { 'Import "': 'Import' });
        assert.deepEqual(errors, [], path);
        const preview = modals[0];
        assert.ok(preview?.message.startsWith('Import "'), path);
        assert.match(preview.detail ?? '', summary);
        assert.match(preview.detail ?? '', /Nothing is sent or run during an import/);
        assert.deepEqual(preview.items, ['Import', 'Rename…']);
        const added = snapshot().collections.filter((c) => !before.has(c.name));
        assert.equal(added.length, 1, path);
        if (expected) assert.equal(added[0].name, expected);
        const count = Number(/· (\d+) request/.exec(preview.detail!)![1]);
        assert.equal(requests(added[0].name).length, count);
        assert.ok(notices.some((n) => n.startsWith(`${path.endsWith('bruno-sample') ? 'Converted' : 'Imported'} "${added[0].name}"`)), notices.join('\n'));
        await until(() => api.treeSelection()[0]?.kind === 'collection' && api.treeSelection()[0]?.name === added[0].name, `${added[0].name} selected in the tree`);
      }
      // The credential the .bru sample's environment holds went to a local secret, not into the file.
      const env = await readFile(join(root, 'Sample Bruno Travel', 'environments', 'local.yml'), 'utf8');
      assert.ok(!env.includes('sample-client-secret'));
      assert.ok(notices.some((n) => n.includes('1 value(s) stored as local secrets')));
    }],
    ['writes nothing when the preview is cancelled', async () => {
      const before = folders();
      const names = snapshot().collections.map((c) => c.name);
      await importFrom(join(fixtures, 'bruno-sample'), {});
      assert.equal(modals.length, 1);
      await importFrom(join(fixtures, 'postman-sample.postman_collection.json'), { 'Import "': 'Import' }); // conflict prompt left unanswered
      assert.equal(modals.length, 2);
      assert.match(modals[1].message, /already exists/);
      assert.deepEqual(errors, []);
      assert.deepEqual(folders(), before);
      assert.deepEqual(snapshot().collections.map((c) => c.name), names);
    }],
    ['offers the desktop conflict choices when the collection exists', async () => {
      const file = join(fixtures, 'postman-sample.postman_collection.json');
      const target = join(root, 'Sample Postman Travel');
      const login = join(target, readdirSync(target, { recursive: true }).map(String).find((f) => f.endsWith('Login.yml'))!);
      await writeFile(login, (await readFile(login, 'utf8')).replace('name: Login', 'name: Edited login'));
      await until(() => requests('Sample Postman Travel').some((r) => r.name === 'Edited login'), 'edited request');

      await importFrom(file, { 'Import "': 'Import', 'A folder named': 'Keep Existing Files' });
      assert.deepEqual(modals[1].items, ['Import as a Copy', 'Keep Existing Files', 'Replace Existing Files']);
      assert.match(modals[1].detail ?? '', /Nothing is deleted/);
      assert.ok((await readFile(login, 'utf8')).includes('Edited login'));
      assert.ok(notices.some((n) => /kept as they were/.test(n)), notices.join('\n'));

      await importFrom(file, { 'Import "': 'Import', 'A folder named': 'Replace Existing Files' });
      assert.ok(!(await readFile(login, 'utf8')).includes('Edited login'));
      assert.ok(requests('Sample Postman Travel').some((r) => r.name === 'Login'));

      await importFrom(file, { 'Import "': 'Import', 'A folder named': 'Import as a Copy' });
      assert.ok(existsSync(join(root, 'Sample Postman Travel (2)', 'opencollection.yml')));
      assert.equal(snapshot().collections.filter((c) => c.name === 'Sample Postman Travel').length, 2);
      assert.deepEqual(errors, []);
    }],
    ['exports a collection that imports back the same', async () => {
      const exported = join(dirname(root), 'exported.yml');
      let saveOptions: vscode.SaveDialogOptions | undefined;
      win.showSaveDialog = async (options: vscode.SaveDialogOptions) => { saveOptions = options; return vscode.Uri.file(exported); };
      answers = { 'Export "': 'With Environments' };
      modals.length = 0;
      await vscode.commands.executeCommand('yept.exportCollection', item('Sample Bruno Travel', 'collection'));
      assert.deepEqual(errors, []);
      assert.deepEqual(modals[0].items, ['With Environments', 'Without Environments']);
      assert.match(modals[0].detail ?? '', /Secret values are never included/);
      assert.equal(saveOptions?.defaultUri?.fsPath, join(root, 'Sample Bruno Travel.yml'));
      const text = await readFile(exported, 'utf8');
      assert.ok(!text.includes('sample-client-secret'));

      win.showInputBox = async (options: any) => {
        assert.equal(options.value, 'Sample Bruno Travel');
        return 'Round trip';
      };
      await importFrom(exported, { 'Import "Sample Bruno Travel"': 'Rename…', 'Import "Round trip"': 'Import' });
      assert.deepEqual(errors, []);
      assert.match(modals[0].detail ?? '', /^OpenCollection \(bundled\) · 3 requests, 2 folders, 1 environment\./);
      assert.equal(modals.length, 2); // no conflict after the rename
      assert.deepEqual(requests('Round trip'), requests('Sample Bruno Travel'));
      const original = snapshot().collections.find((c) => c.name === 'Sample Bruno Travel')!;
      const copy = snapshot().collections.find((c) => c.name === 'Round trip')!;
      const workspace = api.collections.workspace(root)!;
      const docs = (c: TreeNode) => flatNodes(c.children ?? []).filter((n) => n.kind === 'request').map((n) => workspace.getRequest(n.id).doc).sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(docs(copy), docs(original));
      assert.deepEqual(workspace.getEnvironment(copy.id, 'local')?.variables.map((v) => [v.name, v.secret]), workspace.getEnvironment(original.id, 'local')?.variables.map((v) => [v.name, v.secret]));
    }],
    ['pastes a curl command into a folder and opens the new request', async () => {
      await vscode.env.clipboard.writeText(`curl -X POST 'https://api.example.test/users?team=a' -H 'Content-Type: application/json' -H 'Accept: application/json' -d '{"name":"Ada"}'`);
      let prompt = '';
      win.showInputBox = async (options: any) => { prompt = options.prompt; return options.value; };
      const folder = bookings();
      await vscode.commands.executeCommand('yept.pasteCurl', folder);
      assert.deepEqual(errors, []);
      assert.match(prompt, /^POST https:\/\/api\.example\.test\/users\?team=a · 2 headers · JSON body · auth inherited/);
      const created = flatten(api.collections.getChildren()).find((i): i is CollectionTreeItem => i.kind === 'request' && api.collections.getParent(i)?.id === folder.id && i.name !== 'List bookings' && i.name !== 'Create booking');
      assert.ok(created?.requestId, 'new request in the folder');
      await until(() => api.panels().some((p) => p.requestId === created.requestId), 'request panel');
      const doc = api.collections.workspace(root)!.getRequest(created.requestId).doc;
      assert.equal(doc.method, 'POST');
      assert.equal(doc.url, 'https://api.example.test/users?team=a');
      assert.equal(doc.body.mode, 'json');
      await until(() => api.treeSelection()[0]?.id === created.id, 'new request selected in the tree');
    }],
    ['shows an error when the clipboard is not a curl command', async () => {
      const before = snapshot().collections.map((c) => requests(c.name).length);
      for (const text of ['not a curl command', 'curl -H "Accept: text/plain"', ' ']) {
        await vscode.env.clipboard.writeText(text);
        errors.length = 0;
        win.showInputBox = async () => assert.fail('No name is asked for');
        await vscode.commands.executeCommand('yept.pasteCurl', bookings());
        assert.equal(errors.length, 1, text);
        assert.match(errors[0], /^Yept: The clipboard doesn't hold a curl command\./);
      }
      errors.length = 0;
      assert.deepEqual(snapshot().collections.map((c) => requests(c.name).length), before);
    }]
  ];
  const failures: Error[] = [];
  try {
    for (const [name, check] of checks) {
      try { await check(); console.log(`PASS ${name}`); }
      catch (error) { console.error(`FAIL ${name}`, error); failures.push(new Error(name, { cause: error })); }
    }
  } finally {
    Object.assign(win, original);
    await vscode.env.clipboard.writeText(clipboard);
    for (const entry of api.panels()) entry.panel.dispose();
  }
  console.log(`Import and export checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Import and export checks failed');
}
