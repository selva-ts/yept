// Runs a planned list of requests one after another: stop at the first failure or carry on, and stop on cancel.
// Sending each request is the caller's job (the normal pipeline, with history), so this stays a plain loop.
import { finishedStep, isFailure, pendingStep, summarize, type RunnerEnd, type RunnerPlanItem, type RunnerResult, type RunnerStep } from '../../shared/collection-run';
import type { RunResult } from '../../shared/model';

export interface SequenceOptions {
  stopOnFailure: boolean;
  /** Aborted by Cancel: the request in flight is cancelled by the caller, the ones after it are skipped. */
  signal?: AbortSignal;
  newRunId: () => string;
  /** Sends one request. A throw (the file can't be read, say) makes the step an error. */
  runStep: (item: RunnerPlanItem, runId: string) => Promise<RunResult>;
  onStepStart?: (index: number, step: RunnerStep) => void;
  onStepEnd?: (index: number, step: RunnerStep, result: RunResult | null, error?: string) => void;
}

export async function runSequence(plan: RunnerPlanItem[], opts: SequenceOptions): Promise<RunnerResult> {
  const steps = plan.map(pendingStep);
  let ended: RunnerEnd = 'completed';
  const skipRest = (from: number, reason: string): void => {
    for (let j = from; j < steps.length; j++) steps[j] = { ...steps[j], status: 'skipped', reason };
  };
  for (let i = 0; i < steps.length; i++) {
    if (opts.signal?.aborted) {
      ended = 'cancelled';
      skipRest(i, 'Not run: the run was cancelled');
      break;
    }
    const runId = opts.newRunId();
    steps[i] = { ...steps[i], runId, status: 'running' };
    opts.onStepStart?.(i, steps[i]);
    let result: RunResult | null = null;
    let error: string | undefined;
    try {
      result = await opts.runStep(plan[i], runId);
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
      skipRest(i + 1, `Not run: stopped after "${steps[i].name}" failed`);
      break;
    }
  }
  return { steps, ended, summary: summarize(steps) };
}
