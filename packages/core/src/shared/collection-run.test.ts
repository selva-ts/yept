// Collection runner rules: tree order, how a result is judged, and how steps and tests are counted.
import { describe, expect, it } from 'vitest';
import { cleanRunnerOptions, finishedStep, groupByIteration, judge, MAX_DELAY_MS, MAX_ITERATIONS, pendingStep, plannedSteps, planRun, summarize } from './collection-run';
import type { RunResult, TestResult, TreeNode } from './model';

const req = (name: string, method: TreeNode['method'] = 'GET'): TreeNode => ({ id: `id:${name}`, kind: 'request', name, path: `c/${name}.yml`, method });
const folder = (name: string, children: TreeNode[]): TreeNode => ({ id: `folder:${name}`, kind: 'folder', name, path: `c/${name}`, children });

const result =(over: Partial<RunResult> = {}): RunResult => ({
  runId: 'r', outcome: 'http', status: 200, durationMs: 5, sizeBytes: 0, headers: [],
  body: { text: '', contentType: '', truncated: false, binary: false },
  request: { method: 'GET', url: 'https://api.example.test/', headers: [] },
  timeline: [], environment: 'dev', scriptErrors: [], extractions: [], console: [], tests: [], testsState: 'none',
  ...over
});
const test = (status: TestResult['status'], name = status): TestResult => ({ name, kind: 'test', status, source: 'request' });

describe('planRun', () => {
  it('lists requests depth first in the tree order, with the folders between the root and each request', () => {
    const tree: TreeNode = {
      id: 'collection:c', kind: 'collection', name: 'C', path: 'c',
      children: [
        folder('Auth', [req('Login', 'POST')]),
        folder('Bookings', [folder('Admin', [req('Purge', 'DELETE')]), req('Create', 'POST'), req('Read')]),
        folder('Empty', []),
        req('Health')
      ]
    };
    expect(planRun(tree).map((p) => `${p.folder ? `${p.folder} / ` : ''}${p.name} ${p.method}`)).toEqual([
      'Auth / Login POST',
      'Bookings / Admin / Purge DELETE',
      'Bookings / Create POST',
      'Bookings / Read GET',
      'Health GET'
    ]);
  });

  it('names folders relative to the folder being run', () => {
    const plan = planRun(folder('Bookings', [folder('Admin', [req('Purge')]), req('Read')]));
    expect(plan.map((p) => [p.requestId, p.folder])).toEqual([['id:Purge', 'Admin'], ['id:Read', '']]);
  });

  it('gives nothing for an empty folder', () => {
    expect(planRun(folder('Empty', []))).toEqual([]);
  });
});

describe('judge', () => {
  it('passes only when tests ran and all passed', () => {
    expect(judge(result({ testsState: 'ran', tests: [test('passed'), test('passed')] }))).toEqual({ status: 'passed' });
  });

  it('fails on a failed test or one that could not run, with the counts', () => {
    expect(judge(result({ testsState: 'ran', tests: [test('passed'), test('failed'), test('failed'), test('error')] }))).toEqual({ status: 'failed', reason: "2 tests failed; 1 test couldn't run" });
  });

  it('lets tests decide when a 4xx was expected', () => {
    expect(judge(result({ status: 404, testsState: 'ran', tests: [test('passed')] })).status).toBe('passed');
  });

  it('fails a 4xx or 5xx that has no tests, and keeps a 2xx without tests apart from a pass', () => {
    expect(judge(result({ status: 500 }))).toEqual({ status: 'failed', reason: 'HTTP 500, and no tests to say that was expected' });
    expect(judge(result({ status: 204 }))).toEqual({ status: 'no-tests' });
    expect(judge(result({ status: 302 })).status).toBe('no-tests');
  });

  it('fails on a script error even when the tests passed', () => {
    const v = judge(result({ testsState: 'ran', tests: [test('passed')], scriptErrors: [{ stage: 'post-response', message: 'x is not defined' }] }));
    expect(v).toEqual({ status: 'failed', reason: 'Script error (post-response): x is not defined' });
  });

  it('fails when there were tests but they could not run on the response', () => {
    expect(judge(result({ testsState: 'not-run', testsNote: 'Not run: the response exceeded the processing limit' }))).toEqual({ status: 'failed', reason: 'Not run: the response exceeded the processing limit' });
  });

  it('reports a request with no response as an error, not a failed test', () => {
    expect(judge(result({ outcome: 'prepare_error', status: undefined, error: { message: 'Unresolved variable: baseUrl' }, testsState: 'not-run' }))).toEqual({ status: 'error', reason: 'Not sent: Unresolved variable: baseUrl' });
    expect(judge(result({ outcome: 'network', status: undefined, error: { message: 'ECONNREFUSED' } })).reason).toBe('Connection failed: ECONNREFUSED');
    expect(judge(result({ outcome: 'timeout', status: undefined, error: { message: 'Timed out after 100 ms' } })).status).toBe('error');
    expect(judge(result({ outcome: 'cancelled', status: undefined })).status).toBe('cancelled');
  });
});

