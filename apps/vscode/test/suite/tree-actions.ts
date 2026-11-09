import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { TreeItem } from '../../src/collections';
import type { CollectionTreeItem } from '../../src/collection-tree-model';

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function flatten(items: TreeItem[]): TreeItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children)]);
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  const extension = vscode.extensions.all.find((item) => resolve(item.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
  assert.ok(extension);
  const api = await extension.activate() as TestApi;
  assert.ok(api);
  await api.ready;
  const nodes = (): CollectionTreeItem[] => flatten(api.collections.getChildren()).filter((item): item is CollectionTreeItem => item.kind !== 'workspace');
  const named = (name: string, kind: CollectionTreeItem['kind']) => nodes().find((item) => item.name === name && item.kind === kind);
  const writable = nodes().find((item) => item.kind === 'collection' && item.path === 'Writable');
  const other = nodes().find((item) => item.kind === 'collection' && item.path === 'Other');
  const readOnly = nodes().find((item) => item.kind === 'collection' && item.readOnly);
  assert.ok(writable && other && readOnly);
  const login = nodes().find((item) => item.name === 'Login' && item.path.startsWith('Writable/'));
  assert.ok(login?.requestId);
  const requestId = login.requestId;
  let copyId = '';
  const win = vscode.window as any;
  const original = { showInputBox: win.showInputBox, showWarningMessage: win.showWarningMessage, showErrorMessage: win.showErrorMessage };
  // The test host cannot use the Windows Recycle Bin for this temporary profile.
  const workspace = api.collections.workspace(root) as any;
  const originalTrash = workspace.options.trash;
  const trashed: string[] = [];
  workspace.options.trash = async (path: string) => { trashed.push(path); await rm(path, { recursive: true }); };
  const errors: string[] = [];
  win.showErrorMessage = async (message: string) => { errors.push(message); };
  const checks: [string, () => Promise<void>][] = [
    ['creates and renames a folder', async () => {
      win.showInputBox = async () => 'Action folder';
      await vscode.commands.executeCommand('yept.newFolder', writable);
      const folder = named('Action folder', 'folder');
      assert.ok(folder);
      win.showInputBox = async () => 'Renamed folder';
      await vscode.commands.executeCommand('yept.rename', folder);
      const renamed = named('Renamed folder', 'folder');
      assert.ok(renamed);
      assert.equal(api.collections.getParent(renamed)?.id, writable.id);
    }],
    ['renames an open request without losing identity or history', async () => {
      const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('yept.openRequest', requestId);
      assert.ok(panel);
      await until(() => (api.panels().find((item) => item.requestId === requestId)?.reports ?? 0) > 0, 'request panel');
      const request = await api.services.get(root)!.handlers.invoke('requests:get', requestId) as any;
      await api.services.get(root)!.handlers.invoke('env:set-active', request.collectionId, 'local');
      const run = await api.services.get(root)!.handlers.invoke('runs:start', randomUUID(), requestId, request.doc) as any;
      assert.equal(run.result.status, 200);
      assert.equal((await api.services.get(root)!.handlers.invoke('history:list', requestId) as any[]).length, 1);
      win.showInputBox = async (options: any) => {
        assert.equal(options.value, 'Login');
        assert.deepEqual(options.valueSelection, [0, 5]);
        return 'Sign in';
      };
      await vscode.commands.executeCommand('yept.rename', nodes().find((item) => item.requestId === requestId));
      assert.equal(named('Sign in', 'request')?.requestId, requestId);
      await until(() => api.panels().find((item) => item.requestId === requestId)?.title === 'Sign in', 'renamed panel title');
      assert.equal(api.panels().find((item) => item.requestId === requestId)?.panel, panel);
      assert.equal((await api.services.get(root)!.handlers.invoke('history:list', requestId) as any[]).length, 1);
      assert.equal((await api.services.get(root)!.handlers.invoke('requests:get', requestId) as any).doc.name, 'Sign in');
    }],
    ['moves a request through the drag controller and keeps its history', async () => {
      const source = nodes().find((item) => item.requestId === requestId)!;
      const target = named('Renamed folder', 'folder')!;
      const transfer = new vscode.DataTransfer();
      await api.dragAndDropController.handleDrag([source], transfer);
      await api.dragAndDropController.handleDrop(target, transfer);
      const moved = nodes().find((item) => item.requestId === requestId);
      assert.ok(moved);
      assert.equal(api.collections.getParent(moved)?.id, target.id);
      assert.equal((await api.services.get(root)!.handlers.invoke('history:list', requestId) as any[]).length, 1);
      assert.equal((await api.services.get(root)!.handlers.invoke('requests:get', requestId) as any).path, 'Writable/Renamed folder/Sign in.yml');
      assert.equal(api.panels().find((item) => item.requestId === requestId)?.title, 'Sign in');
      assert.ok(api.panels().find((item) => item.requestId === requestId));
    }],
    ['refuses read-only, cross-collection and descendant drops', async () => {
      const move = async (source: TreeItem, target: TreeItem) => {
        const transfer = new vscode.DataTransfer();
        await api.dragAndDropController.handleDrag([source], transfer);
        await api.dragAndDropController.handleDrop(target, transfer);
      };
      const request = nodes().find((item) => item.requestId === requestId)!;
      const before = (await api.services.get(root)!.handlers.invoke('requests:get', requestId) as any).path;
      await move(request, readOnly);
      await move(request, other);
      const folder = named('Renamed folder', 'folder')!;
      win.showInputBox = async () => 'Child';
      await vscode.commands.executeCommand('yept.newFolder', folder);
      await move(folder, named('Child', 'folder')!);
      assert.equal((await api.services.get(root)!.handlers.invoke('requests:get', requestId) as any).path, before);
      assert.equal(named('Renamed folder', 'folder')?.id, folder.id);
      assert.equal(errors.length, 3);
      assert.ok(errors.every((message) => message.startsWith('Yept: ')));
      errors.length = 0;
    }],
    ['moves a folder dragged with a request inside it, keeping the request panel and history', async () => {
      const folder = named('Renamed folder', 'folder')!;
      const inside = nodes().find((item) => item.requestId === requestId)!;
      const bookings = nodes().find((item) => item.kind === 'folder' && item.path === 'Writable/Bookings');
      assert.ok(bookings);
      const transfer = new vscode.DataTransfer();
      await api.dragAndDropController.handleDrag([folder, inside], transfer);
      await api.dragAndDropController.handleDrop(bookings, transfer);
      assert.deepEqual(errors, []);
      const moved = named('Renamed folder', 'folder');
      assert.ok(moved);
      assert.equal(api.collections.getParent(moved)?.id, bookings.id);
      assert.equal((await api.services.get(root)!.handlers.invoke('requests:get', requestId) as any).path, 'Writable/Bookings/Renamed folder/Sign in.yml');
      assert.equal((await api.services.get(root)!.handlers.invoke('history:list', requestId) as any[]).length, 1);
      assert.equal(api.panels().find((item) => item.requestId === requestId)?.title, 'Sign in');
    }],
    ['duplicates a request and opens the copy', async () => {
      const request = nodes().find((item) => item.requestId === requestId)!;
      await vscode.commands.executeCommand('yept.duplicate', request);
      assert.deepEqual(errors, []);
      const copy = named('Sign in copy', 'request');
      assert.ok(copy?.requestId && copy.requestId !== requestId, JSON.stringify(nodes().filter((item) => item.kind === 'request').map((item) => [item.name, item.path, item.requestId])));
      copyId = copy.requestId;
      assert.ok(api.panels().some((item) => item.requestId === copyId));
    }],
    ['deletes a clean request after confirmation', async () => {
      const copy = nodes().find((item) => item.requestId === copyId)!;
      const path = join(root, copy.path);
      win.showWarningMessage = async (message: string, options: any, button: string) => {
        assert.equal(message, 'Delete "Sign in copy"?');
        assert.equal(options.modal, true);
        assert.equal(button, 'Delete');
        return button;
      };
      await vscode.commands.executeCommand('yept.delete', copy);
      assert.deepEqual(errors, []);
      await until(() => !api.panels().some((item) => item.requestId === copyId), 'copy panel to close');
      assert.ok(!nodes().some((item) => item.requestId === copyId));
      await assert.rejects(access(path));
      assert.ok(trashed.includes(path));
    }],
    ['deletes a folder and its contents after confirmation', async () => {
      const folder = named('Renamed folder', 'folder')!;
      win.showWarningMessage = async (_message: string, options: any) => {
        assert.match(options.detail, /everything in it/);
        return 'Delete';
      };
      await vscode.commands.executeCommand('yept.delete', folder);
      assert.deepEqual(errors, []);
      await until(() => !api.panels().some((item) => item.requestId === requestId), 'folder request panel to close');
      assert.ok(!nodes().some((item) => item.requestId === requestId));
      await assert.rejects(access(join(root, 'Writable', 'Bookings', 'Renamed folder')));
      assert.ok(trashed.includes(join(root, 'Writable', 'Bookings', 'Renamed folder')));
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
    workspace.options.trash = originalTrash;
    for (const entry of api.panels()) entry.panel.dispose();
  }
  console.log(`Tree action checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Tree action checks failed');
}
