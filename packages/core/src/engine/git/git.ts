// Git through the installed git executable: argument arrays (no shell), no terminal prompts,
// the user's own credential helper (e.g. Git Credential Manager for Azure DevOps and GitHub).
// Pulls are fast-forward only, branch switches require a clean repository, and discard is scoped to selected files.
// Never force-push, reset, stash, clean, rebase or create merge commits.
import { execFile } from 'node:child_process';
import { promises as fs, realpathSync, existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type { GitFile } from '../../shared/model';
import type { GitFile } from '../../shared/model';

export interface GitInfo {
  root: string;
  branch: string | null;
  /** e.g. 'origin/feat/x', or null when the branch has no upstream. */
  upstream: string | null;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  dirty: boolean;
  blockedReason: string | null;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<GitResult>;
}

export interface GitActionResult { result: GitResult; explanation?: string; needsUpstream?: boolean }

/** A file Git's rename detection paired across two commits. Paths are relative to the repository root, with '/'. */
export interface GitRename { from: string; to: string }
const refused = (explanation: string): GitActionResult => ({ result: { ok: false, code: 1, stdout: '', stderr: explanation }, explanation });
const success = (): GitActionResult => ({ result: { ok: true, code: 0, stdout: '', stderr: '' } });

/** Runs git; never throws for a non-zero exit (the caller shows Git's own output). */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const timeout = gitTimeoutMs(args);
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') resolve({ ok: false, code: 127, stdout: '', stderr: 'Git is not installed or not on PATH.' });
        else if (err && (err as { killed?: boolean }).killed) resolve({ ok: false, code: GIT_TIMED_OUT, stdout: String(stdout), stderr: `${stderr}\nStopped after ${timeout / 60_000} minutes.`.trim() });
        else resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });

/** Exit code used when Yept stops a Git command that ran too long (as the `timeout` tool does). */
export const GIT_TIMED_OUT = 124;

/**
 * Commands that talk to a remote may wait for Git Credential Manager's sign-in window, so they get much longer
 * than local ones. The limit only stops a Git process that is stuck.
 */
export function gitTimeoutMs(args: string[]): number {
  const command = args.find((a) => !a.startsWith('-'));
  return command === 'fetch' || command === 'pull' || command === 'push' ? 15 * 60_000 : 2 * 60_000;
}

const toPosix = (p: string): string => p.split(sep).join('/');

/** Long, canonical form of a path (Windows short 8.3 names like PROGRA~1 are expanded), so paths compare reliably. */
export function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Turns Git's error output into a plain sentence, keeping Git's own text for the log. */
export function explainGitError(r: GitResult, action: 'commit' | 'push' | 'status' | 'fetch' | 'pull' | 'switch' | 'stage' | 'unstage' | 'discard'): string {
  const e = `${r.stderr}\n${r.stdout}`;
  if (r.code === 127) return 'Git is not installed or not on PATH. Install Git for Windows and restart Yept.';
  if (r.code === GIT_TIMED_OUT) return `Git ${action} took too long and was stopped. If a sign-in window is open, finish signing in, then try again.`;
  if (/not a git repository/i.test(e)) return 'This folder is not inside a Git repository.';
  if (/Not possible to fast-forward|divergent branches|cannot fast-forward/i.test(e)) return 'This branch and its upstream have diverged. Resolve this with your usual Git tool, then refresh Yept. No merge or rebase was attempted.';
  if (/would be overwritten|Please commit your changes|local changes.*overwritten/is.test(e)) return 'Local changes would be overwritten. Commit or discard them first, then try again.';
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(e)) return 'The remote has commits you don\'t have yet. Use Pull or Sync to fetch them. If the branches have diverged, use your usual Git tool. Yept never force-pushes.';
  if (/index.lock|another git process/i.test(e)) return 'Another Git operation is using this repository. Wait for it to finish, then refresh.';
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|Permission denied|access denied/i.test(e)) return 'Git could not sign in to the remote. Sign in once with your usual Git tool (Git Credential Manager), then try again.';
  if (/Could not resolve host|unable to access|Connection timed out|Failed to connect/i.test(e)) return 'Git could not reach the remote. Check the network or VPN.';
  if (/pre-commit hook|hook .* failed|husky/i.test(e) && action === 'commit') return 'A Git hook rejected the commit. See the output below.';
  if (/nothing to commit|no changes added/i.test(e)) return 'There is nothing to commit for the selected files.';
  if (/Please tell me who you are|user\.email/i.test(e)) return 'Git doesn\'t know your name and email yet. Set them with git config user.name / user.email.';
  if (/has no upstream branch/i.test(e)) return 'This branch has no upstream yet.';
  return `Git ${action} failed (exit ${r.code}). See the output below.`;
}

export class Git {
  constructor(private run: GitRunner = runGit) {}

