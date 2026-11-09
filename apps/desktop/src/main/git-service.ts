// The Git panel's backend: which repositories hold the open collections, what changed, and commit/push with the
// leak check in front.
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Git, canonical, type GitActionResult, type GitFile } from '@yept/core/engine/git/git';
import { scanForLeaks, type LeakFinding } from '@yept/core/engine/guard/leak-scan';
import type { Workspace } from '@yept/core/engine/workspace/workspace';
import type { EnvService } from '@yept/core/services/env-service';
import type { GitCommitResult, GitPushResult, GitRepoStatus } from '@yept/core/shared/ipc';

export class GitService {
  private git = new Git();
  private busy = new Set<string>();
  private knownRepos = new Map<string, string[]>();
  private workspace: Workspace | null = null;

  constructor(
    private ws: () => Workspace,
    private env: EnvService,
    private trash: (path: string) => Promise<void>,
    private changed: () => Promise<void>,
    /** Holds back watcher reloads while a Git operation runs. */
    private hold: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()
  ) {}

  /** Repositories containing the workspace's collections, with the collection folders inside each. */
  private async repos(): Promise<Map<string, string[]>> {
    const ws = this.ws();
    if (this.workspace !== ws) { this.workspace = ws; this.knownRepos.clear(); }
    const byRoot = new Map(this.knownRepos);
    for (const dir of this.ws().collectionDirs()) {
      const root = await this.git.repoRoot(dir);
      if (!root) continue;
      byRoot.set(root, [...new Set([...(byRoot.get(root) ?? []), canonical(dir)])]);
    }
    // A workspace folder that is itself a repository still gets the panel (branch, fetch, pull, push) before it holds any collection.
    if (!this.ws().collectionDirs().length) {
      const root = await this.git.repoRoot(this.ws().root);
      if (root && !byRoot.has(root)) byRoot.set(root, []);
    }
    this.knownRepos = byRoot;
    return byRoot;
  }

  private async scope(root: string): Promise<{ root: string; dirs: string[] }> {
    const same = (p: string): string => process.platform === 'win32' ? canonical(p).toLowerCase() : canonical(p);
    for (const [r, dirs] of await this.repos()) if (same(r) === same(root)) return { root: r, dirs };
    throw new Error('This repository does not contain collections from the open workspace.');
  }

