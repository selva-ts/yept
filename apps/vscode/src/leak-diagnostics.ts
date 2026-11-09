// The leak check in VS Code: findings in collection files appear as warnings in the Problems panel, and an optional
// pre-commit hook runs the same check on staged files. Git itself stays with VS Code's Source Control.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { Git, runGit } from '@yept/core/engine/git/git';
import { scanForLeaks } from '@yept/core/engine/guard/leak-scan';
import type { Collections } from './collections';
import { CHECKER, findingMessage, findingRange, hasYeptBlock, hookBlock, installHook, isScannedFile, removeHook } from './leak-check';

/** Files larger than this aren't collection files anyone wrote by hand; they are skipped. */
const MAX_BYTES = 5 * 1024 * 1024;
const DEBOUNCE_MS = 400;

export interface LeakScanResult { findings: number; files: number }

async function walk(dir: string, out: Set<string>): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') await walk(path, out); }
    else if (entry.isFile() && isScannedFile(path)) out.add(path);
  }
}

/**
 * Scans each workspace folder's collections and publishes the findings as warnings. Scans run one at a time; a change
 * schedules its folder's scan after a short pause, so a burst of writes is scanned once.
 */
export class LeakDiagnostics implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('yept-leaks');
  /** The files with warnings, per workspace folder, so a deleted file or a closed folder is cleared. */
  private readonly published = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly collections: Collections, private readonly localSecrets: (dirs: string[]) => string[]) {}

  /** Scans a folder soon. */
  schedule(root: string): void {
    clearTimeout(this.timers.get(root));
    this.timers.set(root, setTimeout(() => {
      this.timers.delete(root);
      void this.enqueue(() => this.scan(root));
    }, DEBOUNCE_MS));
  }

  /** Schedules every open folder, and clears folders that have closed. */
  scheduleAll(): void {
    for (const root of this.roots()) this.schedule(root);
  }

  /** Scans every open folder now (after any scan going on) and returns the totals. */
  scanAll(): Promise<LeakScanResult> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    return this.enqueue(async () => {
      const total = { findings: 0, files: 0 };
      for (const root of this.roots()) {
        const r = await this.scan(root);
        total.findings += r.findings;
        total.files += r.files;
      }
      return total;
    });
  }

  private roots(): string[] {
    return [...new Set([...this.collections.snapshots().map((s) => s.root), ...this.published.keys()])];
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.catch((error) => console.error('Yept leak check:', error));
    return result;
  }

  private async scan(root: string): Promise<LeakScanResult> {
    const workspace = this.disposed ? undefined : this.collections.workspace(root);
    const before = this.published.get(root) ?? new Set<string>();
    if (!workspace) {
      for (const uri of before) this.diagnostics.delete(vscode.Uri.parse(uri));
      this.published.delete(root);
      return { findings: 0, files: 0 };
    }
    const dirs = workspace.collectionDirs();
    const paths = new Set<string>();
    for (const dir of dirs) await walk(dir, paths);
    const files: { path: string; text: string }[] = [];
    for (const path of paths) {
      try {
        if ((await fs.stat(path)).size > MAX_BYTES) continue;
        const text = await fs.readFile(path, 'utf8');
        if (!text.includes('\0')) files.push({ path, text });
      } catch { /* removed since the listing */ }
    }
    let secrets: string[] = [];
    try { secrets = this.localSecrets(dirs); } catch { /* without the key, local secrets can't be compared */ }
    const findings = scanForLeaks(files, secrets);
    const lines = new Map(files.map((f) => [f.path, f.text.split(/\r?\n/)]));
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const finding of findings) {
      const line = finding.line - 1;
      const { start, end } = findingRange(lines.get(finding.path)?.[line] ?? '', finding);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, start, line, end), findingMessage(finding), vscode.DiagnosticSeverity.Warning);
      diagnostic.source = 'Yept leak check';
      diagnostic.code = finding.kind;
      byFile.set(finding.path, [...(byFile.get(finding.path) ?? []), diagnostic]);
    }
    // A folder that closed while this scan ran is cleared by the next one; don't publish for it now.
    if (this.disposed || !this.collections.workspace(root)) return { findings: 0, files: 0 };
    const now = new Set<string>();
    for (const [path, list] of byFile) {
      const uri = vscode.Uri.file(path);
      this.diagnostics.set(uri, list);
      now.add(uri.toString());
    }
    for (const uri of before) if (!now.has(uri)) this.diagnostics.delete(vscode.Uri.parse(uri));
    this.published.set(root, now);
    return { findings: findings.length, files: byFile.size };
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.diagnostics.dispose();
  }
}

// ---------- the pre-commit hook ----------

export type HookResult = { action: 'created' | 'updated' | 'added' | 'removed'; hooksDir: string } | undefined;

