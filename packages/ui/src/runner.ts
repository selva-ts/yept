// Collection runner state: the dialog's target and choices, and the current (or last) run. The host (the desktop's main
// process or the VS Code extension) does the sending; its progress events fill in the steps and add each request to Dev
// tools, like a send from a tab.
import { create } from 'zustand';
import { MAX_DELAY_MS, MAX_ITERATIONS, plannedSteps, planRun, type DataFileInfo, type RunnerEnd, type RunnerEvent, type RunnerStep } from '@shared/collection-run';
import type { TreeNode } from '@shared/model';
import { errorMessage, yept } from './api';
import { findNode, useStore } from './store';
import { useDevTools } from './devtools';

export interface RunnerTarget {
  nodeId: string;
  collectionId: string;
  kind: 'collection' | 'folder';
  name: string;
}

export interface CollectionRun {
  runnerId: string;
  nodeId: string;
  /** '' when run without an environment. */
  environment: string;
  stopOnFailure: boolean;
  /** Passes over the plan: the data file's rows, or the repeat count. */
  iterations: number;
  /** The data file's name, if one was used. */
  dataFile?: string;
  delayMs: number;
  running: boolean;
  cancelling: boolean;
  steps: RunnerStep[];
  ended: RunnerEnd | null;
  startedAt: number;
  finishedAt: number | null;
  /** The run couldn't start or failed as a whole. */
  error?: string;
}

const STOP_KEY = 'yept.runner.stopOnFailure';
function loadStop(): boolean {
  try { return localStorage.getItem(STOP_KEY) === 'true'; } catch { return false; }
}
const DELAY_KEY = 'yept.runner.delayMs';
const clampDelay = (n: number): number => (Number.isFinite(n) ? Math.min(MAX_DELAY_MS, Math.max(0, Math.round(n))) : 0);
const clampIterations = (n: number): number => (Number.isFinite(n) ? Math.min(MAX_ITERATIONS, Math.max(1, Math.round(n))) : 1);
function loadDelay(): number {
  try { return clampDelay(Number(localStorage.getItem(DELAY_KEY) ?? 0)); } catch { return 0; }
}

// Progress events are applied in batches, so a run with many iterations doesn't copy its steps for every event.
const FLUSH_MS = 100;

interface RunnerState {
  open: boolean;
  target: RunnerTarget | null;
  /** Chosen environment; null for none. */
  environment: string | null;
  /** The last environment picked in the runner, kept for the collection's next run. */
  picked: { collectionId: string; name: string | null } | null;
  stopOnFailure: boolean;
  /** Repeat count without a data file. */
  iterations: number;
  delayMs: number;
  /** The data file chosen for the target's collection: its path stays on this machine, in memory. */
  dataFile: (DataFileInfo & { collectionId: string }) | null;
  /** Reading the chosen data file. */
  pickingData: boolean;
  run: CollectionRun | null;

