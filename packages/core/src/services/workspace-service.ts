// Owns the open workspace, its identity index and the file watcher, using the host for local paths and trash.
import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import { TEMP_PREFIX } from '@yept/core/engine/fs/atomic-write';
import type { ExternalChange } from '@yept/core/shared/ipc';
import type { WorkspaceSnapshot } from '@yept/core/shared/model';
import type { AppHost } from './host';

interface WorkspacePrefs { lastWorkspace?: string; collectionViewMode?: 'grid' | 'list' }

async function readPrefs(file: string): Promise<WorkspacePrefs> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writePrefs(file: string, prefs: WorkspacePrefs): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(prefs, null, 2));
}

export class WorkspaceService {
  private identity: IdentityStore | null = null;
  private ws: Workspace | null = null;
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private debounce: NodeJS.Timeout | null = null;
  private reloading: Promise<void> = Promise.resolve();
  /** Git operations in progress: watcher reloads wait, so renames are matched before anything reloads. */
  private held = 0;

  constructor(private host: Pick<AppHost, 'userDataPath' | 'trash'>, private onExternalChange: (change: ExternalChange) => void) {}

  private prefsFile(): string {
    return join(this.host.userDataPath(), 'preferences.json');
  }

  get workspace(): Workspace {
    if (!this.ws) throw new Error('No workspace is open');
    return this.ws;
  }

  async getViewMode(): Promise<'grid' | 'list'> {
    return (await readPrefs(this.prefsFile())).collectionViewMode === 'list' ? 'list' : 'grid';
  }

  async setViewMode(mode: 'grid' | 'list'): Promise<void> {
    if (mode !== 'grid' && mode !== 'list') throw new Error('Invalid collection view');
    await writePrefs(this.prefsFile(), { ...(await readPrefs(this.prefsFile())), collectionViewMode: mode });
  }

  async open(root: string): Promise<WorkspaceSnapshot> {
    await this.close();
    this.identity ??= new IdentityStore(join(this.host.userDataPath(), 'identity.db'));
    this.ws = new Workspace(root, this.identity, { trash: (p) => this.host.trash(p) });
    const snapshot = await this.ws.load();
    this.startWatching(root);
    await writePrefs(this.prefsFile(), { ...(await readPrefs(this.prefsFile())), lastWorkspace: root });
    return snapshot;
  }

  async restore(): Promise<WorkspaceSnapshot | null> {
    const { lastWorkspace } = await readPrefs(this.prefsFile());
    if (!lastWorkspace) return null;
    try {
      await fs.access(lastWorkspace);
    } catch {
      return null;
    }
    return this.open(lastWorkspace);
  }

  private startWatching(root: string): void {
    this.watcher = watch(root, {
      ignoreInitial: true,
      ignored: (p) => /[\\/](node_modules|\.git)([\\/]|$)/.test(p) || p.includes(TEMP_PREFIX),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    });
    this.watcher.on('all', (_event, path) => {
      if (this.ws?.isOwnWrite(path)) return;
      this.pending.add(path);
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.flush(), 300);
    });
  }

  private async flush(): Promise<void> {
    if (this.held) return;
    return this.reload(false);
  }

  /** Runs a Git operation with watcher reloads held back; changes seen meanwhile are reloaded afterwards. */
  async duringGit<T>(fn: () => Promise<T>): Promise<T> {
    this.held++;
    try {
      return await fn();
    } finally {
      this.held--;
      if (!this.held && this.pending.size) {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.flush(), 300);
      }
    }
  }

  /** Reload after Git even when it only changes HEAD or removes an entire collection. */
  async refreshAfterGit(): Promise<void> {
    return this.reload(true);
  }

  /**
   * Runs a change to the workspace after any reload in progress, and holds later reloads until it is done. A reload
   * rebuilds the collection maps, so a change made halfway through would not find its collection or request.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.reloading.then(fn);
    this.reloading = task.then(() => {}, () => {});
    return task;
  }

  private reload(all: boolean): Promise<void> {
    const task = this.reloading.then(() => this.reloadNow(all));
    this.reloading = task.catch(() => {});
    return task;
  }

  private async reloadNow(all: boolean): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    const paths = [...this.pending];
    this.pending.clear();
    const previous = new Map([...ws.liveRequestIds()].map((id) => [id, JSON.stringify(ws.getRequest(id))]));
    const before = new Map(paths.map((p) => [p, ws.requestIdForFile(p)]));
    const snapshot = await ws.load();
    const changed = new Set<string>();
    const removed = new Set<string>();
    if (all) {
      for (const id of ws.liveRequestIds()) if (previous.get(id) !== JSON.stringify(ws.getRequest(id))) changed.add(id);
      for (const id of previous.keys()) if (!ws.liveRequestIds().has(id)) removed.add(id);
    }
    const live = ws.liveRequestIds();
    for (const p of paths) {
      const now = ws.requestIdForFile(p);
      const was = before.get(p);
      if (now) changed.add(now);
      // A request whose file moved (renamed outside the app, or a rename Git reported) keeps its id: it changed.
      else if (was) (live.has(was) ? changed : removed).add(was);
    }
    if (this.ws === ws) this.onExternalChange({ snapshot, changedRequestIds: [...changed], removedRequestIds: [...removed] });
  }

  async dispose(): Promise<void> {
    await this.close();
    this.identity?.close();
    this.identity = null;
  }

  async close(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    await this.watcher?.close();
    await this.reloading;
    this.watcher = null;
    this.pending.clear();
    this.ws = null;
  }
}
