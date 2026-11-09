// Dev Tools state: this session's runs and console lines, in memory only (cleared on restart or with Clear).
// Response history stays the permanent record. Drawer height and last tab are remembered in browser storage.
import { create } from 'zustand';
import type { CookieJarView } from '@shared/ipc';
import type { RunResult } from '@shared/model';
import { errorMessage, formatBytes, formatMs, yept } from './api';

export type DevTab = 'console' | 'network' | 'cookies' | 'performance';
export const DEV_TABS: { id: DevTab; label: string }[] = [
  { id: 'console', label: 'Console' },
  { id: 'network', label: 'Network' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'performance', label: 'Performance' }
];
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface ConsoleLine {
  id: number;
  at: number;
  runId: string;
  requestId: string;
  requestName: string;
  level: ConsoleLevel;
  /** Where it came from: 'request', a script stage, 'variables' or 'tests'. */
  source: string;
  text: string;
}

export interface RunEntry {
  runId: string;
  requestId: string;
  requestName: string;
  collectionId: string;
  environment: string;
  method: string;
  url: string;
  startedAt: number;
  running: boolean;
  result: RunResult | null;
  /** Set when the run couldn't start at all (IPC failure). */
  error?: string;
  /** For a request a script sent with bru.sendRequest: the run whose script sent it, and which script. */
  parentRunId?: string;
  stage?: string;
}

export const MAX_RUNS = 500;
export const MAX_LINES = 2000;
const PREFS_KEY = 'yept.devtools';

interface Prefs {
  height: number;
  tab: DevTab;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { height: typeof p.height === 'number' ? p.height : 280, tab: DEV_TABS.some((t) => t.id === p.tab) ? p.tab! : 'console' };
  } catch {
    return { height: 280, tab: 'console' };
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* preference only */
  }
}

let lineSeq = 0;

const LEVELS: Record<string, ConsoleLevel> = { log: 'log', debug: 'log', info: 'info', warn: 'warn', error: 'error' };
const TITLES: Record<Exclude<RunResult['outcome'], 'http'>, string> = { network: 'Connection failed', timeout: 'Timed out', cancelled: 'Cancelled', prepare_error: 'Not sent' };

/** The console lines a finished run adds, in the order things happened. */
export function linesFor(entry: RunEntry, r: RunResult): Omit<ConsoleLine, 'id'>[] {
  const at = Date.now();
  const line = (level: ConsoleLevel, source: string, text: string): Omit<ConsoleLine, 'id'> => ({ at, runId: entry.runId, requestId: entry.requestId, requestName: entry.requestName, level, source, text });
  const out = r.console.filter((c) => c.stage === 'pre-request').map((c) => line(LEVELS[c.level] ?? 'log', c.stage, c.text));
  const sent = (stage: (s: string) => boolean): void => {
    for (const s of (r.scriptRequests ?? []).filter((x) => stage(x.stage))) {
      const c = s.result;
      const outcome = c.outcome === 'http' ? `${c.status} · ${formatMs(c.durationMs)}` : `${TITLES[c.outcome]}: ${c.error?.message ?? ''}`;
      out.push(line(c.outcome === 'http' && (c.status ?? 0) < 400 ? 'info' : 'warn', s.stage, `bru.sendRequest: ${c.request.method} ${c.request.url} → ${outcome}`));
    }
  };
  sent((s) => s === 'pre-request');
  for (const e of r.scriptErrors.filter((x) => x.stage === 'pre-request')) out.push(line('error', e.stage, e.message));
  if (r.oauth2) {
    const got = { cached: 'used the cached token', fetched: 'got a new token', renewed: 'renewed the token' }[r.oauth2.token];
    out.push(line('info', 'oauth2', `OAuth2: ${r.oauth2.retried ? 'the cached token was rejected (401); re-sent once with a new token' : got}${r.oauth2.expiresAt ? `, expires ${new Date(r.oauth2.expiresAt).toLocaleTimeString()}` : ''}`));
  }
  if (r.oauth2?.note) out.push(line('warn', 'oauth2', r.oauth2.note));
  if (r.outcome === 'http') {
    const level: ConsoleLevel = (r.status ?? 0) >= 500 ? 'error' : (r.status ?? 0) >= 400 ? 'warn' : 'info';
    out.push(line(level, 'request', `${r.status} ${r.statusText ?? ''} · ${formatMs(r.durationMs)} · ${formatBytes(r.sizeBytes)}`.replace(/\s+·/, ' ·')));
  } else {
    out.push(line(r.outcome === 'cancelled' ? 'warn' : 'error', 'request', `${TITLES[r.outcome]}: ${r.error?.message ?? ''}`));
  }
  for (const x of r.extractions) {
    const where = x.target === 'secret' ? 'local secret' : 'runtime variable';
    out.push(x.ok ? line('info', 'variables', `Set ${x.variable} (${where}) from ${x.expression}`) : line('warn', 'variables', `${x.variable} not set: ${x.message ?? 'no value'}`));
  }
  for (const c of r.console.filter((x) => x.stage !== 'pre-request')) out.push(line(LEVELS[c.level] ?? 'log', c.stage, c.text));
  sent((s) => s !== 'pre-request');
  for (const e of r.scriptErrors.filter((x) => x.stage !== 'pre-request')) out.push(line('error', e.stage, e.message));
  if (r.testsState === 'ran') {
    const failed = r.tests.filter((t) => t.status === 'failed').length;
    const errors = r.tests.filter((t) => t.status === 'error').length;
    const passed = r.tests.length - failed - errors;
    out.push(line(failed || errors ? 'error' : 'info', 'tests', `Tests: ${passed} passed${failed ? `, ${failed} failed` : ''}${errors ? `, ${errors} error${errors > 1 ? 's' : ''}` : ''}`));
  } else if (r.testsState === 'not-run' && r.testsNote) {
    out.push(line('warn', 'tests', r.testsNote));
  }
  return out;
}

