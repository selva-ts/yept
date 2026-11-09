import type { StepStatus } from '@yept/core/shared/collection-run';

/** One step of a collection run as the runner page shows it. */
export interface ReportedStep {
  name: string;
  status: StepStatus;
  httpStatus?: number;
  reason?: string;
}

/** What the runner page shows: its collection or folder, how many requests it would send, and the run it shows. */
export interface RunnerState {
  target: { nodeId: string; name: string; kind: 'collection' | 'folder' } | null;
  planned: number;
  run: { runnerId: string; running: boolean; ended: string | null; error?: string; steps: ReportedStep[] } | null;
}

export interface RunnerStateMessage {
  runnerState: RunnerState;
}

/** How many Network rows and Console lines the Dev Tools page holds. */
export interface DevToolsState {
  runs: number;
  lines: number;
}

export interface DevToolsStateMessage {
  devtoolsState: DevToolsState;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const STATUSES: StepStatus[] = ['pending', 'running', 'passed', 'failed', 'error', 'no-tests', 'cancelled', 'skipped'];

/** Checks a runner page's state message. Anything else, or a malformed message, is undefined. */
export function checkRunnerState(message: unknown): RunnerState | undefined {
  if (!record(message) || !record(message.runnerState)) return undefined;
  const { target, planned, run } = message.runnerState;
  if (!count(planned)) return undefined;
  if (target !== null && !(record(target) && typeof target.nodeId === 'string' && typeof target.name === 'string' && (target.kind === 'collection' || target.kind === 'folder'))) return undefined;
  if (run !== null) {
    if (!record(run) || typeof run.runnerId !== 'string' || typeof run.running !== 'boolean' || (run.ended !== null && typeof run.ended !== 'string') || !Array.isArray(run.steps)) return undefined;
    if (run.error !== undefined && typeof run.error !== 'string') return undefined;
    for (const s of run.steps) {
      if (!record(s) || typeof s.name !== 'string' || !STATUSES.includes(s.status as StepStatus)) return undefined;
      if ((s.httpStatus !== undefined && !count(s.httpStatus)) || (s.reason !== undefined && typeof s.reason !== 'string')) return undefined;
    }
  }
  return message.runnerState as unknown as RunnerState;
}

/** Checks a Dev Tools page's state message. Anything else, or a malformed message, is undefined. */
export function checkDevToolsState(message: unknown): DevToolsState | undefined {
  if (!record(message) || !record(message.devtoolsState)) return undefined;
  const { runs, lines } = message.devtoolsState;
  return count(runs) && count(lines) ? { runs, lines } : undefined;
}

/** The run's progress for the status bar while the runner panel is hidden: "2/5", or undefined when nothing runs. */
export function runnerProgress(state: RunnerState | undefined): string | undefined {
  const run = state?.run;
  if (!run?.running) return undefined;
  const done = run.steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
  return `${Math.min(done + 1, run.steps.length)}/${run.steps.length}`;
}