/** Where Git looks for hooks: core.hooksPath when set (relative to the top of the working tree), else the repository's hooks folder. */
async function hooksDir(root: string): Promise<string> {
  const configured = await runGit(['config', '--get', 'core.hooksPath'], root);
  const value = configured.ok ? configured.stdout.trim() : '';
  if (value) return value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(root, value);
  const r = await runGit(['rev-parse', '--git-path', 'hooks'], root);
  if (!r.ok) throw new Error(`Git couldn't find the hooks folder: ${r.stderr.trim()}`);
  return resolve(root, r.stdout.trim());
}

const readOrUndefined = async (path: string): Promise<string | undefined> => {
  try { return await fs.readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
};

/**
 * The hook commands. Both run Git, which reads the repository's own configuration, so they need a trusted folder.
 * A command's argument (a folder, as a Uri or a path) picks the repository; else the ones holding the open collections.
 */
export function leakHookCommands(collections: Collections, ready: Promise<void>, checker: string, fallbackNode: string): vscode.Disposable[] {
  const git = new Git();
  const repository = async (target: unknown, title: string): Promise<string | undefined> => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Yept: trust this folder (Manage Workspace Trust) to change its Git hooks.');
      return;
    }
    const given = target instanceof vscode.Uri ? target.fsPath : typeof target === 'string' ? target : undefined;
    if (given) {
      const root = await git.repoRoot(given);
      if (!root) void vscode.window.showWarningMessage(`Yept: ${given} is not inside a Git repository.`);
      return root ?? undefined;
    }
    await ready;
    await collections.settled();
    const dirs = collections.snapshots().flatMap((s) => collections.workspace(s.root)?.collectionDirs() ?? []);
    const roots = [...new Set((await Promise.all(dirs.map((d) => git.repoRoot(d)))).filter((r): r is string => !!r))];
    if (!roots.length) {
      void vscode.window.showInformationMessage('Yept: none of the open collections is in a Git repository.');
      return;
    }
    if (roots.length === 1) return roots[0];
    return (await vscode.window.showQuickPick(roots, { title }));
  };

  const install = async (target?: unknown): Promise<HookResult> => {
    const root = await repository(target, 'Yept: Install the Leak Check Hook in');
    if (!root) return;
    const dir = await hooksDir(root);
    const hook = join(dir, 'pre-commit');
    const existing = await readOrUndefined(hook);
    const change = installHook(existing, hookBlock(fallbackNode));
    if (change.action === 'unsupported') {
      void vscode.window.showWarningMessage(`Yept: ${hook} isn't a shell script, so the leak check wasn't added. To add it yourself, have the hook run: node "${join(dir, CHECKER)}"`);
      return;
    }
    if (change.action === 'added') {
      const add = 'Add to Existing Hook';
      const choice = await vscode.window.showWarningMessage('This repository already has a pre-commit hook. Add Yept\'s leak check to it?', {
        modal: true, detail: `${hook}\n\nThe leak check runs first; when it passes, the existing hook runs as before.`
      }, add);
      if (choice !== add) return;
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(checker, join(dir, CHECKER));
    await fs.writeFile(hook, change.text);
    await fs.chmod(hook, 0o755);
    void vscode.window.showInformationMessage(change.action === 'updated'
      ? `Yept: the pre-commit leak check in ${root} is up to date.`
      : `Yept: commits in ${root} are now checked for leaked secrets.`);
    return { action: change.action, hooksDir: dir };
  };

  const remove = async (target?: unknown): Promise<HookResult> => {
    const root = await repository(target, 'Yept: Remove the Leak Check Hook from');
    if (!root) return;
    const dir = await hooksDir(root);
    const hook = join(dir, 'pre-commit');
    const existing = await readOrUndefined(hook);
    if (existing === undefined || !hasYeptBlock(existing)) {
      void vscode.window.showInformationMessage(`Yept: ${root} has no leak check hook.`);
      return;
    }
    const rest = removeHook(existing);
    if (rest === null) await fs.rm(hook, { force: true });
    else await fs.writeFile(hook, rest);
    await fs.rm(join(dir, CHECKER), { force: true });
    void vscode.window.showInformationMessage(`Yept: removed the pre-commit leak check from ${root}.`);
    return { action: 'removed', hooksDir: dir };
  };

  const guard = <T>(fn: (target?: unknown) => Promise<T>) => async (target?: unknown): Promise<T | undefined> => {
    try { return await fn(target); }
    catch (error) { void vscode.window.showErrorMessage(`Yept: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  };
  return [
    vscode.commands.registerCommand('yept.installLeakHook', guard(install)),
    vscode.commands.registerCommand('yept.removeLeakHook', guard(remove))
  ];
}
