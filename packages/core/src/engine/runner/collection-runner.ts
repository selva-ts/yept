// Runs a planned list of requests one after another, once per iteration: stop at the first failure or carry on, wait
// between requests, and stop on cancel (also during a wait).
// Sending each request is the caller's job (the normal pipeline, with history), so this stays a plain loop.
import { finishedStep, isFailure, plannedSteps, summarize, type RunnerEnd, type RunnerPlanItem, type RunnerResult, type RunnerStep } from '../../shared/collection-run';
import type { RunResult } from '../../shared/model';

export interface SequenceOptions {
  stopOnFailure: boolean;
  /** Passes over the plan, from 1. Default 1. */
  iterations?: number;
  /** Wait before every request but the first, in ms. */
  delayMs?: number;
  /** Aborted by Cancel: the request in flight is cancelled by the caller, the ones after it are skipped. */
  signal?: AbortSignal;
  newRunId: () => string;
  /** Sends one request. A throw (the file can't be read, say) makes the step an error. */
  runStep: (item: RunnerPlanItem, runId: string, iteration: number) => Promise<RunResult>;
  onStepStart?: (index: number, step: RunnerStep) => void;
  onStepEnd?: (index: number, step: RunnerStep, result: RunResult | null, error?: string) => void;
}

/** Waits ms, or less when the signal aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function runSequence(plan: RunnerPlanItem[], opts: SequenceOptions): Promise<RunnerResult> {
  const iterations = Math.max(1, Math.floor(opts.iterations ?? 1));
  const steps = plannedSteps(plan, iterations);
  let ended: RunnerEnd = 'completed';
  const skipRest = (from: number, reason: string): void => {
    for (let j = from; j < steps.length; j++) steps[j] = { ...steps[j], status: 'skipped', reason };
  };
  for (let i = 0; i < steps.length; i++) {
    if (i > 0 && opts.delayMs) await pause(opts.delayMs, opts.signal);
    if (opts.signal?.aborted) {
      ended = 'cancelled';
      skipRest(i, 'Not run: the run was cancelled');
      break;
    }
    const item = plan[i % plan.length];
    const runId = opts.newRunId();
    steps[i] = { ...steps[i], runId, status: 'running' };
    opts.onStepStart?.(i, steps[i]);
    let result: RunResult | null = null;
    let error: string | undefined;
    try {
      result = await opts.runStep(item, runId, steps[i].iteration);
      steps[i] = finishedStep(steps[i], result);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      steps[i] = { ...steps[i], status: opts.signal?.aborted ? 'cancelled' : 'error', reason: opts.signal?.aborted ? 'Cancelled' : error };
    }
    opts.onStepEnd?.(i, steps[i], result, error);
    if (steps[i].status === 'cancelled' || (opts.signal?.aborted && i < steps.length - 1)) {
      ended = 'cancelled';
      skipRest(i + 1, 'Not run: the run was cancelled');
      break;
    }
    if (opts.stopOnFailure && isFailure(steps[i].status) && i < steps.length - 1) {
      ended = 'stopped';
      skipRest(i + 1, `Not run: stopped after "${steps[i].name}"${iterations > 1 ? ` (iteration ${steps[i].iteration})` : ''} failed`);
      break;
    }
  }
  return { steps, iterations, ended, summary: summarize(steps) };
}
