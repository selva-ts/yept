// Collection runner: which requests a run sends, in what order, and how each result is judged and counted.
// Pure, so main (which runs) and the renderer (which shows the plan and results) agree.
import type { HttpMethod, RunResult, TestResult, TreeNode } from './model';

/** One request of a run, in tree order. */
export interface RunnerPlanItem {
  requestId: string;
  name: string;
  method: HttpMethod;
  /** Folders between the run's root and the request, joined with " / "; '' directly under it. */
  folder: string;
}

/**
 * passed: tests ran and all passed. failed: a test or assertion failed or errored, a script failed, tests couldn't run on
 * the response, or a request without tests got HTTP 400 or higher. error: no HTTP response (not sent, connection failed,
 * timed out). no-tests: a response under 400 and nothing to test it with; never counted as a pass.
 */
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'no-tests' | 'cancelled' | 'skipped';

export interface TestCounts {
  passed: number;
  failed: number;
  errors: number;
}

export interface RunnerStep extends RunnerPlanItem {
  /** Which pass over the plan this step belongs to, from 1. Always 1 for a run without iterations. */
  iteration: number;
  /** The request's run id: its history entry and Dev tools row. '' until it starts. */
  runId: string;
  status: StepStatus;
  /** One line on why it failed, errored or was skipped. */
  reason?: string;
  httpStatus?: number;
  durationMs?: number;
  tests: TestCounts;
  /** Assertions and tests, for the step's details. */
  testResults: TestResult[];
}

export interface RunnerOptions {
  /** Environment name, or null for none. Captured when the run starts. */
  environment: string | null;
  /** Stop after the first step that failed or errored; the rest are skipped, in every iteration. */
  stopOnFailure: boolean;
  /**
   * A CSV or JSON data file picked in the runner on this machine: one iteration per row, the row's values as runtime
   * variables for that iteration. Never written to collection files.
   */
  dataFile?: string | null;
  /** How many times to run the plan without a data file. 1 when left out. */
  iterations?: number;
  /** Wait between requests, in ms, within and between iterations. */
  delayMs?: number;
}

/** A data file the runner has read: what the dialog shows about it. */
export interface DataFileInfo {
  /** Full path on this machine. */
  path: string;
  /** File name only. */
  name: string;
  format: 'csv' | 'json';
  rows: number;
  /** Variable names, in file order. */
  columns: string[];
}

/** Limits on one run, so a typo can't start a run that never ends. */
export const MAX_ITERATIONS = 1000;
export const MAX_DELAY_MS = 60_000;

const wholeNumber = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** Runner options as they arrive from a page, checked and clamped to the limits above. */
export function cleanRunnerOptions(o: unknown): RunnerOptions {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return {
    environment: typeof r.environment === 'string' ? r.environment : null,
    stopOnFailure: !!r.stopOnFailure,
    dataFile: typeof r.dataFile === 'string' && r.dataFile ? r.dataFile : null,
    iterations: wholeNumber(r.iterations, 1, MAX_ITERATIONS, 1),
    delayMs: wholeNumber(r.delayMs, 0, MAX_DELAY_MS, 0)
  };
}

/** How a run ended: every step ran, it stopped at a failure, or it was cancelled. */
export type RunnerEnd = 'completed' | 'stopped' | 'cancelled';

export interface RunnerSummary {
  /** Steps by status. */
  total: number;
  passed: number;
  failed: number;
  errors: number;
  noTests: number;
  cancelled: number;
  skipped: number;
  tests: TestCounts;
}

/** Sent from main while a collection run goes on. */
export type RunnerEvent =
  | { runnerId: string; type: 'step-start'; index: number; step: RunnerStep; collectionId: string; environment: string; url: string }
  | { runnerId: string; type: 'step-end'; index: number; step: RunnerStep; result: RunResult | null; error?: string; historyError?: string };

export interface RunnerResult {
  steps: RunnerStep[];
  /** How many passes over the plan the run was set up for. */
  iterations: number;
  ended: RunnerEnd;
  summary: RunnerSummary;
}

/** Every request under a collection or folder, depth first in the tree's order (the sidebar's). */
export function planRun(node: TreeNode): RunnerPlanItem[] {
  const out: RunnerPlanItem[] = [];
  const walk = (n: TreeNode, folders: string[]): void => {
    for (const c of n.children ?? []) {
      if (c.kind === 'request') out.push({ requestId: c.id, name: c.name, method: c.method ?? 'GET', folder: folders.join(' / ') });
      else walk(c, [...folders, c.name]);
    }
  };
  if (node.kind === 'request') return [{ requestId: node.id, name: node.name, method: node.method ?? 'GET', folder: '' }];
  walk(node, []);
  return out;
}