describe('summarize', () => {
  it('counts steps by result and tests separately; a request without tests adds no passed test', () => {
    const plan = planRun(folder('F', [req('A'), req('B'), req('C'), req('D'), req('E')]));
    const steps = [
      finishedStep(pendingStep(plan[0]), result({ runId: 'a', testsState: 'ran', tests: [test('passed'), test('passed')] })),
      finishedStep(pendingStep(plan[1]), result({ runId: 'b' })),
      finishedStep(pendingStep(plan[2]), result({ runId: 'c', testsState: 'ran', tests: [test('passed'), test('failed'), test('error')] })),
      finishedStep(pendingStep(plan[3]), result({ runId: 'd', outcome: 'network', status: undefined, error: { message: 'down' } })),
      { ...pendingStep(plan[4]), status: 'skipped' as const }
    ];
    expect(summarize(steps)).toEqual({ total: 5, passed: 1, failed: 1, errors: 1, noTests: 1, cancelled: 0, skipped: 1, tests: { passed: 3, failed: 1, errors: 1 } });
    expect(steps[1]).toMatchObject({ runId: 'b', status: 'no-tests', httpStatus: 200, tests: { passed: 0, failed: 0, errors: 0 } });
  });

  it("counts only the request's own tests: requests its scripts sent are not steps", () => {
    const child = result({ runId: 'a.1', testsState: 'ran', tests: [test('failed')] });
    const step = finishedStep(pendingStep(planRun(folder('F', [req('A')]))[0]), result({ runId: 'a', testsState: 'ran', tests: [test('passed')], scriptRequests: [{ stage: 'pre-request', startedAt: 0, result: child }] }));
    expect(summarize([step])).toMatchObject({ total: 1, passed: 1, tests: { passed: 1, failed: 0, errors: 0 } });
  });
});

describe('iterations', () => {
  const plan = planRun(folder('F', [req('A'), req('B')]));

  it('plans every request once per iteration', () => {
    expect(plannedSteps(plan, 3).map((s) => `${s.iteration}${s.name}`)).toEqual(['1A', '1B', '2A', '2B', '3A', '3B']);
    expect(plannedSteps(plan).map((s) => s.iteration)).toEqual([1, 1]);
  });

  it('groups a run by iteration with its own counts', () => {
    const steps = plannedSteps(plan, 2);
    steps[0] = finishedStep(steps[0], result({ runId: 'a', testsState: 'ran', tests: [test('passed')] }));
    steps[1] = finishedStep(steps[1], result({ runId: 'b', status: 500 }));
    steps[2] = { ...steps[2], status: 'running' };
    const groups = groupByIteration(steps);
    expect(groups.map((g) => [g.iteration, g.start, g.steps.length, g.done])).toEqual([[1, 0, 2, true], [2, 2, 2, false]]);
    expect(groups[0].summary).toMatchObject({ passed: 1, failed: 1 });
  });
});

describe('cleanRunnerOptions', () => {
  it('keeps good values and clamps the rest', () => {
    expect(cleanRunnerOptions({ environment: 'dev', stopOnFailure: 1, dataFile: 'C:/data/users.csv', iterations: 3.4, delayMs: 250 }))
      .toEqual({ environment: 'dev', stopOnFailure: true, dataFile: 'C:/data/users.csv', iterations: 3, delayMs: 250 });
    expect(cleanRunnerOptions({ iterations: 0, delayMs: -5 })).toMatchObject({ iterations: 1, delayMs: 0 });
    expect(cleanRunnerOptions({ iterations: 1e9, delayMs: 1e9 })).toMatchObject({ iterations: MAX_ITERATIONS, delayMs: MAX_DELAY_MS });
    expect(cleanRunnerOptions(null)).toEqual({ environment: null, stopOnFailure: false, dataFile: null, iterations: 1, delayMs: 0 });
    expect(cleanRunnerOptions({ environment: 5, dataFile: '', iterations: 'many', delayMs: Number.NaN })).toEqual({ environment: null, stopOnFailure: false, dataFile: null, iterations: 1, delayMs: 0 });
  });
});
