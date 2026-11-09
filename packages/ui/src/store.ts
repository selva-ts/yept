// UI state. Saved files are the source of truth; tabs hold a saved copy and a draft to track unsaved edits.
import { create } from 'zustand';
import type { EnvironmentList, ExternalChange, ImportPreview, LoadedRequest, MutationResult } from '@shared/ipc';
import { DEFAULT_APP_SETTINGS, type Appearance, type HistoryEntry, type HistorySummary, type RequestDoc, type RunResult, type TreeNode, type WorkspaceSnapshot } from '@shared/model';
import { errorMessage, yept } from './api';
import { useDevTools } from './devtools';
import { applyAppearance } from './appearance';

export interface Tab {
  id: string;
  collectionId: string;
  path: string;
  readOnly: boolean;
  saved: RequestDoc;
  draft: RequestDoc;
  /** Set when the file changed on disk while this tab had unsaved edits. */
  conflict: 'changed' | 'removed' | null;
  run: { runId: string; running: boolean; result: RunResult | null } | null;
  /** Past runs of this request, newest first (loaded when the history panel opens or after a run). */
  history: HistorySummary[] | null;
  historyOpen: boolean;
  /** An old run being looked at instead of the latest one. Nothing is re-sent. */
  viewing: HistoryEntry | null;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface State {
  snapshot: WorkspaceSnapshot | null;
  view: 'home' | 'collection';
  selectedCollectionId: string | null;
  collectionViewMode: 'grid' | 'list';
  /** Collapsed folder/collection ids in the sidebar tree. A local UI preference (browser storage), never in collection files. */
  collapsed: string[];
  tabs: Tab[];
  activeId: string | null;
  toasts: Toast[];
  paletteOpen: boolean;
  /** Environment lists per collection id. */
  envs: Record<string, EnvironmentList>;
  /** Open dialogs. */
  envEditor: { collectionId: string; focus?: string } | null;
  settingsEditor: { id: string } | null;
  appSettingsOpen: boolean;
  aboutOpen: boolean;
  /** Light/dark, theme and fonts: applied at once, saved by main. */
  appearance: Appearance;
  orphansOpen: boolean;
  gitOpen: boolean;
  importPreview: ImportPreview | null;
  /** The "Paste cURL" dialog, with the command it starts with. */
  curlPaste: { command: string } | null;
  /** Changed collection files, for the Git button badge. */
  gitChanges: number | null;
  /** Branch of the workspace's (first) repository, for the status bar. Null when the collections aren't in Git. */
  gitSummary: { branch: string | null; ahead: number; behind: number; repos: number } | null;
  /** Bumped whenever variables may have changed (env switch, edits, a run), so previews refresh. */
  varsVersion: number;

  loadEnvs: (collectionId: string) => Promise<EnvironmentList | undefined>;
  setEnvs: (list: EnvironmentList) => void;
  setActiveEnv: (collectionId: string, name: string | null) => Promise<void>;
  openEnvEditor: (collectionId: string, focus?: string) => void;
  closeEnvEditor: () => void;
  openSettings: (id: string) => void;
  closeSettings: () => void;
  bumpVars: () => void;
  setAppSettingsOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  loadAppearance: () => Promise<void>;
  setAppearance: (change: Partial<Appearance>) => Promise<void>;
  setOrphansOpen: (open: boolean) => void;
  setGitOpen: (open: boolean) => void;
  setImportPreview: (p: ImportPreview | null) => void;
  setCurlPaste: (paste: { command: string } | null) => void;
  refreshGitCount: () => Promise<void>;

  loadHistory: (id: string) => Promise<void>;
  toggleHistory: (id: string) => void;
  viewRun: (id: string, runId: string) => Promise<void>;
  backToLatest: (id: string) => void;
  restoreFromHistory: (id: string) => void;

  setSnapshot: (s: WorkspaceSnapshot | null) => void;
  showHome: () => void;
  openCollection: (id: string) => void;
  loadCollectionViewMode: () => Promise<void>;
  setCollectionViewMode: (mode: 'grid' | 'list') => Promise<void>;
  setCollapsed: (ids: string[]) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  setPalette: (open: boolean) => void;

  openRequest: (id: string) => Promise<void>;
  closeTab: (id: string) => void;
  activate: (id: string) => void;
  updateDraft: (id: string, fn: (d: RequestDoc) => RequestDoc) => void;
  save: (id: string) => Promise<void>;
  send: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  mutate: (fn: () => Promise<MutationResult>, then?: (id?: string) => void) => Promise<void>;
  applyExternal: (change: ExternalChange) => Promise<void>;
  resolveConflict: (id: string, choice: 'reload' | 'keep') => Promise<void>;
}

let toastSeq = 0;
const same = (a: RequestDoc, b: RequestDoc): boolean => JSON.stringify(a) === JSON.stringify(b);
export const isDirty = (t: Tab): boolean => !same(t.saved, t.draft);

export function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = n.children && findNode(n.children, id);
    if (c) return c;
  }
  return undefined;
}

