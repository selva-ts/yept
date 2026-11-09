import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { LARGE_BODY_CHARS, type RequestDoc, type RunResult } from '@yept/core/shared/model';
import type { TestApi } from '../../src/extension';
import type { HistoryNode } from '../../src/history-view';

// The History view and "Open in editor" in the real extension. The workspace is this suite's own copy of the sample
// collection; its environment points at the local fixture server.

async function until(condition: () => boolean | Promise<boolean>, what: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

// Just under the 50 MB processing limit, so the whole body is read.
const BIG_MB = 48;

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'The tests need a workspace folder');
  let api: TestApi | undefined;
  let loginId = '';
  let bookingsId = '';
  let changedRunId = '';
  let bigRunId = '';
  const service = () => {
    const found = api && [...api.services.entries()].find(([path]) => resolve(path).toLowerCase() === resolve(root).toLowerCase())?.[1];
    assert.ok(found, 'No services for the workspace folder');
    return found;
  };
  const invoke = (channel: string, ...args: unknown[]) => service().handlers.invoke(channel, ...args) as Promise<any>;
  const doc = async (id: string): Promise<RequestDoc> => (await invoke('requests:get', id)).doc;
  const send = async (id: string, change: Partial<RequestDoc> = {}): Promise<RunResult> => {
    const runId = randomUUID();
    const out = await invoke('runs:start', runId, id, { ...await doc(id), ...change });
    return out.result as RunResult;
  };
  const open = (id: string) => vscode.commands.executeCommand<vscode.WebviewPanel | undefined>('yept.openRequest', id);
  const shown = (id: string) => api?.panels().find((p) => p.requestId === id);
  const loaded = (id: string) => until(() => (shown(id)?.reports ?? 0) > 0, 'the page to report its request');
  const listed = (): HistoryNode[] => api!.history.getChildren();
  const node = (runId: string): HistoryNode => {
    const found = listed().find((n) => n.summary.runId === runId);
    assert.ok(found, `Run ${runId} is not in the History view`);
    return found;
  };
  const bookingsFile = join(root, 'Bookings', 'List bookings.yml');
  const loginFile = join(root, 'Auth', 'Login.yml');
  const configuration = vscode.workspace.getConfiguration('yept');

  const checks: [string, () => Promise<void>][] = [
    ['activates', async () => {
      const extension = vscode.extensions.all.find((e) => resolve(e.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
      assert.ok(extension, 'Development extension was not loaded');
      api = await extension.activate() as TestApi | undefined;
      assert.ok(api);
      await api.ready;
      // Enough runs for the seeded history, and bodies kept whole up to the largest the settings allow.
      await configuration.update('history.runsPerRequest', 200, vscode.ConfigurationTarget.Global);
      await configuration.update('history.bodyLimitMb', BIG_MB, vscode.ConfigurationTarget.Global);
      const ids = (n: any): any[] => [n, ...(n.children ?? []).flatMap(ids)];
      const requests = api.collections.snapshots()[0].collections.flatMap(ids).filter((n) => n.kind === 'request');
      loginId = requests.find((n) => n.name === 'Login')?.id;
      bookingsId = requests.find((n) => n.name === 'List bookings')?.id;
      assert.ok(loginId && bookingsId, 'Missing sample requests');
    }],
    ['asks for a request while no request panel is open', async () => {
      await vscode.commands.executeCommand('yept.history.focus');
      assert.deepEqual(listed(), []);
      assert.match(api!.history.view.message ?? '', /Open a request/);
    }],
    ['follows the active panel', async () => {
      const login = await open(loginId);
      await loaded(loginId);
      // The folder's services start with its first panel.
      await invoke('env:set-active', (await invoke('requests:get', loginId)).collectionId, 'local');
      assert.equal((await send(loginId)).status, 200);
      const bookings = await open(bookingsId);
      await loaded(bookingsId);
      assert.ok(login && bookings);
      // The bookings request has no runs yet.
      await until(() => listed().length === 0 && api!.history.view.description === 'List bookings', 'the view to show List bookings');
      assert.match(api!.history.view.message ?? '', /No runs yet/);
      login.reveal();
      await until(() => api!.history.view.description === 'Login' && listed().length === 1, 'the view to follow the Login panel');
      assert.equal(listed()[0].requestId, loginId);
      assert.equal(listed()[0].summary.method, 'POST');
      bookings.reveal();
      await until(() => api!.history.view.description === 'List bookings' && listed().length === 0, 'the view to follow the bookings panel back');
    }],
    ['lists 100 runs newest first, quickly', async () => {
      // One real run, then 99 older copies of it straight into the history database.
      await send(bookingsId);
      const [first] = service().runs.history.list(bookingsId);
      const entry = service().runs.history.get(first.runId)!;
      const ctx = await api!.collections.workspace(root)!.requestContext(bookingsId);
      for (let i = 1; i < 100; i++) {
        const runId = randomUUID();
        service().runs.history.add({
          runId, requestId: bookingsId, collectionDir: ctx.collectionDir, requestName: 'List bookings', requestPath: entry.summary.requestPath,
          startedAt: new Date(Date.parse(first.startedAt) - i * 60_000).toISOString(), result: { ...entry.result, runId, durationMs: i },
          doc: entry.doc, bodyBytes: Buffer.from(entry.result.body.text), secrets: [], appVersion: 'test'
        });
      }
      const started = performance.now();
      const nodes = listed();
      const items = nodes.map((n) => api!.history.getTreeItem(n));
      const elapsed = performance.now() - started;
      console.log(`Listed ${nodes.length} runs in ${elapsed.toFixed(1)} ms`);
      assert.equal(nodes.length, 100);
      assert.ok(elapsed < 250, `Listing 100 runs took ${elapsed.toFixed(1)} ms`);
      const times = nodes.map((n) => Date.parse(n.summary.startedAt));
      assert.deepEqual(times, [...times].sort((a, b) => b - a));
      assert.equal(nodes[0].summary.runId, first.runId);
      assert.match(String(items[0].label), /^GET \d{3}$/);
      assert.match(String(items[0].description), / · \d+ ms$/);
    }],
    ['opens a run in the request panel, read-only', async () => {
      const older = listed()[5].summary.runId;
      await vscode.commands.executeCommand('yept.history.open', node(older));
      await until(() => shown(bookingsId)?.viewing === older, 'the panel to show the run');
      assert.match(String(api!.history.getTreeItem(node(older)).description), /shown$/);
      assert.equal(shown(bookingsId)?.dirty, false);
    }],
    ['restores a run into the unsaved draft without saving it', async () => {
      const before = await readFile(bookingsFile, 'utf8');
      const changed = { ...await doc(bookingsId), docs: 'Notes from an earlier run' };
      const runId = randomUUID();
      await invoke('runs:start', runId, bookingsId, changed);
      changedRunId = runId;
      await vscode.commands.executeCommand('yept.history.restore', node(runId));
      await until(() => shown(bookingsId)?.dirty === true, 'the panel to have unsaved changes');
      const panel = shown(bookingsId)!;
      assert.equal(panel.title, '● List bookings');
      assert.equal(panel.viewing, null);
      assert.equal(await readFile(bookingsFile, 'utf8'), before);
      assert.notEqual((await doc(bookingsId)).docs, 'Notes from an earlier run');
    }],
    ['opens a JSON body as a read-only document with the right content', async () => {
      const result = await send(bookingsId);
      assert.match(result.body.contentType, /json/);
      await invoke('runs:open-body', result.runId);
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor);
      assert.equal(editor.document.uri.scheme, 'yept-body');
      assert.equal(editor.document.languageId, 'json');
      assert.equal(editor.document.getText(), result.body.text);
      assert.match(editor.document.uri.path, /List bookings response\.json$/);
      // Typing does nothing: the editor is read-only.
      await vscode.commands.executeCommand('type', { text: 'typed' });
      assert.equal(editor.document.getText(), result.body.text);
      assert.equal(editor.document.isDirty, false);
    }],
    ['sends only a preview of a large body to the page and opens the whole body in an editor', async () => {
      const bookings = await doc(bookingsId);
      const started = performance.now();
      const result = await send(bookingsId, {
        url: `{{baseUrl}}/big?mb=${BIG_MB}`, params: [{ ...bookings.params[0], name: 'mb', value: String(BIG_MB) }], tests: '', assertions: []
      });
      console.log(`Ran the ${BIG_MB} MB request in ${(performance.now() - started).toFixed(0)} ms`);
      assert.equal(result.outcome, 'http', result.error?.message);
      assert.equal(result.body.truncated, false);
      bigRunId = result.runId;
      assert.equal(result.sizeBytes, BIG_MB * 1024 * 1024);
      assert.equal(result.body.preview, true);
      assert.equal(result.body.text.length, LARGE_BODY_CHARS);
      const opening = performance.now();
      await invoke('runs:open-body', bigRunId);
      console.log(`Opened the ${BIG_MB} MB body in ${(performance.now() - opening).toFixed(0)} ms`);
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor);
      assert.equal(editor.document.uri.scheme, 'yept-body');
      assert.equal(editor.document.languageId, 'plaintext');
      assert.equal(editor.document.getText().length, BIG_MB * 1024 * 1024);
      assert.equal(editor.document.lineAt(0).text.slice(0, 10), 'xxxxxxxxxx');
      await vscode.commands.executeCommand('type', { text: 'typed' });
      assert.equal(editor.document.lineAt(0).text.slice(0, 5), 'xxxxx');
      assert.equal(editor.document.isDirty, false);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }],
    ['keeps the panel answering while it shows a large run', async () => {
      const panel = shown(bookingsId)!.panel;
      panel.reveal();
      await until(() => api!.history.view.description === 'List bookings', 'the bookings panel to be active');
      const started = performance.now();
      await vscode.commands.executeCommand('yept.history.open', node(bigRunId));
      await until(() => shown(bookingsId)?.viewing === bigRunId, 'the panel to show the large run', 300);
      const shownAfter = performance.now() - started;
      // Straight after: the panel takes the next request and answers it.
      const next = performance.now();
      await vscode.commands.executeCommand('yept.history.open', node(changedRunId));
      await until(() => shown(bookingsId)?.viewing === changedRunId, 'the panel to answer straight after');
      const answered = performance.now() - next;
      console.log(`Large run shown in ${shownAfter.toFixed(0)} ms; next message answered in ${answered.toFixed(0)} ms`);
      assert.ok(answered < 3000, `The panel took ${answered.toFixed(0)} ms to answer after showing a large run`);
    }],
    ['follows a rename of the request', async () => {
      const original = await readFile(loginFile, 'utf8');
      shown(loginId)!.panel.reveal();
      await until(() => api!.history.view.description === 'Login', 'the Login panel to be active');
      await writeFile(loginFile, original.replace('name: Login', 'name: Sign in'));
      await until(() => (listed(), api!.history.view.description === 'Sign in'), 'the view to follow the rename');
      await writeFile(loginFile, original);
      await until(() => (listed(), api!.history.view.description === 'Login'), 'the view to follow the name back');
    }],
    ['drops a deleted request, then empties when no request panel is left', async () => {
      assert.equal(listed().length, 1);
      await rm(loginFile);
      await until(() => !shown(loginId), 'the Login panel to close');
      // The next panel in the group comes to the front, and the view follows it.
      await until(() => listed().every((n) => n.requestId !== loginId), 'the view to drop the deleted request');
      api!.answerClosePrompts('discard');
      shown(bookingsId)?.panel.dispose();
      await until(() => listed().length === 0 && /Open a request/.test(api!.history.view.message ?? ''), 'the view to empty');
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
  console.log(`History checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'History checks failed');
}