  private async selected(root: string, files: GitFile[]): Promise<GitFile[]> {
    const { dirs } = await this.scope(root);
    if (!Array.isArray(files) || !files.length) throw new Error('Select at least one changed file.');
    const current = await this.git.status(root, dirs);
    const within = (path: string): boolean => {
      if (typeof path !== 'string' || path.includes('\\') || isAbsolute(path) || path.split('/').includes('..')) return false;
      const full = canonical(join(root, path));
      return dirs.some((d) => { const rel = relative(canonical(d), full); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); });
    };
    return [...new Set(files.map((f) => f.path))].map((path) => {
      const file = current.find((f) => f.path === path);
      if (!file || !within(file.path) || (file.from && !within(file.from))) throw new Error('The selected files changed or are outside the collections. Refresh and select them again.');
      return file;
    });
  }

  private async exclusive<T>(root: string, fn: (root: string) => Promise<T>): Promise<T> {
    const scope = await this.scope(root);
    if (this.busy.has(scope.root)) throw new Error('Another Git operation is running for this repository. Wait for it to finish.');
    this.busy.add(scope.root);
    try { return await fn(scope.root); } finally { this.busy.delete(scope.root); }
  }

  private view(r: GitActionResult): GitPushResult {
    return { ok: r.result.ok, needsUpstream: r.needsUpstream, explanation: r.explanation, output: `${r.result.stdout}${r.result.stderr}`.trim() };
  }

  /**
   * Runs a Git action that may change collection files, then reloads the workspace. A failed reload is added to the
   * result; it never replaces the Git result or error (the files on disk changed either way).
   * When HEAD moved (pull, Sync, branch switch), request files Git sees as renamed keep their identity first, so their
   * history and open tabs follow them. Ambiguous renames stay unmatched.
   */
  private async thenReload(root: string, run: () => Promise<GitPushResult>): Promise<GitPushResult> {
    return this.hold(async () => {
      const before = await this.git.head(root).catch(() => null);
      let outcome: { value: GitPushResult } | { error: unknown };
      try { outcome = { value: await run() }; } catch (error) { outcome = { error }; }
      let renamed = '';
      try {
        const after = before && (await this.git.head(root));
        if (before && after && after !== before) {
          const { dirs } = await this.scope(root);
          const followed = this.ws().followRenames(root, await this.git.renames(root, before, after, dirs));
          if (followed.length) renamed = [`History kept for ${followed.length} renamed request${followed.length > 1 ? 's' : ''}:`, ...followed.map((f) => `  ${f.from} → ${f.to}`)].join('\n');
        }
      } catch {
        // Matching renames is a convenience: content fingerprints still re-match unchanged requests on reload.
      }
      let reloadError = '';
      try { await this.changed(); } catch (e) { reloadError = `Yept could not reload the collections afterwards (${e instanceof Error ? e.message : String(e)}). Use Refresh.`; }
      if ('error' in outcome) throw outcome.error;
      const notes = [renamed, reloadError].filter(Boolean);
      return notes.length ? { ...outcome.value, output: [outcome.value.output, ...notes].filter(Boolean).join('\n\n') } : outcome.value;
    });
  }

  async action(root: string, action: 'fetch' | 'pull' | 'sync' | 'switch' | 'create', branch?: string): Promise<GitPushResult> {
    return this.exclusive(root, async (r) => {
      const run = async (): Promise<GitPushResult> => this.view(await (action === 'switch' ? this.git.switchBranch(r, branch ?? '')
        : action === 'create' ? this.git.createBranch(r, branch ?? '') : this.git[action](r)));
      return action === 'fetch' ? run() : this.thenReload(r, run);
    });
  }

  async files(root: string, action: 'stage' | 'unstage' | 'discard', files: GitFile[]): Promise<GitPushResult> {
    return this.exclusive(root, async (r) => {
      const current = await this.selected(r, files);
      const selected = action === 'unstage' ? current.filter((f) => f.staged) : current;
      if (!selected.length) throw new Error('None of the selected files are staged.');
      if (action === 'discard') return this.thenReload(r, async () => this.view(await this.git.discard(r, selected, this.trash)));
      return this.view(await this.git[action](r, selected));
    });
  }

  async status(): Promise<{ repos: GitRepoStatus[]; collectionsOutsideGit: string[] }> {
    const repos = await this.repos();
    const inRepo = new Set([...repos.values()].flat().map((d) => d.toLowerCase()));
    const outside = this.ws()
      .collectionDirs()
      .filter((d) => !inRepo.has(canonical(d).toLowerCase()))
      .map((d) => relative(this.ws().root, d) || d);
    const out: GitRepoStatus[] = [];
    for (const [root, dirs] of repos) out.push({ ...(await this.git.info(root)),
      collectionPaths: dirs.map((dir) => relative(canonical(this.ws().root), canonical(dir)).split(sep).join('/')),
      files: await this.git.status(root, dirs) });
    return { repos: out, collectionsOutsideGit: outside };
  }

  async diff(root: string, file: GitFile): Promise<{ before: string; after: string }> {
    const scope = await this.scope(root);
    const [selected] = await this.selected(scope.root, [file]);
    return this.git.diffTexts(scope.root, selected);
  }

  /** Scans the selected files first; any finding blocks the commit unless the user typed the file name to confirm. */
  async commit(root: string, files: GitFile[], message: string, overrideLeaksFor?: string): Promise<GitCommitResult> {
    return this.exclusive(root, async (root) => {
      files = await this.selected(root, files);
      const leaks = await this.scan(root, files);
      // Committing anyway needs the user to type the first flagged file's name.
      if (leaks.length && overrideLeaksFor !== leaks[0].path.split('/').pop()) return { ok: false, leaks };
      const r = await this.git.commit(root, files, message);
      return { ok: r.result.ok, hash: r.hash, explanation: r.explanation, output: `${r.result.stdout}${r.result.stderr}`.trim(), leaks: leaks.length ? leaks : undefined };
    });
  }

  async push(root: string, setUpstream: boolean): Promise<GitPushResult> {
    return this.exclusive(root, async (r) => this.view(await this.git.push(r, setUpstream)));
  }

  private async scan(root: string, files: GitFile[]): Promise<LeakFinding[]> {
    const texts: { path: string; text: string }[] = [];
    for (const f of files) {
      if (f.kind === 'deleted') continue;
      try {
        texts.push({ path: f.path, text: await fs.readFile(join(root, ...f.path.split('/')), 'utf8') });
      } catch {
        /* vanished since status: Git will report it */
      }
    }
    return scanForLeaks(texts, this.env.allSecretValues(this.ws().collectionDirs()));
  }
}