interface DevToolsState extends Prefs {
  open: boolean;
  runs: RunEntry[];
  lines: ConsoleLine[];
  selectedRunId: string | null;
  /** Cookie jar of each collection's active environment, for the Cookies tab and the footer count. */
  jars: Record<string, CookieJarView>;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  show: (tab: DevTab) => void;
  setHeight: (height: number) => void;
  select: (runId: string | null) => void;
  clear: () => void;
  runStarted: (entry: Omit<RunEntry, 'running' | 'result' | 'startedAt'>) => void;
  runFinished: (runId: string, result: RunResult | null, error?: string) => void;
  loadJar: (collectionId: string) => Promise<CookieJarView | undefined>;
  setJar: (jar: CookieJarView) => void;
}

export const useDevTools = create<DevToolsState>((set, get) => ({
  ...loadPrefs(),
  open: false,
  runs: [],
  lines: [],
  selectedRunId: null,
  jars: {},

  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  show: (tab) => {
    set({ open: true, tab });
    savePrefs({ height: get().height, tab });
  },
  setHeight: (height) => {
    set({ height });
    savePrefs({ height, tab: get().tab });
  },
  select: (selectedRunId) => set({ selectedRunId }),
  clear: () => set({ runs: [], lines: [], selectedRunId: null }),

  runStarted: (entry) =>
    set((s) => {
      const full: RunEntry = { ...entry, startedAt: Date.now(), running: true, result: null };
      const start: ConsoleLine = { id: ++lineSeq, at: full.startedAt, runId: full.runId, requestId: full.requestId, requestName: full.requestName, level: 'info', source: 'request', text: `${full.method} ${full.requestName} · env ${full.environment || 'none'}` };
      return { runs: [...s.runs, full].slice(-MAX_RUNS), lines: [...s.lines, start].slice(-MAX_LINES) };
    }),

  runFinished: (runId, result, error) =>
    set((s) => {
      const entry = s.runs.find((r) => r.runId === runId);
      if (!entry) return {};
      const done: RunEntry = { ...entry, running: false, result, error };
      const added = result
        ? linesFor(done, result).map((l) => ({ ...l, id: ++lineSeq }))
        : [{ id: ++lineSeq, at: Date.now(), runId, requestId: entry.requestId, requestName: entry.requestName, level: 'error' as const, source: 'request', text: error ?? 'The run failed' }];
      // Requests the scripts sent get rows of their own, right after the run that sent them.
      const children: RunEntry[] = (result?.scriptRequests ?? []).map((c) => ({
        runId: c.result.runId,
        requestId: entry.requestId,
        requestName: entry.requestName,
        collectionId: entry.collectionId,
        environment: c.result.environment,
        method: c.result.request.method,
        url: c.result.request.url,
        startedAt: c.startedAt,
        running: false,
        result: c.result,
        parentRunId: runId,
        stage: c.stage
      }));
      const runs = s.runs.flatMap((r) => (r.runId === runId ? [done, ...children] : [r]));
      return { runs: runs.slice(-MAX_RUNS), lines: [...s.lines, ...added].slice(-MAX_LINES) };
    }),

  loadJar: async (collectionId) => {
    try {
      const jar = await yept.cookies.list(collectionId);
      get().setJar(jar);
      return jar;
    } catch (e) {
      console.warn('Cookie jar not loaded:', errorMessage(e));
      return undefined;
    }
  },
  setJar: (jar) => set((s) => ({ jars: { ...s.jars, [jar.collectionId]: jar } }))
}));