const fromLoaded = (r: LoadedRequest): Tab => ({
  id: r.id, collectionId: r.collectionId, path: r.path, readOnly: r.readOnly, saved: r.doc, draft: structuredClone(r.doc),
  conflict: null, run: null, history: null, historyOpen: false, viewing: null
});

const COLLAPSED_KEY = 'yept.tree.collapsed';
function loadCollapsed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const useStore = create<State>((set, get) => ({
  snapshot: null,
  view: 'home',
  selectedCollectionId: null,
  collectionViewMode: 'grid',
  collapsed: loadCollapsed(),
  tabs: [],
  activeId: null,
  toasts: [],
  paletteOpen: false,
  envs: {},
  envEditor: null,
  settingsEditor: null,
  appSettingsOpen: false,
  aboutOpen: false,
  appearance: { theme: DEFAULT_APP_SETTINGS.theme, palette: DEFAULT_APP_SETTINGS.palette, uiFont: '', codeFont: '', codeFontSize: DEFAULT_APP_SETTINGS.codeFontSize },
  orphansOpen: false,
  gitOpen: false,
  importPreview: null,
  curlPaste: null,
  gitChanges: null,
  gitSummary: null,
  varsVersion: 0,

  setGitOpen: (gitOpen) => {
    set({ gitOpen });
    if (!gitOpen) void get().refreshGitCount();
  },
  setImportPreview: (importPreview) => set({ importPreview }),
  setCurlPaste: (curlPaste) => set({ curlPaste }),
  refreshGitCount: async () => {
    try {
      const s = await yept.git.status();
      const first = s.repos[0];
      set({
        gitChanges: s.repos.length ? s.repos.reduce((n, r) => n + r.files.length, 0) : null,
        gitSummary: first ? { branch: first.branch, ahead: first.ahead, behind: first.behind, repos: s.repos.length } : null
      });
    } catch {
      set({ gitChanges: null, gitSummary: null });
    }
  },

  setAppSettingsOpen: (appSettingsOpen) => set({ appSettingsOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  loadAppearance: async () => {
    try {
      const { theme, palette, uiFont, codeFont, codeFontSize } = (await yept.appSettings.get()).settings;
      set({ appearance: { theme, palette, uiFont, codeFont, codeFontSize } });
    } catch { /* keeps the defaults */ }
    applyAppearance(get().appearance);
  },
  setAppearance: async (change) => {
    set({ appearance: { ...get().appearance, ...change } });
    applyAppearance(get().appearance);
    try {
      const { theme, palette, uiFont, codeFont, codeFontSize } = (await yept.appSettings.setAppearance(change)).settings;
      // Main may have corrected a value (an unusable font name, a size out of range).
      set({ appearance: { theme, palette, uiFont, codeFont, codeFontSize } });
      applyAppearance(get().appearance);
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },
  setOrphansOpen: (orphansOpen) => set({ orphansOpen }),

  loadHistory: async (id) => {
    try {
      const history = await yept.history.list(id);
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, history } : t)) }));
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },
  toggleHistory: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, historyOpen: !t.historyOpen } : t)) }));
    if (!tab.historyOpen) void get().loadHistory(id);
  },
  viewRun: async (id, runId) => {
    try {
      const entry = await yept.history.get(runId);
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, viewing: t.run?.runId === runId ? null : entry } : t)) }));
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },
  backToLatest: (id) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, viewing: null } : t)) })),
  restoreFromHistory: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id && t.viewing && !t.readOnly ? { ...t, draft: { ...structuredClone(t.viewing.doc), name: t.draft.name }, viewing: null } : t
      )
    })),

  setSnapshot: (snapshot) => set((s) => snapshot?.root !== s.snapshot?.root
    ? { snapshot, view: 'home', selectedCollectionId: null, tabs: [], activeId: null, envs: {} }
    : { snapshot }),
  showHome: () => set({ view: 'home' }),
  setCollapsed: (collapsed) => {
    set({ collapsed });
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* preference only */ }
  },
  openCollection: (id) => set((s) => ({
    view: 'collection', selectedCollectionId: id,
    activeId: s.tabs.find((t) => t.id === s.activeId)?.collectionId === id ? s.activeId : null
  })),
  loadCollectionViewMode: async () => {
    try { set({ collectionViewMode: await yept.workspace.getViewMode() }); }
    catch { set({ collectionViewMode: 'grid' }); }
  },
  setCollectionViewMode: async (mode) => {
    set({ collectionViewMode: mode });
    try { await yept.workspace.setViewMode(mode); }
    catch (e) { get().toast(errorMessage(e), 'error'); }
  },

  loadEnvs: async (collectionId) => {
    try {
      const list = await yept.env.list(collectionId);
      get().setEnvs(list);
      return list;
    } catch (e) {
      get().toast(errorMessage(e), 'error');
      return undefined;
    }
  },
  setEnvs: (list) => {
    set((s) => ({ envs: { ...s.envs, [list.collectionId]: list }, varsVersion: s.varsVersion + 1 }));
    // Each environment has its own cookie jar.
    if (useDevTools.getState().jars[list.collectionId]?.environment !== (list.active ?? '')) void useDevTools.getState().loadJar(list.collectionId);
  },
  setActiveEnv: async (collectionId, name) => {
    try {
      get().setEnvs(await yept.env.setActive(collectionId, name));
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },
  openEnvEditor: (collectionId, focus) => set({ envEditor: { collectionId, focus } }),
  closeEnvEditor: () => set({ envEditor: null }),
  openSettings: (id) => set({ settingsEditor: { id } }),
  closeSettings: () => set({ settingsEditor: null }),
  bumpVars: () => set((s) => ({ varsVersion: s.varsVersion + 1 })),

  toast: (text, kind = 'info') => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 2600);
  },

  setPalette: (paletteOpen) => set({ paletteOpen }),

  openRequest: async (id) => {
    const open = get().tabs.find((t) => t.id === id);
    if (open) return set({ activeId: id, selectedCollectionId: open.collectionId, view: 'collection' });
    try {
      const loaded = await yept.requests.get(id);
      set((s) => ({ tabs: [...s.tabs, fromLoaded(loaded)], activeId: id, selectedCollectionId: loaded.collectionId, view: 'collection' }));
      if (!get().envs[loaded.collectionId]) void get().loadEnvs(loaded.collectionId);
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },

  closeTab: (id) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId = s.activeId === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.activeId;
      return { tabs, activeId };
    }),

  activate: (activeId) => set((s) => ({ activeId, view: 'collection', selectedCollectionId: s.tabs.find((t) => t.id === activeId)?.collectionId ?? s.selectedCollectionId })),

  updateDraft: (id, fn) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && !t.readOnly ? { ...t, draft: fn(t.draft) } : t)) })),

  save: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.readOnly) return;
    try {
      const r = await yept.requests.save(id, tab.draft);
      const node = r.snapshot.collections.length ? findNode(r.snapshot.collections, id) : undefined;
      set((s) => ({
        snapshot: r.snapshot,
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, saved: structuredClone(tab.draft), conflict: null, path: node?.path ?? t.path } : t))
      }));
    } catch (e) {
      get().toast(`Save failed: ${errorMessage(e)}`, 'error');
    }
  },

  send: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.run?.running) return;
    const runId = crypto.randomUUID();
    const setRun = (run: Tab['run']): void => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, run } : t)) }));
    setRun({ runId, running: true, result: tab.run?.result ?? null });
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, viewing: null } : t)) }));
    const devtools = useDevTools.getState();
    devtools.runStarted({ runId, requestId: id, requestName: tab.draft.name, collectionId: tab.collectionId, environment: get().envs[tab.collectionId]?.active ?? '', method: tab.draft.method, url: tab.draft.url });
    try {
      const { result, historyError } = await yept.runs.start(runId, id, tab.draft);
      devtools.runFinished(runId, result);
      void devtools.loadJar(tab.collectionId);
      setRun({ runId, running: false, result });
      if (historyError) get().toast(historyError, 'error');
      void get().loadHistory(id);
      // Extracted tokens and script variables may have changed what other requests resolve to.
      get().bumpVars();
      // Secrets may have been stored; refresh the environment view.
      void get().loadEnvs(tab.collectionId);
    } catch (e) {
      devtools.runFinished(runId, null, errorMessage(e));
      setRun({ runId, running: false, result: tab.run?.result ?? null });
      get().toast(errorMessage(e), 'error');
    }
  },

  cancel: async (id) => {
    const run = get().tabs.find((t) => t.id === id)?.run;
    if (run?.running) await yept.runs.cancel(run.runId);
  },

  mutate: async (fn, then) => {
    try {
      const r = await fn();
      set({ snapshot: r.snapshot });
      // Paths of open tabs may have changed (rename/move).
      set((s) => ({ tabs: s.tabs.map((t) => ({ ...t, path: findNode(r.snapshot.collections, t.id)?.path ?? t.path })) }));
      then?.(r.id);
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },

  applyExternal: async (change) => {
    set({ snapshot: change.snapshot });
    // Environment files may have changed too.
    for (const collectionId of Object.keys(get().envs)) void get().loadEnvs(collectionId);
    for (const id of change.changedRequestIds) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) continue;
      try {
        const loaded = await yept.requests.get(id);
        // Check the current draft after the async load: the user may have edited while it was in flight.
        // Git and the watcher can report the same change; an unchanged saved copy needs no second prompt.
        set((s) => ({ tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          // Only the file moved (its folder was renamed or moved): unsaved edits still apply.
          if (same(t.saved, loaded.doc)) return t.path === loaded.path ? t : { ...t, path: loaded.path };
          return isDirty(t) ? { ...t, conflict: 'changed' } : { ...t, path: loaded.path, saved: loaded.doc, draft: structuredClone(loaded.doc), conflict: null };
        }) }));
      } catch {
        /* removed in the meantime */
      }
    }
    for (const id of change.removedRequestIds) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) continue;
      if (isDirty(tab)) set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, conflict: 'removed' } : t)) }));
      else get().closeTab(id);
    }
  },

  resolveConflict: async (id, choice) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    if (choice === 'reload') {
      if (tab.conflict === 'removed') return get().closeTab(id);
      const loaded = await yept.requests.get(id);
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, saved: loaded.doc, draft: structuredClone(loaded.doc), conflict: null } : t)) }));
      return;
    }
    // Keep my edits: clear the flag; the next save overwrites the file on disk.
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, conflict: null } : t)) }));
  }
}));