  openFor: (node: TreeNode) => Promise<void>;
  setOpen: (open: boolean) => void;
  setEnvironment: (name: string | null) => void;
  setStopOnFailure: (stop: boolean) => void;
  setIterations: (n: number) => void;
  setDelayMs: (ms: number) => void;
  pickDataFile: () => Promise<void>;
  clearDataFile: () => void;
  /** Saves the shown run as a report; the saved path, or null if cancelled or it failed (a toast says why). */
  exportReport: (format: 'junit' | 'html') => Promise<string | null>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

/** The collection a tree node belongs to. */
function collectionOf(nodeId: string): TreeNode | undefined {
  return useStore.getState().snapshot?.collections.find((c) => c.id === nodeId || !!findNode(c.children ?? [], nodeId));
}

export const useRunner = create<RunnerState>((set, get) => ({
  open: false,
  target: null,
  environment: null,
  picked: null,
  stopOnFailure: loadStop(),
  iterations: 1,
  delayMs: loadDelay(),
  dataFile: null,
  pickingData: false,
  run: null,

  openFor: async (node) => {
    const running = get().run?.running;
    if (running) {
      // One run at a time: show the one going on.
      set({ open: true });
      if (get().run?.nodeId !== node.id) useStore.getState().toast('A collection run is already going on. Wait for it to finish or cancel it.', 'error');
      return;
    }
    const collection = collectionOf(node.id);
    if (!collection || node.kind === 'request') return;
    set({
      open: true,
      target: { nodeId: node.id, collectionId: collection.id, kind: node.kind, name: node.name },
      run: get().run?.nodeId === node.id ? get().run : null,
      // A data file chosen for another collection doesn't carry over.
      dataFile: get().dataFile?.collectionId === collection.id ? get().dataFile : null
    });
    const envs = useStore.getState().envs[collection.id] ?? (await useStore.getState().loadEnvs(collection.id));
    // The collection's active environment, unless another one was picked in the runner for this collection.
    const picked = get().picked;
    const keep = picked?.collectionId === collection.id && (picked.name === null || !!envs?.environments.some((e) => e.name === picked.name));
    set({ environment: keep && picked ? picked.name : (envs?.active ?? null) });
  },
  setOpen: (open) => set({ open }),
  setEnvironment: (environment) => set((s) => ({ environment, picked: s.target ? { collectionId: s.target.collectionId, name: environment } : null })),
  setStopOnFailure: (stopOnFailure) => {
    set({ stopOnFailure });
    try { localStorage.setItem(STOP_KEY, String(stopOnFailure)); } catch { /* preference only */ }
  },
  setIterations: (n) => set({ iterations: clampIterations(n) }),
  setDelayMs: (ms) => {
    const delayMs = clampDelay(ms);
    set({ delayMs });
    try { localStorage.setItem(DELAY_KEY, String(delayMs)); } catch { /* preference only */ }
  },
  pickDataFile: async () => {
    const target = get().target;
    if (!target || get().pickingData) return;
    set({ pickingData: true });
    try {
      const info = await yept.runner.pickDataFile();
      if (info && get().target?.collectionId === target.collectionId) set({ dataFile: { ...info, collectionId: target.collectionId } });
    } catch (e) {
      useStore.getState().toast(`Can't use that data file. ${errorMessage(e)}`, 'error');
    } finally {
      set({ pickingData: false });
    }
  },
  clearDataFile: () => set({ dataFile: null }),
  exportReport: async (format) => {
    const run = get().run;
    if (!run || run.running) return null;
    try {
      const path = await yept.runner.exportReport(run.runnerId, format);
      if (path) useStore.getState().toast(`Saved the ${format === 'junit' ? 'JUnit' : 'HTML'} report to ${path}`, 'info');
      return path;
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
      return null;
    }
  },

  start: async () => {
    const { target, environment, stopOnFailure, delayMs } = get();
    const dataFile = get().dataFile?.collectionId === target?.collectionId ? get().dataFile : null;
    const iterations = dataFile ? dataFile.rows : get().iterations;
    if (!target || get().run?.running) return;
    const collection = useStore.getState().snapshot?.collections.find((c) => c.id === target.collectionId);
    const node = collection && (collection.id === target.nodeId ? collection : findNode(collection.children ?? [], target.nodeId));
    if (!node) return useStore.getState().toast('That folder or collection no longer exists', 'error');
    const runnerId = crypto.randomUUID();
    const update = (fn: (r: CollectionRun) => CollectionRun): void => set((s) => (s.run?.runnerId === runnerId ? { run: fn(s.run) } : {}));
    set({
      run: {
        runnerId, nodeId: target.nodeId, environment: environment ?? '', stopOnFailure, iterations, dataFile: dataFile?.name, delayMs, running: true, cancelling: false,
        steps: plannedSteps(planRun(node), iterations), ended: null, startedAt: Date.now(), finishedAt: null
      }
    });
    const devtools = useDevTools.getState();
    const app = useStore.getState();
    // Step changes and history reloads wait for the next flush.
    const changed = new Map<number, RunnerStep>();
    const finishedRequests = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (changed.size) {
        const batch = [...changed];
        changed.clear();
        update((r) => {
          const steps = [...r.steps];
          for (const [i, step] of batch) steps[i] = step;
          return { ...r, steps };
        });
      }
      // An open tab's history list gets the new runs.
      for (const id of finishedRequests) if (useStore.getState().tabs.find((t) => t.id === id)?.history) void useStore.getState().loadHistory(id);
      finishedRequests.clear();
    };
    const onEvent = (e: RunnerEvent): void => {
      if (e.runnerId !== runnerId) return;
      changed.set(e.index, e.step);
      timer ??= setTimeout(flush, FLUSH_MS);
      if (e.type === 'step-start') {
        devtools.runStarted({ runId: e.step.runId, requestId: e.step.requestId, requestName: e.step.name, collectionId: e.collectionId, environment: e.environment, method: e.step.method, url: e.url });
        return;
      }
      devtools.runFinished(e.step.runId, e.result, e.result ? undefined : e.error);
      if (e.historyError) app.toast(e.historyError, 'error');
      finishedRequests.add(e.step.requestId);
    };
    const off = yept.runner.onEvent(onEvent);
    try {
      const result = await yept.runner.start(runnerId, target.nodeId, { environment, stopOnFailure, dataFile: dataFile?.path ?? null, iterations, delayMs });
      flush();
      update((r) => ({ ...r, steps: result.steps, ended: result.ended }));
    } catch (e) {
      flush();
      update((r) => ({ ...r, error: errorMessage(e), steps: r.steps.map((s) => (s.status === 'pending' || s.status === 'running' ? { ...s, status: 'skipped', reason: 'Not run' } : s)) }));
    } finally {
      off();
      update((r) => ({ ...r, running: false, cancelling: false, finishedAt: Date.now() }));
      // Extracted tokens, script variables, stored secrets and cookies may have changed.
      useStore.getState().bumpVars();
      void useStore.getState().loadEnvs(target.collectionId);
      void useDevTools.getState().loadJar(target.collectionId);
    }
  },

  cancel: async () => {
    const run = get().run;
    if (!run?.running) return;
    set({ run: { ...run, cancelling: true } });
    await yept.runner.cancel(run.runnerId);
  }
}));
