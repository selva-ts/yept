import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { RequestDoc } from '@yept/core/shared/model';
import type { TestApi } from '../../src/extension';

// Request panels in the real extension: one per request, the unsaved marker and the prompt when a panel with unsaved
// changes is closed. The workspace is a copy of the sample collection, so files may change.

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'The tests need a workspace folder');
  let api: TestApi | undefined;
  let loginId = '';
  let bookingsId = '';
  const service = () => {
    const found = api && [...api.services.entries()].find(([path]) => resolve(path).toLowerCase() === resolve(root).toLowerCase())?.[1];
    assert.ok(found, 'No services for the workspace folder');
    return found;
  };
  const doc = async (id: string) => (await service().handlers.invoke('requests:get', id) as { doc: RequestDoc }).doc;
  const open = (id: string) => vscode.commands.executeCommand<vscode.WebviewPanel | undefined>('yept.openRequest', id);
  const shown = (id: string) => api?.panels().find((p) => p.requestId === id);
  // The page reports its request once loaded; a test's own report must come after that one.
  const loaded = (id: string) => until(() => (shown(id)?.reports ?? 0) > 0, 'the page to report its request');
  const edit = async (panel: vscode.WebviewPanel, id: string, docs: string) => {
    const draft = { ...await doc(id), docs };
    api?.panelMessage(panel, { panelState: { requestId: id, name: draft.name, dirty: true, draft } });
  };
  const loginFile = join(root, 'Auth', 'Login.yml');
  const original = await readFile(loginFile, 'utf8');

  const checks: [string, () => Promise<void>][] = [
    ['activates', async () => {
      const extension = vscode.extensions.all.find((e) => resolve(e.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
      assert.ok(extension, 'Development extension was not loaded');
      api = await extension.activate() as TestApi | undefined;
      assert.ok(api);
      await api.ready;
      const ids = (node: any): any[] => [node, ...(node.children ?? []).flatMap(ids)];
      const requests = api.collections.snapshots()[0].collections.flatMap(ids).filter((n) => n.kind === 'request');
      loginId = requests.find((n) => n.name === 'Login')?.id;
      bookingsId = requests.find((n) => n.name === 'List bookings')?.id;
      assert.ok(loginId && bookingsId, 'Missing sample requests');
    }],
    ['opens each request in its own panel, named after the request', async () => {
      const login = await open(loginId);
      const bookings = await open(bookingsId);
      assert.ok(login && bookings);
      assert.notEqual(login, bookings);
      assert.equal(login.title, 'Login');
      assert.equal(bookings.title, 'List bookings');
      assert.equal(login.options.retainContextWhenHidden, true);
      assert.deepEqual(api?.panels().map((p) => p.requestId).sort(), [loginId, bookingsId].sort());
    }],
    ['shows the open panel when a request is opened again', async () => {
      const login = shown(loginId)?.panel;
      assert.equal(await open(loginId), login);
      assert.equal(api?.panels().length, 2);
      await until(() => !!login?.active, 'the panel to come to the front');
    }],
    ['follows a rename from the page', async () => {
      await loaded(loginId);
      await writeFile(loginFile, original.replace('name: Login', 'name: Sign in'));
      await until(() => shown(loginId)?.title === 'Sign in', 'the title to follow the file');
      await writeFile(loginFile, original);
      await until(() => shown(loginId)?.title === 'Login', 'the title to follow the file back');
    }],
    ['marks unsaved changes in the title', async () => {
      const panel = shown(loginId)?.panel;
      assert.ok(panel);
      await edit(panel, loginId, 'Unsaved notes');
      assert.equal(panel.title, '● Login');
      assert.equal(shown(loginId)?.dirty, true);
    }],
    ['reopens the request with its unsaved changes when closing is cancelled', async () => {
      const panel = shown(loginId)?.panel;
      assert.ok(panel && api);
      api.answerClosePrompts('cancel');
      panel.dispose();
      await until(() => !!shown(loginId) && shown(loginId)?.panel !== panel, 'the request to reopen');
      const reopened = shown(loginId)!;
      assert.equal(reopened.title, '● Login');
      assert.match(reopened.panel.webview.html, /data-draft="[^"]*Unsaved notes/);
      // The page restores the draft and reports it as unsaved.
      await loaded(loginId);
      assert.equal(shown(loginId)?.dirty, true);
      assert.notEqual((await doc(loginId)).docs, 'Unsaved notes');
    }],
    ['drops unsaved changes when told not to save', async () => {
      const panel = shown(loginId)?.panel;
      assert.ok(panel && api);
      api.answerClosePrompts('discard');
      panel.dispose();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(shown(loginId), undefined);
      assert.equal(await readFile(loginFile, 'utf8'), original);
    }],
    ['saves unsaved changes when told to save', async () => {
      const panel = await open(loginId);
      assert.ok(panel && api);
      await loaded(loginId);
      await edit(panel, loginId, 'Saved on close');
      api.answerClosePrompts('save');
      panel.dispose();
      await until(async () => (await doc(loginId)).docs === 'Saved on close', 'the draft to be saved');
      assert.equal(shown(loginId), undefined);
    }],
    ['closes without asking when nothing is unsaved', async () => {
      const panel = await open(loginId);
      assert.ok(panel && api);
      await loaded(loginId);
      api.answerClosePrompts('cancel');
      panel.dispose();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(shown(loginId), undefined);
    }],
    ['opens the environment editor in the active panel', async () => {
      const count = api?.panels().length;
      await vscode.commands.executeCommand('yept.manageEnvironments');
      assert.equal(api?.panels().length, count);
    }],
    ['closes the panel of a removed request', async () => {
      assert.ok(shown(bookingsId));
      await rm(join(root, 'Bookings', 'List bookings.yml'));
      await until(() => !shown(bookingsId), 'the panel to close');
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
    api?.answerClosePrompts('discard');
    for (const p of api?.panels() ?? []) p.panel.dispose();
  }
  console.log(`Panel checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Panel checks failed');
}