  async repoRoot(dir: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--show-toplevel'], dir);
    return r.ok ? canonical(r.stdout.trim().replace(/\//g, sep)) : null;
  }

  /** The commit HEAD points at, or null when there is none yet. */
  async head(root: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root);
    return r.ok ? r.stdout.trim() || null : null;
  }

  /**
   * Files renamed between two commits under the given folders (`git diff --find-renames`). A rename is left out when
   * Git had to choose between identical files: another deleted or renamed file had the same content as its source, or
   * another added or renamed file the same content as its target. Those stay unmatched rather than guessed.
   */
  async renames(root: string, from: string, to: string, dirs: string[]): Promise<GitRename[]> {
    if (!dirs.length || from === to) return [];
    const paths = dirs.map((d) => toPosix(relative(canonical(root), canonical(d))) || '.');
    const r = await this.run(['--literal-pathspecs', 'diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', from, to, '--', ...paths], root);
    if (!r.ok) return [];
    // -z raw records: ":<mode> <mode> <blob> <blob> <status>\0<path>\0" plus "\0<new path>" for renames and copies.
    const parts = r.stdout.split('\0');
    const renames: (GitRename & { fromBlob: string; toBlob: string })[] = [];
    const sources: string[] = [];
    const targets: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const head = parts[i];
      if (!head.startsWith(':')) continue;
      const [, , fromBlob, toBlob, status] = head.slice(1).split(' ');
      const kind = status?.[0];
      if (kind === 'R' || kind === 'C') {
        const pair = { from: parts[i + 1], to: parts[i + 2], fromBlob, toBlob };
        i += 2;
        if (kind === 'R') renames.push(pair);
        sources.push(fromBlob);
        targets.push(toBlob);
      } else {
        i += 1;
        if (kind === 'D') sources.push(fromBlob);
        if (kind === 'A') targets.push(toBlob);
      }
    }
    const count = (list: string[], blob: string): number => list.filter((b) => b === blob).length;
    return renames.filter((p) => count(sources, p.fromBlob) === 1 && count(targets, p.toBlob) === 1).map(({ from, to }) => ({ from, to }));
  }

