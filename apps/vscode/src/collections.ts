import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { access } from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import * as vscode from 'vscode';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import { TEMP_PREFIX } from '@yept/core/engine/fs/atomic-write';
import type { WorkspaceSnapshot } from '@yept/core/shared/model';
import { collectionTree, type CollectionTreeItem } from './collection-tree-model';
import { requestRoots } from './workspace-index';

interface Root {
  folder: vscode.WorkspaceFolder;
  workspace: Workspace;
  snapshot: WorkspaceSnapshot;
  watcher?: FSWatcher;
  watched: string;
  timer?: NodeJS.Timeout;
  pending: Set<string>;
  previous?: Map<string, string>;
  /** True while the workspace reloads: its maps are being rebuilt, so its live snapshot is incomplete. */
  loading?: boolean;
}

/** Deleted collection files (an environment, for now) go to the system trash, so they can be restored. */
export const moveToTrash = async (path: string): Promise<void> => vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true, recursive: true });

export type TreeItem = CollectionTreeItem | { id: string; kind: 'workspace'; name: string; children: CollectionTreeItem[] };

/** Engine workspaces share one identity index, but each is loaded and watched independently. */
export class Collections implements vscode.TreeDataProvider<TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly filesChanged = new vscode.EventEmitter<string>();
  /** A workspace folder's collection files may have changed (on disk, by a save, or the folder opened or closed). */
  readonly onDidChangeFiles = this.filesChanged.event;
  private readonly identity: IdentityStore;
  private readonly roots = new Map<string, Root>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private serial: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(storage: string, private readonly onReload: (root: string, removed: string[], changed: string[], snapshot: WorkspaceSnapshot) => void) {
    this.identity = new IdentityStore(join(storage, 'identity.db'));
    const markers = vscode.workspace.createFileSystemWatcher('**/{opencollection.yml,bruno.json}');
    const marker = (uri: vscode.Uri): void => {
      if (uri.scheme !== 'file') return;
      for (const root of this.roots.values()) {
        const path = relative(root.workspace.root, uri.fsPath);
        if (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) this.queue(root, uri.fsPath);
      }
    };
    this.subscriptions.push(markers, markers.onDidCreate(marker), markers.onDidDelete(marker));
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sync()));
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const result = this.serial.then(fn);
    this.serial = result.catch((error) => console.error('Yept collections:', error));
    return result;
  }

  sync(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
      const current = new Set(folders.map((folder) => folder.uri.toString()));
      for (const [key, root] of this.roots) {
        if (current.has(key)) continue;
        if (root.timer) clearTimeout(root.timer);
        await root.watcher?.close();
        this.roots.delete(key);
        this.onReload(root.workspace.root, [...(root.previous?.keys() ?? root.workspace.liveRequestIds())], [], root.snapshot);
        this.filesChanged.fire(root.workspace.root);
      }
      for (const folder of folders) {
        const key = folder.uri.toString();
        if (this.roots.has(key)) continue;
        const workspace = new Workspace(folder.uri.fsPath, this.identity, { trash: moveToTrash });
        const snapshot = await workspace.load();
        const root: Root = { folder, workspace, snapshot, watched: '', pending: new Set() };
        this.roots.set(key, root);
        await this.watchCollections(root);
        this.filesChanged.fire(root.workspace.root);
      }
      this.refresh();
    });
  }

  private async watchCollections(root: Root): Promise<void> {
    const paths = root.snapshot.collections.map((c) => resolve(root.workspace.root, c.path)).sort();
    const key = JSON.stringify(paths);
    if (root.watched === key) return;
    await root.watcher?.close();
    root.watched = key;
    root.watcher = paths.length ? watch(paths, {
      ignoreInitial: true,
      ignored: (path) => /[\\/](node_modules|\.git)([\\/]|$)/.test(path) || path.includes(TEMP_PREFIX),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    }) : undefined;
    root.watcher?.on('all', (_event, path) => this.queue(root, path));
    root.watcher?.on('error', (error) => console.error('Yept collection watcher:', error));
    // Events between discovery and chokidar becoming ready are reconciled by one additional load.
    root.watcher?.once('ready', () => this.queue(root, root.workspace.root));
  }

  private queue(root: Root, path: string): void {
    if (root.workspace.isOwnWrite(path) || path.includes(TEMP_PREFIX)) return;
    root.pending.add(path);
    if (root.timer) clearTimeout(root.timer);
    root.timer = setTimeout(() => {
      root.timer = undefined;
      void this.enqueue(async () => {
        if (this.disposed || !this.roots.has(root.folder.uri.toString())) return;
        root.pending.clear();
        const before = root.previous ?? new Map([...root.workspace.liveRequestIds()].map((id) => [id, JSON.stringify(root.workspace.getRequest(id))]));
        root.previous = before;
        root.loading = true;
        try {
          try {
            root.snapshot = await root.workspace.load();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            try {
              await access(root.workspace.root);
              this.queue(root, root.workspace.root);
              return;
            } catch (accessError) {
              if ((accessError as NodeJS.ErrnoException).code !== 'ENOENT') throw accessError;
            }
            root.snapshot = { root: root.workspace.root, collections: [], problems: [] };
          }
        } finally {
          root.loading = false;
        }
        const after = root.workspace.liveRequestIds();
        root.previous = undefined;
        await this.watchCollections(root);
        const removed = [...before.keys()].filter((id) => !after.has(id));
        const changed = [...after].filter((id) => before.get(id) !== JSON.stringify(root.workspace.getRequest(id)));
        this.onReload(root.workspace.root, removed, changed, root.snapshot);
        this.refresh();
        this.filesChanged.fire(root.workspace.root);
      });
    }, 300);
  }

  refresh(): void {
    this.changed.fire(undefined);
    const count = this.snapshots().reduce((n, s) => n + s.collections.length, 0);
    void vscode.commands.executeCommand('setContext', 'yept.hasCollections', count > 0);
    void vscode.commands.executeCommand('setContext', 'yept.hasLocalFolder', this.roots.size > 0);
  }

  saved(rootPath: string, changed: string[] = [], removed: string[] = []): void {
    const root = [...this.roots.values()].find((r) => r.workspace.root === rootPath);
    if (root) {
      // A reload going on sets the snapshot itself when it ends.
      if (!root.loading) root.snapshot = root.workspace.snapshot();
      this.refresh();
      if (changed.length || removed.length) this.onReload(rootPath, removed, changed, root.snapshot);
      this.filesChanged.fire(rootPath);
      void this.enqueue(async () => { if (!this.disposed && this.roots.has(root.folder.uri.toString())) await this.watchCollections(root); });
    }
  }

  /**
   * Runs a change that writes collection files and loads the workspace itself (an import), in turn with the watcher's
   * reloads so the two never overlap. Returns the requests it changed or removed, for their panels.
   */
  async exclusive<T>(rootPath: string, change: () => Promise<T>): Promise<{ result: T; changed: string[]; removed: string[] }> {
    let out: { result: T; changed: string[]; removed: string[] } | undefined;
    await this.enqueue(async () => {
      const root = [...this.roots.values()].find((entry) => entry.workspace.root === rootPath);
      if (this.disposed || !root) throw new Error('The selected workspace folder has closed.');
      const workspace = root.workspace;
      const before = new Map([...workspace.liveRequestIds()].map((id) => [id, JSON.stringify(workspace.getRequest(id))]));
      root.loading = true;
      let result: T;
      try { result = await change(); }
      finally {
        root.loading = false;
        root.snapshot = workspace.snapshot();
      }
      const after = workspace.liveRequestIds();
      out = {
        result,
        removed: [...before.keys()].filter((id) => !after.has(id)),
        changed: [...after].filter((id) => before.has(id) && before.get(id) !== JSON.stringify(workspace.getRequest(id)))
      };
      await this.watchCollections(root);
      this.filesChanged.fire(rootPath);
    });
    return out!;
  }

  snapshots(): WorkspaceSnapshot[] { return [...this.roots.values()].map((root) => root.snapshot); }
  settled(): Promise<void> { return this.serial; }
  workspace(root: string): Workspace | undefined { return [...this.roots.values()].find((r) => r.workspace.root === root)?.workspace; }
  /** Windows cannot rename a directory while chokidar holds its watcher handles. */
  async withWatcherPaused<T>(rootPath: string, change: () => Promise<T>): Promise<T> {
    const root = [...this.roots.values()].find((entry) => entry.workspace.root === rootPath);
    if (!root) throw new Error('The selected workspace folder has closed.');
    await root.watcher?.close();
    root.watcher = undefined;
    root.watched = '';
    try { return await change(); }
    finally {
      root.snapshot = root.workspace.snapshot();
      await this.watchCollections(root);
      this.filesChanged.fire(rootPath);
    }
  }
  rootForRequest(id: string): string | undefined { return requestRoots(this.snapshots()).get(id); }
  name(root: string): string | undefined { return [...this.roots.values()].find((r) => r.workspace.root === root)?.folder.name; }

  getTreeItem(item: TreeItem): vscode.TreeItem {
    const collapsible = item.kind === 'request' || item.kind === 'problem' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
    const tree = new vscode.TreeItem(item.name, collapsible);
    tree.id = item.id;
    tree.contextValue = item.kind !== 'workspace' && item.readOnly ? `${item.kind}.readOnly` : item.kind;
    if (item.kind === 'workspace') { tree.iconPath = new vscode.ThemeIcon('root-folder'); return tree; }
    tree.description = [item.method, item.readOnly ? 'read-only' : undefined].filter(Boolean).join(' · ');
    tree.tooltip = item.message ? `${item.path}: ${item.message}` : item.path;
    tree.iconPath = new vscode.ThemeIcon(item.kind === 'problem' ? 'warning' : item.kind === 'collection' ? 'repo' : item.kind === 'folder' ? 'folder' : 'send');
    if (item.requestId) tree.command = { command: 'yept.openRequest', title: 'Open Request', arguments: [item.requestId] };
    return tree;
  }

  getParent(item: TreeItem): TreeItem | undefined {
    const find = (nodes: TreeItem[]): TreeItem | undefined => {
      for (const node of nodes) {
        if (node.children.some((child) => child.id === item.id)) return node;
        const parent = find(node.children);
        if (parent) return parent;
      }
      return undefined;
    };
    return find(this.getChildren());
  }

  getChildren(item?: TreeItem): TreeItem[] {
    if (item) return item.children;
    const roots = [...this.roots.values()];
    if (roots.every((root) => !root.snapshot.collections.length && !root.snapshot.problems.length)) return [];
    if (roots.length === 1 && (vscode.workspace.workspaceFolders?.length ?? 0) === 1) return collectionTree(roots[0].snapshot);
    return roots.map((root) => ({ id: JSON.stringify([root.workspace.root, 'workspace']), kind: 'workspace', name: root.folder.name, children: collectionTree(root.snapshot) }));
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const root of this.roots.values()) { if (root.timer) clearTimeout(root.timer); }
    void this.serial.then(async () => {
      await Promise.all([...this.roots.values()].map((root) => root.watcher?.close()));
      this.identity.close();
      this.changed.dispose();
      this.filesChanged.dispose();
    });
  }
}
