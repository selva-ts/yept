// Collection runner state: the dialog's target and choices, and the current (or last) run. The host (the desktop's main
// process or the VS Code extension) does the sending; its progress events fill in the steps and add each request to Dev
// tools, like a send from a tab.
import { create } from 'zustand';
import { pendingStep, planRun, type RunnerEnd, type RunnerEvent, type RunnerStep } from '@shared/collection-run';
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

interface RunnerState {
  open: boolean;
  target: RunnerTarget | null;
  /** Chosen environment; null for none. */
  environment: string | null;
  /** The last environment picked in the runner, kept for the collection's next run. */
  picked: { collectionId: string; name: string | null } | null;
  stopOnFailure: boolean;
  run: CollectionRun | null;

  openFor: (node: TreeNode) => Promise<void>;
  setOpen: (open: boolean) => void;
  setEnvironment: (name: string | null) => void;
  setStopOnFailure: (stop: boolean) => void;
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
    set({ open: true, target: { nodeId: node.id, collectionId: collection.id, kind: node.kind, name: node.name }, run: get().run?.nodeId === node.id ? get().run : null });
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

  start: async () => {
    const { target, environment, stopOnFailure } = get();
    if (!target || get().run?.running) return;
    const collection = useStore.getState().snapshot?.collections.find((c) => c.id === target.collectionId);
    const node = collection && (collection.id === target.nodeId ? collection : findNode(collection.children ?? [], target.nodeId));
    if (!node) return useStore.getState().toast('That folder or collection no longer exists', 'error');
    const runnerId = crypto.randomUUID();
    const update = (fn: (r: CollectionRun) => CollectionRun): void => set((s) => (s.run?.runnerId === runnerId ? { run: fn(s.run) } : {}));
    set({ run: { runnerId, nodeId: target.nodeId, environment: environment ?? '', stopOnFailure, running: true, cancelling: false, steps: planRun(node).map(pendingStep), ended: null, startedAt: Date.now(), finishedAt: null } });
    const devtools = useDevTools.getState();
    const app = useStore.getState();
    const onEvent = (e: RunnerEvent): void => {
      if (e.runnerId !== runnerId) return;
      update((r) => {
        const steps = [...r.steps];
        steps[e.index] = e.step;
        return { ...r, steps };
      });
      if (e.type === 'step-start') {
        devtools.runStarted({ runId: e.step.runId, requestId: e.step.requestId, requestName: e.step.name, collectionId: e.collectionId, environment: e.environment, method: e.step.method, url: e.url });
        return;
      }
      devtools.runFinished(e.step.runId, e.result, e.result ? undefined : e.error);
      if (e.historyError) app.toast(e.historyError, 'error');
      // An open tab's history list gets the new run.
      if (useStore.getState().tabs.find((t) => t.id === e.step.requestId)?.history) void useStore.getState().loadHistory(e.step.requestId);
    };
    const off = yept.runner.onEvent(onEvent);
    try {
      const result = await yept.runner.start(runnerId, target.nodeId, { environment, stopOnFailure });
      update((r) => ({ ...r, steps: result.steps, ended: result.ended }));
    } catch (e) {
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