  async info(root: string): Promise<GitInfo> {
    const [b, u, url, branches, state, gitDir] = await Promise.all([
      this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
      this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root),
      this.run(['remote', 'get-url', 'origin'], root),
      this.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root),
      this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all'], root),
      this.run(['rev-parse', '--absolute-git-dir'], root)
    ]);
    const branch = b.ok ? b.stdout.trim() : null;
    const upstream = u.ok ? u.stdout.trim() : null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const c = await this.run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], root);
      if (c.ok) [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
    }
    if (!state.ok) throw new Error(explainGitError(state, 'status'));
    const pending = gitDir.ok && ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].some((p) => existsSync(join(gitDir.stdout.trim(), p)));
    return { root, branch, upstream, remoteUrl: url.ok ? url.stdout.trim() : null, ahead, behind,
      branches: branches.ok ? branches.stdout.trim().split('\n').filter(Boolean) : [], dirty: !!state.stdout,
      blockedReason: pending ? 'A merge, rebase or other Git operation is in progress. Finish it with your usual Git tool, then refresh.' : null };
  }

  /** Changed files under the given folders (collection folders), parsed from porcelain v2. */
  async status(root: string, dirs: string[]): Promise<GitFile[]> {
    if (!dirs.length) return []; // no collection folders: without a pathspec Git would report the whole repository
    const paths = dirs.map((d) => toPosix(relative(canonical(root), canonical(d))) || '.');
    const r = await this.run(['--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...paths], root);
    if (!r.ok) throw new Error(explainGitError(r, 'status'));
    const out: GitFile[] = [];
    const parts = r.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith('? ')) {
        out.push({ path: line.slice(2), code: '??', kind: 'untracked', staged: false });
      } else if (line.startsWith('1 ')) {
        const f = line.split(' ');
        const code = f[1];
        const path = f.slice(8).join(' ');
        out.push({ path, code, kind: code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified', staged: code[0] !== '.' });
      } else if (line.startsWith('u ')) {
        const f = line.split(' ');
        out.push({ path: f.slice(10).join(' '), code: f[1], kind: 'conflicted', staged: false });
      } else if (line.startsWith('2 ')) {
        const f = line.split(' ');
        const code = f[1];
        const path = f.slice(9).join(' ');
        const from = parts[++i];
        out.push({ path, from, code, kind: 'renamed', staged: code[0] !== '.' });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Existing local branches only; never carries work across branches or creates a tracking branch implicitly. */
  async switchBranch(root: string, branch: string): Promise<GitActionResult> {
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    if (info.dirty) return refused('Branch switching needs a clean repository, including files outside the collections. Commit or discard changes first.');
    if (!info.branches.includes(branch)) return refused('Choose an existing local branch. Create or track other branches with your usual Git tool.');
    const r = await this.run(['switch', '--no-guess', '--no-overwrite-ignore', '--', branch], root);
    return { result: r, explanation: r.ok ? undefined : explainGitError(r, 'switch') };
  }

  /** Creates a branch from the current commit and switches to it, on a clean repository only (like switching). */
  async createBranch(root: string, name: string): Promise<GitActionResult> {
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    if (info.dirty) return refused('Creating a branch needs a clean repository, including files outside the collections. Commit or discard changes first.');
    const branch = name.trim();
    if (!branch) return refused('Enter a branch name.');
    if (info.branches.includes(branch)) return refused(`A branch named "${branch}" already exists. Switch to it instead.`);
    const valid = await this.run(['check-ref-format', '--branch', branch], root);
    if (!valid.ok) return refused(`"${branch}" is not a valid branch name. Avoid spaces, ~ ^ : ? * [ \\ and a leading dash or dot.`);
    const r = await this.run(['switch', '-c', branch], root);
    return { result: r, explanation: r.ok ? undefined : explainGitError(r, 'switch') };
  }

  private async upstreamTarget(root: string): Promise<{ remote: string; ref: string } | null> {
    const { branch } = await this.info(root);
    if (!branch) return null;
    const [remote, ref] = await Promise.all([
      this.run(['config', '--get', `branch.${branch}.remote`], root),
      this.run(['config', '--get', `branch.${branch}.merge`], root)
    ]);
    return remote.ok && ref.ok ? { remote: remote.stdout.trim(), ref: ref.stdout.trim() } : null;
  }

  async fetch(root: string): Promise<GitActionResult> {
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    const target = await this.upstreamTarget(root);
    if (!target) return refused('This branch has no upstream. Push and set an upstream first, or configure one with your usual Git tool.');
    const r = await this.run(['fetch', '--', target.remote], root);
    return { result: r, explanation: r.ok ? undefined : explainGitError(r, 'fetch') };
  }

  async pull(root: string): Promise<GitActionResult> {
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    if (!info.branch) return refused('HEAD is detached. Switch to a local branch before pulling.');
    const target = await this.upstreamTarget(root);
    if (!target) return refused('This branch has no upstream. Push and set an upstream first, or configure one with your usual Git tool.');
    // Explicit flags override repository preferences for rebase and automatic stashing.
    const r = await this.run(['pull', '--ff-only', '--no-rebase', '--no-autostash', '--', target.remote, target.ref], root);
    return { result: r, explanation: r.ok ? undefined : explainGitError(r, 'pull') };
  }

  async sync(root: string): Promise<GitActionResult> {
    const output: string[] = [];
    for (const [label, action] of [['Fetch', () => this.fetch(root)], ['Pull (fast-forward only)', () => this.pull(root)], ['Push', () => this.push(root)]] as const) {
      const r = await action();
      output.push(`${label}\n${r.result.stdout}${r.result.stderr}`.trim());
      if (!r.result.ok) return { ...r, result: { ...r.result, stdout: output.join('\n\n'), stderr: '' } };
    }
    return { result: { ok: true, code: 0, stdout: output.join('\n\n'), stderr: '' } };
  }

  private paths(files: GitFile[]): string[] {
    if (!files.length) throw new Error('Select at least one changed file');
    if (files.some((f) => f.kind === 'conflicted')) throw new Error('Resolve conflicted files with your usual Git tool first.');
    const paths = [...new Set(files.flatMap((f) => f.from ? [f.from, f.path] : [f.path]))];
    if (paths.some((p) => !p || isAbsolute(p) || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '.git') || p.startsWith(':'))) throw new Error('Invalid repository-relative file path');
    return paths;
  }

  async stage(root: string, files: GitFile[]): Promise<GitActionResult> {
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    // A rename is only reported once it's staged, so its old path is already gone from the index and the
    // working tree; `git add` would reject it. Staging the new path picks up any later edits.
    const r = await this.run(['--literal-pathspecs', 'add', '--', ...this.paths(files.map((f) => ({ ...f, from: undefined })))], root);
    return { result: r, explanation: r.ok ? undefined : explainGitError(r, 'stage') };
  }

  async unstage(root: string, files: GitFile[]): Promise<GitActionResult> {
    const paths = this.paths(files);
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    const head = await this.run(['rev-parse', '--verify', 'HEAD'], root);
    const r = await this.run(head.ok ? ['--literal-pathspecs', 'restore', '--staged', '--', ...paths] : ['--literal-pathspecs', 'rm', '--cached', '--', ...paths], root);
    return { result: r, explanation: r.ok ? undefined : explainGitError(r, 'unstage') };
  }

  /** Caller confirms first. New files go to the OS trash; tracked changes (index and worktree) return to HEAD. */
  async discard(root: string, files: GitFile[], trash: (path: string) => Promise<void>): Promise<GitActionResult> {
    const paths = this.paths(files);
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    const tree = await this.run(['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths], root);
    const existing = new Set(tree.ok ? tree.stdout.split('\0').filter(Boolean) : []);
    if (!tree.ok && (await this.run(['rev-parse', '--verify', 'HEAD'], root)).ok) return { result: tree, explanation: explainGitError(tree, 'discard') };
    const added = paths.filter((p) => !existing.has(p));
    // Trash new files first, so an OS failure never silently deletes them.
    for (const p of added) {
      try { await fs.lstat(join(root, p)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      await trash(join(root, p));
    }
    if (files.some((f) => f.staged)) {
      const r = await this.unstage(root, files.filter((f) => f.staged));
      if (!r.result.ok) return r;
    }
    if (existing.size) {
      const r = await this.run(['--literal-pathspecs', 'restore', '--source=HEAD', '--worktree', '--', ...existing], root);
      return { result: r, explanation: r.ok ? undefined : explainGitError(r, 'discard') };
    }
    return success();
  }

  /** The committed (HEAD) and working-tree versions of a file, for a side-by-side diff. */
  async diffTexts(root: string, file: GitFile): Promise<{ before: string; after: string }> {
    const head = file.kind === 'untracked' || file.kind === 'added' ? null : await this.run(['show', `HEAD:${file.from ?? file.path}`], root);
    const before = head?.ok ? head.stdout : '';
    let after = '';
    if (file.kind !== 'deleted') {
      try {
        after = await fs.readFile(join(root, file.path), 'utf8');
      } catch {
        after = '';
      }
    }
    return { before, after };
  }

  /**
   * Commits exactly the selected paths (their working-tree content), leaving any other staged changes staged:
   * `git add` for new files, then `git commit --only -- <paths>`. Hooks run as usual.
   */
  async commit(root: string, files: GitFile[], message: string): Promise<{ result: GitResult; hash?: string; explanation?: string }> {
    if (!files.length) throw new Error('Select at least one file to commit');
    if (!message.trim()) throw new Error('Write a commit message');
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    this.paths(files);
    const untracked = files.filter((f) => f.kind === 'untracked').map((f) => f.path);
    if (untracked.length) {
      const add = await this.run(['--literal-pathspecs', 'add', '--', ...untracked], root);
      if (!add.ok) return { result: add, explanation: explainGitError(add, 'commit') };
    }
    const paths = [...new Set(files.flatMap((f) => (f.from ? [f.from, f.path] : [f.path])))];
    const r = await this.run(['--literal-pathspecs', 'commit', '--only', '-m', message, '--', ...paths], root);
    if (!r.ok) {
      let explanation = explainGitError(r, 'commit');
      // Git doesn't say "hook" when one fails; it just shows the hook's output. Mention it when the repo has one.
      const hooks = await this.commitHooks(root);
      if (hooks.length && explanation.startsWith('Git commit failed')) explanation = `A Git hook (${hooks.join(', ')}) rejected the commit. See its output below.`;
      return { result: r, explanation };
    }
    const h = await this.run(['rev-parse', '--short', 'HEAD'], root);
    return { result: r, hash: h.ok ? h.stdout.trim() : undefined };
  }

  private async commitHooks(root: string): Promise<string[]> {
    const r = await this.run(['rev-parse', '--git-path', 'hooks'], root);
    if (!r.ok) return [];
    const dir = join(root, r.stdout.trim());
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => ['pre-commit', 'commit-msg', 'prepare-commit-msg'].includes(f));
  }

  /** Pushes the current branch to its upstream, or sets one on origin when `setUpstream` is true. Never forces. */
  async push(root: string, setUpstream = false): Promise<{ result: GitResult; explanation?: string; needsUpstream?: boolean }> {
    const info = await this.info(root);
    if (info.blockedReason) return refused(info.blockedReason);
    if (!info.branch) throw new Error('HEAD is detached: check out a branch with your Git tool first');
    let args: string[];
    if (info.upstream) {
      const target = await this.upstreamTarget(root);
      if (!target) return refused('The upstream configuration has changed. Refresh and try again.');
      args = ['push', '--', target.remote, `HEAD:${target.ref}`];
    } else if (setUpstream) {
      args = ['push', '-u', 'origin', info.branch];
    } else {
      return { result: { ok: false, code: 0, stdout: '', stderr: '' }, needsUpstream: true, explanation: `"${info.branch}" has no upstream yet. Push it to origin and set the upstream?` };
    }
    const r = await this.run(args, root);
    return r.ok ? { result: r } : { result: r, explanation: explainGitError(r, 'push') };
  }
}
