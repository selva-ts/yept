import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';

// The leak check in the real extension: warnings in the Problems panel for this suite's own workspace copy, the check
// command, and the pre-commit hook in throwaway Git repositories (made under YEPT_TEST_REPOS, never this repository).

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

// Synthetic, built at run time so no credential-shaped literal sits in the source.
const TOKEN = ['synthetic', 'leak', 'check', 'value', '0001'].join('-');
const request = (name: string, auth: string): string =>
  `info:\n  name: ${name}\n  type: http\n  seq: 9\n\nhttp:\n  method: GET\n  url: "{{baseUrl}}/leaky"\n  headers:\n    - name: Authorization\n      value: ${auth}\n`;
const LEAKY = request('Leaky', `Bearer ${TOKEN}`);
const CLEAN = request('Leaky', 'Bearer {{accessToken}}');

interface GitOutput { ok: boolean; out: string }
/** Real git, no shell, test code only. */
const git = (cwd: string, ...args: string[]): Promise<GitOutput> => new Promise((done) => {
  execFile('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => done({ ok: !error, out: `${stdout}${stderr}` }));
});
const must = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await git(cwd, ...args);
  assert.ok(r.ok, `git ${args.join(' ')}: ${r.out}`);
  return r.out;
};

async function repository(path: string): Promise<string> {
  await mkdir(join(path, 'api'), { recursive: true });
  await must(path, 'init', '-b', 'main');
  await must(path, 'config', 'user.name', 'Synthetic Test');
  await must(path, 'config', 'user.email', 'test@api.example.test');
  await must(path, 'config', 'core.autocrlf', 'false');
  await writeFile(join(path, 'api', 'opencollection.yml'), 'opencollection: 1.0.0\n\ninfo:\n  name: Hook Sample\n');
  await must(path, 'add', '.');
  await must(path, 'commit', '-m', 'Initial synthetic collection');
  return path;
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repos = process.env.YEPT_TEST_REPOS;
  assert.ok(root && repos);
  const extension = vscode.extensions.all.find((item) => resolve(item.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
  assert.ok(extension);
  const api = await extension.activate() as TestApi;
  assert.ok(api);
  await api.ready;

  const win = vscode.window as any;
  const original = { showInformationMessage: win.showInformationMessage, showWarningMessage: win.showWarningMessage, showErrorMessage: win.showErrorMessage };
  const notices: string[] = [];
  const errors: string[] = [];
  let modalAnswer: string | undefined;
  const answer = async (message: string, options?: any) => {
    if (options?.modal) return modalAnswer;
    notices.push(message);
    return undefined;
  };
  win.showInformationMessage = answer;
  win.showWarningMessage = answer;
  win.showErrorMessage = async (message: string) => { errors.push(message); };

  try {
    // ---------- Problems panel ----------
    const file = join(root, 'Leaky.yml');
    const uri = vscode.Uri.file(file);
    const warnings = () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Yept leak check');
    const baseline = await vscode.commands.executeCommand<{ findings: number; files: number }>('yept.checkLeaks');
    assert.ok(baseline);

    await writeFile(file, LEAKY);
    await until(() => warnings().length === 1, 'the warning for a literal bearer token');
    const [warning] = warnings();
    assert.equal(warning.severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(warning.code, 'bearer');
    const line = LEAKY.split('\n').findIndex((l) => l.includes(TOKEN));
    const column = LEAKY.split('\n')[line].indexOf(TOKEN);
    assert.deepEqual([warning.range.start.line, warning.range.start.character, warning.range.end.line, warning.range.end.character], [line, column, line, column + TOKEN.length]);
    assert.match(warning.message, /literal Bearer credential instead of a \{\{variable\}\}/);
    assert.match(warning.message, /local secret/);
    assert.ok(!warning.message.includes(TOKEN), 'the message never shows the value');

    // The command scans everything now and reports the count.
    notices.length = 0;
    const counted = await vscode.commands.executeCommand<{ findings: number; files: number }>('yept.checkLeaks');
    assert.deepEqual(counted, { findings: baseline.findings + 1, files: baseline.files + 1 });
    assert.ok(notices.some((n) => /^Yept found \d+ possible leaked secrets? in \d+ files?\.$/.test(n)), notices.join('\n'));

    // Fixing the file clears the warning.
    await writeFile(file, CLEAN);
    await until(() => warnings().length === 0, 'the warning to clear after the fix');

    // Deleting the file clears it too.
    await writeFile(file, LEAKY);
    await until(() => warnings().length === 1, 'the warning to come back');
    await rm(file);
    await until(() => warnings().length === 0, 'the warning to clear after the delete');
    if (!baseline.findings) {
      notices.length = 0;
      assert.deepEqual(await vscode.commands.executeCommand('yept.checkLeaks'), { findings: 0, files: 0 });
      assert.deepEqual(notices, ['Yept: no leaked secrets found in the open collections.']);
    }

    // ---------- the pre-commit hook ----------
    const plain = await repository(join(repos, 'plain'));
    const hook = join(plain, '.git', 'hooks', 'pre-commit');
    const installed = await vscode.commands.executeCommand<{ action: string; hooksDir: string }>('yept.installLeakHook', vscode.Uri.file(plain));
    assert.equal(installed?.action, 'created');
    assert.ok(existsSync(join(plain, '.git', 'hooks', 'yept-leak-check.cjs')));
    // Installing again is safe: the block is replaced, not repeated.
    assert.equal((await vscode.commands.executeCommand<{ action: string }>('yept.installLeakHook', plain))?.action, 'updated');
    assert.equal((await readFile(hook, 'utf8')).split('# >>> yept leak check >>>').length, 2);

    const commits = async (repo: string): Promise<void> => {
      // A literal bearer token in a staged collection file blocks the commit, without printing the value.
      await writeFile(join(repo, 'api', 'Leaky.yml'), LEAKY);
      await must(repo, 'add', '.');
      const blocked = await git(repo, 'commit', '-m', 'Add a leaky request');
      assert.ok(!blocked.ok, `the commit should be blocked: ${blocked.out}`);
      assert.match(blocked.out, /Yept leak check: commit blocked/);
      assert.match(blocked.out, /api\/Leaky\.yml:11/);
      assert.ok(!blocked.out.includes(TOKEN), 'the hook never prints the value');
      // A clean one goes through; a credential outside any collection folder isn't the hook's business.
      await writeFile(join(repo, 'api', 'Leaky.yml'), CLEAN);
      await writeFile(join(repo, 'notes.yml'), `example: Bearer ${TOKEN}\n`);
      await must(repo, 'add', '.');
      const clean = await git(repo, 'commit', '-m', 'Add a clean request');
      assert.ok(clean.ok, `the clean commit should pass: ${clean.out}`);
    };
    await commits(plain);
    assert.equal((await vscode.commands.executeCommand<{ action: string }>('yept.removeLeakHook', plain))?.action, 'removed');
    assert.ok(!existsSync(hook) && !existsSync(join(plain, '.git', 'hooks', 'yept-leak-check.cjs')));

    // core.hooksPath is where Git looks, so that's where the hook goes.
    const custom = await repository(join(repos, 'hooks-path'));
    await must(custom, 'config', 'core.hooksPath', '.githooks');
    // Compared in long form: the temporary folder can come as a Windows short (8.3) path.
    assert.equal(realpathSync.native((await vscode.commands.executeCommand<{ hooksDir: string }>('yept.installLeakHook', custom))!.hooksDir), realpathSync.native(join(custom, '.githooks')));
    assert.ok(existsSync(join(custom, '.githooks', 'pre-commit')));
    await commits(custom);

    // Someone else's hook is never overwritten silently: cancel leaves it alone, adding keeps it running.
    const foreign = await repository(join(repos, 'foreign'));
    const foreignHook = join(foreign, '.git', 'hooks', 'pre-commit');
    const theirs = '#!/bin/sh\necho "existing hook ran"\nexit 0\n';
    await writeFile(foreignHook, theirs);
    modalAnswer = undefined;
    assert.equal(await vscode.commands.executeCommand('yept.installLeakHook', foreign), undefined);
    assert.equal(await readFile(foreignHook, 'utf8'), theirs);
    assert.ok(!existsSync(join(foreign, '.git', 'hooks', 'yept-leak-check.cjs')));
    modalAnswer = 'Add to Existing Hook';
    assert.equal((await vscode.commands.executeCommand<{ action: string }>('yept.installLeakHook', foreign))?.action, 'added');
    const combined = await readFile(foreignHook, 'utf8');
    assert.ok(combined.startsWith('#!/bin/sh\n# >>> yept leak check >>>') && combined.includes('echo "existing hook ran"'), combined);
    await commits(foreign);
    const last = await must(foreign, 'commit', '--allow-empty', '-m', 'Empty');
    assert.match(last, /existing hook ran/);
    // Removing takes out only Yept's block.
    assert.equal((await vscode.commands.executeCommand<{ action: string }>('yept.removeLeakHook', foreign))?.action, 'removed');
    assert.equal(await readFile(foreignHook, 'utf8'), theirs);
    assert.deepEqual(errors, []);
  } finally {
    Object.assign(win, original);
  }
}