export function countTests(tests: TestResult[]): TestCounts {
  return {
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    errors: tests.filter((t) => t.status === 'error').length
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const NO_RESPONSE: Record<Exclude<RunResult['outcome'], 'http' | 'cancelled'>, string> = { network: 'Connection failed', timeout: 'Timed out', prepare_error: 'Not sent' };

/** The verdict on one finished request. */
export function judge(r: RunResult): { status: Exclude<StepStatus, 'pending' | 'running' | 'skipped'>; reason?: string } {
  if (r.outcome === 'cancelled') return { status: 'cancelled', reason: 'Cancelled' };
  if (r.outcome !== 'http') return { status: 'error', reason: `${NO_RESPONSE[r.outcome]}: ${r.error?.message ?? r.outcome}` };
  const t = countTests(r.tests);
  const reasons: string[] = [];
  if (t.failed) reasons.push(`${plural(t.failed, 'test')} failed`);
  if (t.errors) reasons.push(`${plural(t.errors, 'test')} couldn't run`);
  if (r.testsState === 'not-run') reasons.push(r.testsNote ?? 'Tests not run');
  for (const e of r.scriptErrors) reasons.push(`Script error (${e.stage}): ${e.message}`);
  if (reasons.length) return { status: 'failed', reason: reasons.join('; ') };
  if (r.testsState === 'none') {
    // Without tests, the status code is all there is to go on.
    return (r.status ?? 0) >= 400 ? { status: 'failed', reason: `HTTP ${r.status}, and no tests to say that was expected` } : { status: 'no-tests' };
  }
  return { status: 'passed' };
}

/** Whether a step counts as a failure for "stop after the first failure". */
export const isFailure = (s: StepStatus): boolean => s === 'failed' || s === 'error';

export function summarize(steps: RunnerStep[]): RunnerSummary {
  const n = (s: StepStatus): number => steps.filter((x) => x.status === s).length;
  return {
    total: steps.length,
    passed: n('passed'),
    failed: n('failed'),
    errors: n('error'),
    noTests: n('no-tests'),
    cancelled: n('cancelled'),
    skipped: n('skipped'),
    tests: steps.reduce((acc, s) => ({ passed: acc.passed + s.tests.passed, failed: acc.failed + s.tests.failed, errors: acc.errors + s.tests.errors }), { passed: 0, failed: 0, errors: 0 })
  };
}

/** A step not started yet. */
export const pendingStep = (item: RunnerPlanItem, iteration = 1): RunnerStep => ({ ...item, iteration, runId: '', status: 'pending', tests: { passed: 0, failed: 0, errors: 0 }, testResults: [] });

/** Every step of a run: the plan once per iteration. */
export function plannedSteps(plan: RunnerPlanItem[], iterations = 1): RunnerStep[] {
  const out: RunnerStep[] = [];
  for (let i = 1; i <= iterations; i++) for (const item of plan) out.push(pendingStep(item, i));
  return out;
}

/** One iteration's steps, for showing a long run a pass at a time. */
export interface IterationGroup {
  iteration: number;
  /** Index of its first step in the run. */
  start: number;
  steps: RunnerStep[];
  summary: RunnerSummary;
  /** Every step has finished (or was skipped). */
  done: boolean;
}

export function groupByIteration(steps: RunnerStep[]): IterationGroup[] {
  const groups: IterationGroup[] = [];
  let current: { iteration: number; start: number; steps: RunnerStep[] } | undefined;
  steps.forEach((s, i) => {
    if (!current || current.iteration !== s.iteration) {
      current = { iteration: s.iteration, start: i, steps: [] };
      groups.push(current as IterationGroup);
    }
    current.steps.push(s);
  });
  for (const g of groups) {
    g.summary = summarize(g.steps);
    g.done = g.steps.every((s) => s.status !== 'pending' && s.status !== 'running');
  }
  return groups;
}

/** A step filled in from its request's result. Requests a script sent are inside the result and never steps of their own. */
export function finishedStep(step: RunnerStep, r: RunResult): RunnerStep {
  const v = judge(r);
  return { ...step, runId: r.runId, status: v.status, reason: v.reason, httpStatus: r.status, durationMs: r.durationMs, tests: countTests(r.tests), testResults: r.tests };
}
