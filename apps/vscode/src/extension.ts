import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import type { EnvironmentList } from '@yept/core/shared/ipc';
import { HandlerRegistry } from '@yept/core/shared/handler-registry';
import type { AppSettings, RequestDoc } from '@yept/core/shared/model';
import type { RunnerEvent } from '@yept/core/shared/collection-run';
import { runDiagnostics } from './diagnostics';
import { createLocalStores, createRequestServices } from './handlers';
import { createHost } from './host';
import { keyCipher, loadKey, unavailableCipher } from './cipher';
import { remoteNotice } from './remote';
import { pageHtml, panelHtml } from './panel';
import { checkPanelState, panelTitle } from './panel-state';
import { requestChoices } from './request-choices';
import { bindWebview, extendRegistry, type WebviewBinding } from './webview-binding';
import { DEV_TOOLS_VIEW, DevToolsView } from './devtools-view';
import { checkRunnerState, runnerProgress, type RunnerState } from './page-reports';
import { Collections, moveToTrash, type TreeItem } from './collections';
import { collectionActions, CollectionDragAndDropController } from './collection-actions';
import { HistoryView, type HistoryNode } from './history-view';
import { BODY_SCHEME, bodyLanguage, bodyPath, runIdOf } from './body-document';
import { LeakDiagnostics, leakHookCommands } from './leak-diagnostics';

/** What the extension tests reach into. Returned only when VS Code runs the extension for its tests. */
export interface TestApi {
  collections: Collections;
  dragAndDropController: CollectionDragAndDropController;
  ready: Promise<void>;
  services: Map<string, ReturnType<typeof createRequestServices>>;
  /** The status bar text, or undefined while it is hidden. */
  environmentStatus: () => string | undefined;
  /** The extension's local data folder. */
  storage: string;
  /** The settings the services use now. */
  settings: () => AppSettings;
  /** The open request panels. */
  panels: () => { requestId: string; title: string; dirty: boolean; viewing: string | null; reports: number; panel: vscode.WebviewPanel }[];
  /** The History view. */
  history: HistoryView;
  /** Answers the save prompt shown when a panel with unsaved changes is closed (null: ask for real). */
  answerClosePrompts: (answer: CloseAnswer | undefined | null) => void;
  /** Handles a message as if the page in `panel` had posted it (the page's own messages also arrive). */
  panelMessage: (panel: vscode.WebviewPanel, message: unknown) => void;
  /** The collection runner panel and what its page last reported, if it is open. */
  runner: () => { root: string; panel: vscode.WebviewPanel; state: RunnerState | undefined } | undefined;
  /** The Dev Tools view: whether it has loaded, and what its page holds. */
  devtools: () => ReturnType<DevToolsView['state']>;
  /** The status bar text of a collection run while its panel is hidden, or undefined. */
  runnerStatus: () => string | undefined;
  /** The items selected in the Collections tree. */
  treeSelection: () => readonly TreeItem[];
}

export type CloseAnswer = 'save' | 'discard' | 'cancel';

/** One panel: a request (or, with no request, a folder's environment editor) and what its page last reported. */
interface RequestPanel {
  key: string;
  root: string;
  requestId: string;
  collectionId: string | undefined;
  panel: vscode.WebviewPanel;
  binding: WebviewBinding;
  name: string;
  dirty: boolean;
  draft: RequestDoc | null;
  /** The past run the page shows, if any. */
  viewing: string | null;
  /** How many states the page has reported. */
  reports: number;
}

/** The collection runner panel: one at a time, for one workspace folder. */
interface RunnerPanel {
  root: string;
  panel: vscode.WebviewPanel;
  binding: WebviewBinding;
  state: RunnerState | undefined;
}

interface CollectionChoice extends vscode.QuickPickItem {
  root: string;
  collectionId: string;
}

/** Commands answer with the notice in a remote window, where the extension doesn't run its features. */
const COMMANDS = ['yept.open', 'yept.openRequest', 'yept.history.open', 'yept.history.restore', 'yept.diagnostics', 'yept.newRequest', 'yept.newFolder', 'yept.rename', 'yept.duplicate', 'yept.delete', 'yept.newCollection', 'yept.openCollection', 'yept.importCollection', 'yept.exportCollection', 'yept.pasteCurl', 'yept.selectEnvironment', 'yept.manageEnvironments', 'yept.runCollection', 'yept.runFolder', 'yept.showRunner', 'yept.showDevTools', 'yept.checkLeaks', 'yept.installLeakHook', 'yept.removeLeakHook'];

