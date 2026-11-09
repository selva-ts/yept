import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import type { RequestDoc, RunResult } from '@yept/core/shared/model';
import { UNTRUSTED, type TestApi } from '../../src/extension';

// Runs with Workspace Trust on and the folder left untrusted: requests still send; scripts, vars, assertions and tests
// report "not run" with the reason, and the folder's files are untouched.
export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'The tests need a workspace folder');
  let api: TestApi | undefined;
  let panel: vscode.WebviewPanel | undefined;
  const checks: [string, () => Promise<void>][] = [
    ['opens in restricted mode with the commands available', async () => {
      assert.equal(vscode.workspace.isTrusted, false, 'The folder should be untrusted for this suite');
      const extension = vscode.extensions.all.find((e) => resolve(e.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
      assert.ok(extension);
      api = await extension.activate() as TestApi | undefined;
      assert.ok(api);
      await api.ready;
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('yept.openRequest'));
    }],
    ['sends the request but runs no scripts or tests', async () => {
      assert.ok(api);
      const snapshot = api.collections.snapshots()[0];
      const all = (n: any): any[] => [n, ...(n.children ?? []).flatMap(all)];
      const login = snapshot.collections.flatMap(all).find((n) => n.kind === 'request' && n.name === 'Login');
      assert.ok(login);
      panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('yept.openRequest', login.id);
      const service = [...api.services.entries()].find(([path]) => resolve(path).toLowerCase() === resolve(root).toLowerCase())?.[1];
      assert.ok(service);
      const collectionId = snapshot.collections[0].id;
      await service.handlers.invoke('env:set-active', collectionId, 'local');
      const doc = (await service.handlers.invoke('requests:get', login.id) as { doc: RequestDoc }).doc;
      const { result } = await service.handlers.invoke('runs:start', randomUUID(), login.id, doc) as { result: RunResult };
      assert.equal(result.status, 200);
      assert.equal(result.testsState, 'not-run');
      assert.equal(result.testsNote, `Not run: ${UNTRUSTED}`);
      assert.deepEqual(result.tests, []);
      assert.ok(result.scriptErrors.some((e) => e.stage === 'post-response' && e.message === `Not run: ${UNTRUSTED}`), JSON.stringify(result.scriptErrors));
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
  console.log(`Trust checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Trust checks failed');
}