/** Why scripts and tests can't run now: VS Code's Workspace Trust. Checked at each run, so granting trust applies at once. */
export const UNTRUSTED = 'this folder is not trusted. Trust it (Manage Workspace Trust) to run scripts and tests';

export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const notice = remoteNotice(vscode.env.remoteName);
  if (notice) {
    void vscode.commands.executeCommand('setContext', 'yept.remote', true);
    context.subscriptions.push(...COMMANDS.map((command) => vscode.commands.registerCommand(command, () => void vscode.window.showInformationMessage(notice))));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(DEV_TOOLS_VIEW, { resolveWebviewView: (view) => { view.webview.html = `<!DOCTYPE html><html lang="en"><body><p>${notice}</p></body></html>`; } }));
    return undefined;
  }
  // One panel per request, keyed by folder and request id; the active one is the panel last focused.
  const panels = new Map<string, RequestPanel>();
  const reporters = new Map<vscode.WebviewPanel, (message: unknown) => void>();
  let active: RequestPanel | undefined;
  let runner: RunnerPanel | undefined;
  // Created once the services it calls exist; nothing is sent before then.
  let devtools: DevToolsView | undefined;
  let deactivating = false;
  let closeAnswer: CloseAnswer | undefined | null = null;
  const keyOf = (root: string, requestId: string): string => JSON.stringify([root, requestId]);
  const services = new Map<string, ReturnType<typeof createRequestServices>>();
  const output = vscode.window.createOutputChannel('Yept Diagnostics');
  context.subscriptions.push(output, vscode.commands.registerCommand('yept.diagnostics', () => runDiagnostics(context, output)));
  const versions = { vscode: vscode.version, electron: process.versions.electron ?? '', node: process.versions.node };
  // Local secrets are encrypted with a key held in VS Code's secret storage. Without it the rest still works.
  let cipher;
  let encryption = true;
  try {
    cipher = keyCipher(await loadKey(context.secrets));
  } catch (error) {
    encryption = false;
    cipher = unavailableCipher(error instanceof Error ? error.message : String(error));
  }
  const host = await createHost(context.globalStorageUri.fsPath, context.extensionPath, context.extension.packageJSON.version, versions,
    (text) => { void vscode.env.clipboard.writeText(text); }, (channel, event) => {
      for (const p of panels.values()) p.binding.emit(channel, event);
      runner?.binding.emit(channel, event);
      if (channel === 'runner:event') {
        history.refresh();
        devtools?.record({ channel, payload: event as RunnerEvent });
      }
    }, {
      cipher,
      trash: moveToTrash,
      openAuthorizationUrl: async (url) => {
        if (!await vscode.env.openExternal(vscode.Uri.parse(url, true))) throw new Error('Could not open browser');
      },
      openDialog: async (options) => {
        const uris = await vscode.window.showOpenDialog({
          title: options.title,
          defaultUri: options.defaultPath ? vscode.Uri.file(options.defaultPath) : undefined,
          canSelectFiles: options.properties?.includes('openFile') ?? true,
          canSelectFolders: options.properties?.includes('openDirectory') ?? false,
          canSelectMany: options.properties?.includes('multiSelections') ?? false,
          filters: options.filters && Object.fromEntries(options.filters.map((f) => [f.name, f.extensions]))
        });
        return { canceled: !uris?.length, filePaths: uris?.map((u) => u.fsPath) ?? [] };
      },
      // A file name alone (an export's suggested name) starts in the first workspace folder.
      saveDialog: async (options) => {
        const base = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath ?? homedir();
        const uri = await vscode.window.showSaveDialog({
          title: options.title,
          defaultUri: options.defaultPath ? vscode.Uri.file(isAbsolute(options.defaultPath) ? options.defaultPath : join(base, options.defaultPath)) : undefined,
          filters: options.filters && Object.fromEntries(options.filters.map((f) => [f.name, f.extensions]))
        });
        if (uri && uri.scheme !== 'file') throw new Error('Choose a local file.');
        return uri ? { canceled: false, filePath: uri.fsPath } : { canceled: true };
      }
    });
  // VS Code owns these settings; they are read at each use, so a change applies without a reload.
  const stores = createLocalStores(host, () => {
    const config = vscode.workspace.getConfiguration('yept');
    return {
      historyRunsPerRequest: config.get<number>('history.runsPerRequest'),
      historyCapMb: config.get<number>('history.maxSizeMb'),
      historyBodyLimitMb: config.get<number>('history.bodyLimitMb'),
      // Cookie jars are stored encrypted: without the key, automatic cookies stay off rather than failing each run.
      cookies: encryption && config.get<boolean>('cookies.automatic') !== false
    };
  });

  const status = vscode.window.createStatusBarItem('yept.environment', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Yept Environment';
  status.command = 'yept.selectEnvironment';
  context.subscriptions.push(status);
  let statusShown = false;
  // The History view lists the runs of the active panel's request.
  const history = new HistoryView(
    () => (active?.requestId ? { root: active.root, requestId: active.requestId, name: active.name, viewing: active.viewing } : undefined),
    (root, requestId) => serviceFor(root)?.runs.history.list(requestId)
  );
  context.subscriptions.push(history);

  // Dev Tools follows the panel last focused: its request and collection.
  const updateDevToolsContext = (): void => {
    const shown = active;
    devtools?.setContext({ snapshot: (shown && collections.workspace(shown.root)?.snapshot()) ?? null, requestId: shown?.requestId || null, collectionId: shown?.collectionId ?? null });
  };
  // The environment of the collection the active panel shows, while that panel is visible. The History view and Dev
  // Tools follow the same panel, so they catch up here too.
  const updateStatus = async (): Promise<void> => {
    history.refresh();
    updateDevToolsContext();
    const shown = active;
    const root = shown?.root;
    const collectionId = shown?.collectionId;
    const service = root && services.get(root);
    if (!shown?.panel.visible || !collectionId || !service) { status.hide(); statusShown = false; return; }
    try {
      const list = await service.handlers.invoke('env:list', collectionId) as EnvironmentList;
      if (shown !== active || collectionId !== active.collectionId) return;
      const name = collections.workspace(root)?.snapshot().collections.find((c) => c.id === collectionId)?.name ?? 'this collection';
      status.text = `$(server-environment) ${list.active ?? 'No environment'}`;
      status.tooltip = `Yept environment for ${name}. Click to change it.`;
      status.show();
      statusShown = true;
    } catch {
      status.hide();
      statusShown = false;
    }
  };
  // After an environment change from either side, the status bar and the panel's environment list catch up.
  const environmentsChanged = (root: string): void => {
    void updateStatus();
    // A local secret may have been stored or changed: the leak check compares shared files against them.
    leaks.schedule(root);
    const workspace = collections.workspace(root);
    if (!workspace) return;
    for (const p of panels.values()) {
      if (p.root === root) p.binding.emit('workspace:external-change', { snapshot: workspace.snapshot(), changedRequestIds: [], removedRequestIds: [] });
    }
    if (runner?.root === root) runner.binding.emit('workspace:external-change', { snapshot: workspace.snapshot(), changedRequestIds: [], removedRequestIds: [] });
  };

  const collections = new Collections(host.userDataPath(), (root, removed, changed, snapshot) => {
    if (!collections.workspace(root)) {
      void services.get(root)?.close();
      services.delete(root);
    }
    // A removed request's panel closes, unless it has unsaved changes: its page then offers to keep or drop them.
    for (const p of [...panels.values()]) {
      if (p.root !== root) continue;
      if (!collections.workspace(root) || (p.requestId && removed.includes(p.requestId) && !p.dirty)) p.panel.dispose();
      else p.binding.emit('workspace:external-change', { snapshot, changedRequestIds: changed, removedRequestIds: removed });
    }
    if (runner?.root === root) {
      if (!collections.workspace(root)) runner.panel.dispose();
      else runner.binding.emit('workspace:external-change', { snapshot, changedRequestIds: changed, removedRequestIds: removed });
    }
    void updateStatus();
  });
  // The leak check scans in untrusted folders too, as the tree reads them there: it only reads files and runs no code.
  const leaks = new LeakDiagnostics(collections, (dirs) => stores.local.allSecretValues(dirs));
  context.subscriptions.push(leaks, collections.onDidChangeFiles((root) => leaks.schedule(root)));
  const ready = collections.sync();
  // Not awaited: activation doesn't wait for the first scan.
  void ready.then(() => leaks.scheduleAll());
  const provider: vscode.TreeDataProvider<TreeItem> = {
    onDidChangeTreeData: collections.onDidChangeTreeData,
    getParent: (item) => collections.getParent(item),
    getTreeItem: (item) => collections.getTreeItem(item),
    getChildren: async (item) => {
      await ready;
      return collections.getChildren(item);
    }
  };
  let tree: vscode.TreeView<TreeItem>;
  const dragAndDropController = new CollectionDragAndDropController(collections, ready, () => tree);
  tree = vscode.window.createTreeView('yept.collections', { treeDataProvider: provider, dragAndDropController });
  context.subscriptions.push(tree, collections);

  const serviceFor = (root: string): ReturnType<typeof createRequestServices> | undefined => {
    const workspace = collections.workspace(root);
    if (!workspace) return undefined;
    let service = services.get(root);
    if (!service) {
      service = createRequestServices(host, workspace, stores, {
        onSave: () => collections.saved(root),
        onEnvChange: () => environmentsChanged(root),
        scriptsBlocked: () => (vscode.workspace.isTrusted ? undefined : UNTRUSTED),
        onHistoryChange: () => history.refresh(),
        openBody: (body) => openBody(root, body.runId, body.contentType, body.requestName),
        onRun: (payload) => devtools?.record({ channel: 'devtools:run', payload })
      });
      services.set(root, service);
    }
    return service;
  };

  // Whole response bodies open as read-only documents served from here, so a large body never goes through a page.
  const bodyRoots = new Map<string, string>();
  const bodyText = (uri: vscode.Uri): string => {
    const runId = runIdOf(uri.path);
    const root = runId && bodyRoots.get(runId);
    const bytes = root ? services.get(root)?.runs.body(runId) : undefined;
    return bytes ? bytes.toString('utf8') : 'This response body is no longer available. Send the request again.';
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BODY_SCHEME, { provideTextDocumentContent: bodyText }));
  const openBody = async (root: string, runId: string, contentType: string, requestName: string): Promise<void> => {
    const bytes = services.get(root)?.runs.body(runId);
    if (!bytes) throw new Error('This response body is no longer available. Send the request again.');
    const language = bodyLanguage(contentType, bytes.subarray(0, 512).toString('utf8'));
    bodyRoots.set(runId, root);
    let document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: BODY_SCHEME, path: bodyPath(runId, requestName, language) }));
    if (document.languageId !== language) document = await vscode.languages.setTextDocumentLanguage(document, language);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  };

  const resources = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const askToSave = async (name: string): Promise<CloseAnswer> => {
    if (closeAnswer !== null) return closeAnswer ?? 'cancel';
    const save = 'Save';
    const discard = "Don't Save";
    const choice = await vscode.window.showWarningMessage(`Do you want to save the changes you made to ${name}?`, { modal: true, detail: "Your changes will be lost if you don't save them." }, save, discard);
    return choice === save ? 'save' : choice === discard ? 'discard' : 'cancel';
  };

  // VS Code can't keep a webview panel from closing, so the prompt comes after: Save writes the edits the page last
  // reported; Cancel, or a failed save, reopens the request with them still unsaved.
  const closedWithChanges = async (closed: RequestPanel, draft: RequestDoc): Promise<void> => {
    const service = services.get(closed.root);
    if (!service || collections.rootForRequest(closed.requestId) !== closed.root) {
      void vscode.window.showWarningMessage(`Unsaved changes to ${closed.name} were discarded: the request is no longer in the workspace.`);
      return;
    }
    const answer = await askToSave(closed.name);
    if (answer === 'discard') return;
    if (answer === 'save') {
      try {
        await service.handlers.invoke('requests:save', closed.requestId, draft);
        return;
      } catch (error) {
        void vscode.window.showErrorMessage(`Yept: couldn't save ${closed.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    createPanel(closed.root, closed.requestId, closed.name, { draft });
  };

  // Opens a panel for a workspace folder: for a request, or (no request) for a collection's environment editor.
  const createPanel = (root: string, requestId: string, name: string, options: { manageCollectionId?: string; draft?: RequestDoc; viewRun?: string } = {}): vscode.WebviewPanel | undefined => {
    const service = serviceFor(root);
    if (!service) return;
    const key = keyOf(root, requestId);
    const draft = options.draft ?? null;
    const title = requestId ? panelTitle(name, !!draft) : 'Yept Environments';
    // Hidden panels keep their page, so unsaved edits, responses and scroll positions survive switching tabs.
    const panel = vscode.window.createWebviewPanel('yept', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'yept-icon.png');
    const entry: RequestPanel = {
      key, root, requestId, name, dirty: !!draft, draft, viewing: null, panel, reports: 0,
      collectionId: requestId ? collections.workspace(root)?.collectionIdOf(requestId) : options.manageCollectionId,
      // Bound before the page loads, so its first call is answered.
      binding: bindWebview(panel.webview, service.handlers)
    };
    panels.set(key, entry);
    const report = (message: unknown): void => {
      const state = requestId ? checkPanelState(message, requestId) : undefined;
      if (!state) return;
      const listed = entry.name !== state.name || entry.viewing !== state.viewing;
      const dirtyChanged = entry.dirty !== state.dirty;
      Object.assign(entry, state);
      if (dirtyChanged) unsavedChanged();
      entry.reports++;
      panel.title = panelTitle(state.name, state.dirty);
      if (listed && active === entry) history.refresh();
    };
    reporters.set(panel, report);
    panel.webview.onDidReceiveMessage(report);
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) active = entry;
      void updateStatus();
    });
    panel.onDidDispose(() => {
      entry.binding.dispose();
      reporters.delete(panel);
      if (panels.get(key) === entry) panels.delete(key);
      if (active === entry) active = undefined;
      unsavedChanged();
      void updateStatus();
      if (!deactivating && entry.dirty && entry.draft) void closedWithChanges(entry, entry.draft);
    });
    active = entry;
    panel.webview.html = panelHtml(panel.webview, resources, randomBytes(24).toString('base64'), requestId, options.manageCollectionId ?? '', draft ? JSON.stringify(draft) : '', options.viewRun ?? '');
    void updateStatus();
    return panel;
  };

  // Shows a request's panel: the open one, else a new one.
  const showRequest = (root: string, requestId: string, name: string): vscode.WebviewPanel | undefined => {
    const open = panels.get(keyOf(root, requestId));
    if (!open) return createPanel(root, requestId, name);
    open.panel.reveal();
    active = open;
    void updateStatus();
    return open.panel;
  };

  // Opens a request in the panel: the one given by id, or one chosen from every workspace folder's requests.
  const open = async (requestId?: unknown): Promise<vscode.WebviewPanel | undefined> => {
    await ready;
    await collections.settled();
    const snapshots = collections.snapshots();
    if (!snapshots.length) {
      void vscode.window.showInformationMessage('Open a local workspace folder containing a collection first.');
      return;
    }
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const choices = snapshots.flatMap((snapshot) => requestChoices(snapshot).map((choice) => ({
      ...choice, description: multi ? `${collections.name(snapshot.root)} · ${choice.description}` : choice.description
    })));
    let id: string;
    if (typeof requestId === 'string') {
      if (!choices.some((choice) => choice.id === requestId)) {
        void vscode.window.showErrorMessage('That request is no longer in the workspace.');
        return;
      }
      id = requestId;
    } else {
      if (!choices.length) {
        void vscode.window.showInformationMessage('No requests found. Open a folder containing a Bruno collection.');
        return;
      }
      const chosen = await vscode.window.showQuickPick(choices, { title: 'Yept: Open Request', matchOnDescription: true, matchOnDetail: true });
      if (!chosen) return;
      id = chosen.id;
    }
    const root = collections.rootForRequest(id);
    if (!root) return;
    return showRequest(root, id, choices.find((choice) => choice.id === id)?.label ?? 'Request');
  };

  // The collection a command acts on: the tree item it was run on, else the panel's, else the only one, else ask.
  const target = async (item?: unknown): Promise<CollectionChoice | undefined> => {
    await ready;
    await collections.settled();
    const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const all: CollectionChoice[] = collections.snapshots().flatMap((snapshot) => snapshot.collections.map((c) => ({
      label: c.name, description: multi ? collections.name(snapshot.root) : undefined, root: snapshot.root, collectionId: c.id
    })));
    // Tree item ids are JSON: [root, kind, collection id].
    const node = item as Partial<TreeItem> | undefined;
    if (node?.kind === 'collection' && typeof node.id === 'string') {
      const [root, , collectionId] = JSON.parse(node.id) as [string, string, string];
      const found = all.find((c) => c.root === root && c.collectionId === collectionId);
      if (found) return found;
    }
    const current = all.find((c) => c.root === active?.root && c.collectionId === active?.collectionId);
    if (current) return current;
    if (!all.length) {
      void vscode.window.showInformationMessage('Open a local workspace folder containing a collection first.');
      return;
    }
    if (all.length === 1) return all[0];
    return vscode.window.showQuickPick(all, { title: 'Yept: Choose Collection', matchOnDescription: true });
  };

  const manageEnvironments = async (item?: unknown): Promise<void> => {
    const chosen = await target(item);
    if (chosen) openEnvironmentEditor(chosen);
  };
  // The editor opens in the active panel when it shows the same folder, else in another of that folder's panels.
  const openEnvironmentEditor = (chosen: CollectionChoice): void => {
    const shown = (active?.root === chosen.root ? active : undefined) ?? [...panels.values()].find((p) => p.root === chosen.root);
    if (!shown) {
      createPanel(chosen.root, '', '', { manageCollectionId: chosen.collectionId });
      return;
    }
    if (!shown.requestId) shown.collectionId = chosen.collectionId;
    shown.panel.reveal();
    active = shown;
    shown.binding.emit('environments:manage', { collectionId: chosen.collectionId });
    void updateStatus();
  };

  const selectEnvironment = async (item?: unknown): Promise<void> => {
    const chosen = await target(item);
    const service = chosen && serviceFor(chosen.root);
    if (!chosen || !service) return;
    const list = await service.handlers.invoke('env:list', chosen.collectionId) as EnvironmentList;
    type Pick = vscode.QuickPickItem & { name?: string | null; manage?: true };
    const picks: Pick[] = [
      { label: 'No environment', name: null, description: list.active === null ? 'active' : undefined },
      ...list.environments.map((e): Pick => ({ label: e.name, name: e.name, description: e.name === list.active ? 'active' : undefined })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(gear) Manage Environments…', manage: true }
    ];
    const pick = await vscode.window.showQuickPick(picks, { title: `Yept: Environment for ${chosen.label}` });
    if (!pick) return;
    if (pick.manage) return openEnvironmentEditor(chosen);
    if (pick.name !== undefined) await service.handlers.invoke('env:set-active', chosen.collectionId, pick.name);
  };

  // History view items: show the run in its request's panel, or put its request into that panel's unsaved draft.
  const historyEntry = (action: 'open' | 'restore') => (node?: HistoryNode): void => {
    const shown = node && panels.get(keyOf(node.root, node.requestId));
    if (!node || !shown) {
      void vscode.window.showInformationMessage('Open the request to see its past runs.');
      return;
    }
    if (!shown.panel.visible) shown.panel.reveal(shown.panel.viewColumn, true);
    shown.binding.emit('history:entry', { runId: node.summary.runId, action });
  };

  // The requests with unsaved edits in a folder's panels: the runner sends the saved versions and says so.
  const unsavedIds = (root: string): string[] => [...panels.values()].filter((p) => p.root === root && p.requestId && p.dirty).map((p) => p.requestId);
  const unsavedChanged = (): void => runner?.binding.emit('panels:unsaved', { requestIds: unsavedIds(runner.root) });

  // While a collection run goes on with its panel hidden, the status bar shows its progress, as the desktop's does.
  const runnerStatusItem = vscode.window.createStatusBarItem('yept.runner', vscode.StatusBarAlignment.Left, 49);
  runnerStatusItem.name = 'Yept Collection Run';
  runnerStatusItem.command = 'yept.showRunner';
  runnerStatusItem.tooltip = 'Show the collection run';
  context.subscriptions.push(runnerStatusItem);
  let runnerStatusText: string | undefined;
  const updateRunnerStatus = (): void => {
    const progress = runner && !runner.panel.visible ? runnerProgress(runner.state) : undefined;
    runnerStatusText = progress && `$(sync~spin) Running ${progress}`;
    if (!runnerStatusText) return runnerStatusItem.hide();
    runnerStatusItem.text = runnerStatusText;
    runnerStatusItem.show();
  };

  // Runs a collection or folder: the tree item it was run on, else a collection chosen as other commands do. One runner
  // panel shows one target at a time, as the desktop's runner dialog does.
  const runCollection = async (item?: unknown): Promise<void> => {
    await ready;
    await collections.settled();
    let root: string;
    let nodeId: string;
    const node = item as Partial<TreeItem> | undefined;
    if ((node?.kind === 'collection' || node?.kind === 'folder') && typeof node.id === 'string') {
      [root, , nodeId] = JSON.parse(node.id) as [string, string, string];
    } else {
      const chosen = await target(item);
      if (!chosen) return;
      ({ root, collectionId: nodeId } = chosen);
    }
    const service = serviceFor(root);
    if (!service) return;
    if (runner) {
      if (runner.root === root) {
        runner.panel.reveal();
        runner.binding.emit('runner:open', { nodeId });
        return;
      }
      if (runner.state?.run?.running) {
        runner.panel.reveal();
        void vscode.window.showInformationMessage('A collection run is already going on. Wait for it to finish or cancel it.');
        return;
      }
      runner.panel.dispose();
    }
    const panel = vscode.window.createWebviewPanel('yept.runner', 'Collection Runner', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'yept-icon.png');
    const entry: RunnerPanel = {
      root, panel, state: undefined,
      binding: bindWebview(panel.webview, extendRegistry(service.handlers, {
        'runner:context': () => ({ snapshot: collections.workspace(root)?.snapshot(), unsavedRequestIds: unsavedIds(root) }),
        'runner:open-request': async (requestId: unknown) => {
          if (typeof requestId !== 'string') throw new Error('Expected a string');
          await open(requestId);
        },
        'devtools:show-run': async (runId: unknown) => {
          if (typeof runId !== 'string') throw new Error('Expected a string');
          await devtools?.showRun(runId);
        }
      }))
    };
    runner = entry;
    panel.webview.onDidReceiveMessage((message) => {
      const state = checkRunnerState(message);
      if (!state) return;
      entry.state = state;
      panel.title = state.target ? `Run ${state.target.name}` : 'Collection Runner';
      updateRunnerStatus();
    });
    panel.onDidChangeViewState(updateRunnerStatus);
    panel.onDidDispose(() => {
      entry.binding.dispose();
      // Closing the panel takes away the run's Cancel button, so a run going on stops with it.
      const run = entry.state?.run;
      if (run?.running && !deactivating) void services.get(root)?.handlers.invoke('runner:cancel', run.runnerId).catch(() => undefined);
      if (runner === entry) runner = undefined;
      updateRunnerStatus();
    });
    panel.webview.html = pageHtml(panel.webview, resources, randomBytes(24).toString('base64'), 'runner.js', { 'node-id': nodeId });
  };

  // What the Dev Tools view calls: each goes to the services of the workspace folder that has the collection or run.
  const devtoolsChannels = new HandlerRegistry();
  const rootOfCollection = (collectionId: unknown): string | undefined => collections.snapshots().find((s) => s.collections.some((c) => c.id === collectionId))?.root;
  for (const channel of ['cookies:list', 'cookies:upsert', 'cookies:remove', 'cookies:clear']) {
    devtoolsChannels.register(channel, (collectionId: unknown, ...rest: unknown[]) => {
      const root = rootOfCollection(collectionId);
      const service = root && serviceFor(root);
      if (!service) throw new Error('That collection is no longer in the workspace.');
      return service.handlers.invoke(channel, collectionId, ...rest);
    });
  }
  // Copies with secrets: from the folder whose services sent the request.
  for (const channel of ['runs:curl-with-secrets', 'runs:raw-with-secrets']) {
    devtoolsChannels.register(channel, async (...args: unknown[]) => {
      let failure: unknown = new Error('Secrets are only kept for the last 50 requests sent in this session. Send the request again, or copy it without secrets.');
      for (const service of services.values()) {
        try { return await service.handlers.invoke(channel, ...args); } catch (error) { failure = error; }
      }
      throw failure;
    });
  }
  devtoolsChannels.register('clipboard:write', async (value: unknown) => {
    if (typeof value !== 'string') throw new Error('Expected a string');
    await vscode.env.clipboard.writeText(value);
  });
  devtoolsChannels.register('devtools:open-settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'yept.cookies'));
  // "Open request" in Dev Tools: the request's panel, showing that run.
  devtoolsChannels.register('devtools:open-run', async (requestId: unknown, runId: unknown) => {
    if (typeof requestId !== 'string' || typeof runId !== 'string') throw new Error('Expected a string');
    await ready;
    const root = collections.rootForRequest(requestId);
    const workspace = root && collections.workspace(root);
    if (!root || !workspace) throw new Error('That request is no longer in the workspace.');
    const shown = panels.get(keyOf(root, requestId));
    if (!shown) {
      createPanel(root, requestId, workspace.getRequest(requestId).doc.name, { viewRun: runId });
      return;
    }
    shown.panel.reveal();
    active = shown;
    void updateStatus();
    shown.binding.emit('history:entry', { runId, action: 'show' });
  });
  devtools = new DevToolsView(resources, devtoolsChannels);
  context.subscriptions.push(devtools);
  updateDevToolsContext();

  const guard = (fn: (item?: unknown) => Promise<void>) => async (item?: unknown): Promise<void> => {
    try { await fn(item); }
    catch (error) { void vscode.window.showErrorMessage(`Yept: ${error instanceof Error ? error.message : String(error)}`); }
  };

  context.subscriptions.push(...collectionActions(collections, ready, tree, open, (root) => serviceFor(root)?.importer));
  context.subscriptions.push(...leakHookCommands(collections, ready, join(context.extensionPath, 'dist', 'yept-leak-check.cjs'), process.execPath));
  const checkLeaks = async (): Promise<{ findings: number; files: number }> => {
    await ready;
    await collections.settled();
    const result = await leaks.scanAll();
    if (!result.findings) void vscode.window.showInformationMessage('Yept: no leaked secrets found in the open collections.');
    else {
      const show = 'Show Problems';
      void vscode.window.showWarningMessage(`Yept found ${result.findings} possible leaked secret${result.findings > 1 ? 's' : ''} in ${result.files} file${result.files > 1 ? 's' : ''}.`, show)
        .then((choice) => { if (choice === show) void vscode.commands.executeCommand('workbench.actions.view.problems'); });
    }
    return result;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('yept.openRequest', open),
    vscode.commands.registerCommand('yept.open', open),
    vscode.commands.registerCommand('yept.selectEnvironment', guard(selectEnvironment)),
    vscode.commands.registerCommand('yept.manageEnvironments', guard(manageEnvironments)),
    vscode.commands.registerCommand('yept.history.open', historyEntry('open')),
    vscode.commands.registerCommand('yept.history.restore', historyEntry('restore')),
    vscode.commands.registerCommand('yept.runCollection', guard(runCollection)),
    vscode.commands.registerCommand('yept.runFolder', guard(runCollection)),
    vscode.commands.registerCommand('yept.showRunner', () => runner?.panel.reveal()),
    vscode.commands.registerCommand('yept.showDevTools', () => vscode.commands.executeCommand(`${DEV_TOOLS_VIEW}.focus`)),
    vscode.commands.registerCommand('yept.checkLeaks', checkLeaks),
    {
      dispose: async () => {
        deactivating = true;
        for (const p of [...panels.values()]) p.panel.dispose();
        runner?.panel.dispose();
        await Promise.all([...services.values()].map((service) => service.close()));
        stores.close();
      }
    }
  );
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
      collections, dragAndDropController, ready, services, environmentStatus: () => (statusShown ? status.text : undefined), storage: host.userDataPath(), settings: () => stores.settings.get(),
      panels: () => [...panels.values()].map((p) => ({ requestId: p.requestId, title: p.panel.title, dirty: p.dirty, viewing: p.viewing, reports: p.reports, panel: p.panel })),
      history,
      answerClosePrompts: (answer) => { closeAnswer = answer; },
      panelMessage: (panel, message) => reporters.get(panel)?.(message),
      runner: () => runner && { root: runner.root, panel: runner.panel, state: runner.state },
      devtools: () => devtools!.state(),
      runnerStatus: () => runnerStatusText,
      treeSelection: () => tree.selection
    }
    : undefined;
}
