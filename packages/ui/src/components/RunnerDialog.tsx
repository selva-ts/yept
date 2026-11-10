import { createContext, useContext, useMemo, useState } from 'react';
import { groupByIteration, MAX_DELAY_MS, MAX_ITERATIONS, plannedSteps, planRun, summarize, type IterationGroup, type RunnerStep, type RunnerSummary, type StepStatus } from '@shared/collection-run';
import { formatMs } from '../api';
import { findNode, isDirty, useStore } from '../store';
import { useDevTools } from '../devtools';
import { useRunner } from '../runner';

const STATUS: Record<StepStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  passed: '✓ Passed',
  failed: '✗ Failed',
  error: '⚠ Error',
  'no-tests': 'No tests',
  cancelled: 'Cancelled',
  skipped: 'Not run'
};

const ENDED = { completed: 'Finished', stopped: 'Stopped after a failure', cancelled: 'Cancelled' };

/** What a step's buttons do. The desktop closes the dialog first; the VS Code extension asks its host. */
export interface RunnerActions {
  openRequest: (requestId: string) => void;
  showInDevTools: (runId: string) => void;
}

export const RunnerActionsContext = createContext<RunnerActions>({
  openRequest: (requestId) => { useRunner.getState().setOpen(false); void useStore.getState().openRequest(requestId); },
  showInDevTools: (runId) => { const d = useDevTools.getState(); d.select(runId); d.show('network'); useRunner.getState().setOpen(false); }
});

function StepRow({ step, index, open, toggle }: { step: RunnerStep; index: number; open: boolean; toggle: () => void }): React.JSX.Element {
  const { openRequest, showInDevTools } = useContext(RunnerActionsContext);
  const tests = step.tests.passed + step.tests.failed + step.tests.errors;
  const done = step.status !== 'pending' && step.status !== 'running' && step.status !== 'skipped';
  return (
    <>
      <tr className={`runner-step ${step.status} ${open ? 'open' : ''}`} onClick={done || step.reason ? toggle : undefined} aria-expanded={done || step.reason ? open : undefined}>
        <td className="mute mono">{index + 1}</td>
        <td><span className={`runner-status ${step.status}`}>{step.status === 'running' && <span className="spinner" aria-hidden="true" />} {STATUS[step.status]}</span></td>
        <td><span className={`method-tag m-${step.method}`}>{step.method}</span></td>
        <td className="runner-name">
          <span>{step.name}</span>
          {step.folder && <span className="mute small"> · {step.folder}</span>}
        </td>
        <td className="mono">{step.httpStatus ?? ''}</td>
        <td className="mono" title={tests ? `${step.tests.passed} passed, ${step.tests.failed} failed, ${step.tests.errors} couldn't run` : undefined}>
          {tests ? <span className={step.tests.failed || step.tests.errors ? 'bad-text' : 'ok-text'}>{step.tests.passed}/{tests}</span> : done ? <span className="mute">—</span> : ''}
        </td>
        <td className="mono mute">{step.durationMs !== undefined ? formatMs(step.durationMs) : ''}</td>
      </tr>
      {open && (
        <tr className="runner-details">
          <td />
          <td colSpan={6}>
            {step.reason && <p className={step.status === 'skipped' || step.status === 'cancelled' ? 'mute' : 'bad-text'} style={{ margin: '0 0 6px' }}>{step.reason}</p>}
            {step.testResults.length > 0 && (
              <ul className="runner-tests">
                {step.testResults.map((t, i) => (
                  <li key={i}>
                    <span className={`tstatus ${t.status}`}>{t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '⚠'}</span> {t.name}
                    {t.kind === 'assertion' && <span className="mute small"> · assertion</span>}
                    {t.message && t.status !== 'passed' && <div className="mono small test-message">{t.message}</div>}
                  </li>
                ))}
              </ul>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn small" onClick={() => openRequest(step.requestId)}>Open request</button>
              {step.runId && <button className="btn small" onClick={() => showInDevTools(step.runId)}>Show in Dev tools</button>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// How many failed iterations open by themselves; more stay closed so a long failing run stays quick to show.
const OPEN_FAILED = 5;

/** An iteration's counts, or '' before any of its steps has finished. */
const iterationText = (sum: RunnerSummary): string => {
  const parts = [`${sum.passed} passed`];
  if (sum.failed) parts.push(`${sum.failed} failed`);
  if (sum.errors) parts.push(`${sum.errors} ${sum.errors === 1 ? 'error' : 'errors'}`);
  if (sum.noTests) parts.push(`${sum.noTests} without tests`);
  if (sum.cancelled) parts.push(`${sum.cancelled} cancelled`);
  if (sum.skipped) parts.push(`${sum.skipped} not run`);
  const finished = sum.passed + sum.failed + sum.errors + sum.noTests + sum.cancelled + sum.skipped;
  return finished ? parts.join(' · ') : '';
};

/** Which iterations show their steps: the one running, the first few that failed, and any opened by hand. */
function openIterations(groups: IterationGroup[], chosen: ReadonlyMap<number, boolean>): Set<number> {
  const open = new Set<number>();
  let failed = 0;
  for (const g of groups) {
    const bad = g.summary.failed + g.summary.errors > 0;
    let show = g.steps.some((s) => s.status === 'running') || (bad && failed < OPEN_FAILED);
    if (bad) failed++;
    const pick = chosen.get(g.iteration);
    if (pick !== undefined) show = pick;
    if (show) open.add(g.iteration);
  }
  return open;
}

/**
 * The runner's setup, summary and results for the target chosen with useRunner.openFor. `unsavedRequestIds` lists the
 * requests with unsaved edits where they are not tabs of this page (the VS Code extension's request panels).
 */
export function RunnerView({ unsavedRequestIds, expandedRow }: { unsavedRequestIds?: readonly string[]; expandedRow?: [string | null, (key: string | null) => void] }): React.JSX.Element | null {
  const { snapshot, envs, tabs } = useStore();
  const { target, environment, stopOnFailure, iterations, delayMs, dataFile, pickingData, run, setEnvironment, setStopOnFailure, setIterations, setDelayMs, pickDataFile, clearDataFile, exportReport, start, cancel } = useRunner();
  const ownRow = useState<string | null>(null);
  const [expanded, setExpanded] = expandedRow ?? ownRow;
  // Iterations opened or closed by hand, for the run shown.
  const [chosen, setChosen] = useState<{ runnerId: string; open: Map<number, boolean> }>({ runnerId: '', open: new Map() });
  const [exporting, setExporting] = useState(false);

  const node = useMemo(() => {
    const c = target && snapshot?.collections.find((x) => x.id === target.collectionId);
    return c && target ? (c.id === target.nodeId ? c : findNode(c.children ?? [], target.nodeId)) : undefined;
  }, [snapshot, target]);
  const plan = useMemo(() => (node ? planRun(node) : []), [node]);
  const showRun = target && run?.nodeId === target.nodeId ? run : null;
  const steps = useMemo(() => (showRun ? showRun.steps : plannedSteps(plan)), [showRun, plan]);
  const groups = useMemo(() => (showRun && showRun.iterations > 1 ? groupByIteration(steps) : null), [showRun, steps]);
  const sum = useMemo(() => summarize(steps), [steps]);
  if (!target) return null;

  const running = !!showRun?.running;
  const data = dataFile?.collectionId === target.collectionId ? dataFile : null;
  const passes = data ? data.rows : iterations;
  const done = steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
  const unsaved = unsavedRequestIds
    ? plan.filter((p) => unsavedRequestIds.includes(p.requestId)).length
    : tabs.filter((t) => isDirty(t) && plan.some((p) => p.requestId === t.id)).length;
  const list = envs[target.collectionId];
  const label = target.kind === 'collection' ? 'collection' : 'folder';
  const key = (s: RunnerStep, i: number): string => `${i}:${s.requestId}`;
  const picks = chosen.runnerId === showRun?.runnerId ? chosen.open : new Map<number, boolean>();
  const openGroups = groups ? openIterations(groups, picks) : null;
  const toggleGroup = (n: number): void => {
    const next = new Map(picks);
    next.set(n, !openGroups?.has(n));
    setChosen({ runnerId: showRun?.runnerId ?? '', open: next });
  };
  const currentIteration = groups?.find((g) => !g.done)?.iteration;
  const doExport = async (format: 'junit' | 'html'): Promise<void> => {
    setExporting(true);
    try { await exportReport(format); } finally { setExporting(false); }
  };
  const runLabel = `Run ${plan.length} request${plan.length === 1 ? '' : 's'}${passes > 1 ? ` × ${passes}` : ''}`;
  const counts = [
    [sum.passed, 'passed', 'ok-text'],
    [sum.failed, 'failed', 'bad-text'],
    [sum.errors, sum.errors === 1 ? 'error' : 'errors', 'bad-text'],
    [sum.noTests, 'without tests', 'mute'],
    [sum.cancelled, 'cancelled', 'mute'],
    [sum.skipped, 'not run', 'mute']
  ] as const;

  return (
    <>
      <h3>Run {label} &quot;{target.name}&quot;</h3>
      <div className="runner-setup">
        <label className="field-row">
          <span className="field-label" style={{ width: 'auto' }}>Environment</span>
          <select className="input" aria-label="Environment" style={{ width: 200, flex: 'none' }} disabled={running} value={environment ?? ''} onChange={(e) => setEnvironment(e.target.value || null)}>
            <option value="">No environment</option>
            {list?.environments.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </label>
        <label className="field-row">
          <input type="checkbox" checked={stopOnFailure} disabled={running} onChange={(e) => setStopOnFailure(e.target.checked)} />
          <span>Stop after the first failure</span>
        </label>
        <span className="spacer" />
        {running ? (
          <button className="btn" disabled={showRun?.cancelling} onClick={() => void cancel()}>{showRun?.cancelling ? 'Cancelling…' : 'Cancel run'}</button>
        ) : (
          <button className="btn primary" disabled={!plan.length || !!run?.running} autoFocus onClick={() => { setExpanded(null); void start(); }}>{showRun ? 'Run again' : runLabel}</button>
        )}
      </div>
      <div className="runner-setup runner-repeat">
        <label className="field-row">
          <span className="field-label" style={{ width: 'auto' }}>Iterations</span>
          <input
            className="input runner-number" type="number" aria-label="Iterations" min={1} max={MAX_ITERATIONS} step={1}
            disabled={running || !!data} value={passes}
            title={data ? 'One iteration per row of the data file' : `Run the requests this many times (at most ${MAX_ITERATIONS})`}
            onChange={(e) => setIterations(e.target.valueAsNumber)}
          />
        </label>
        <label className="field-row">
          <span className="field-label" style={{ width: 'auto' }}>Delay</span>
          <input
            className="input runner-number" type="number" aria-label="Delay between requests (ms)" min={0} max={MAX_DELAY_MS} step={100}
            disabled={running} value={delayMs} title={`Wait between requests, in milliseconds (at most ${MAX_DELAY_MS})`}
            onChange={(e) => setDelayMs(e.target.valueAsNumber)}
          />
          <span className="mute small">ms</span>
        </label>
        <div className="field-row runner-data" role="group" aria-label="Data file">
          <span className="field-label" style={{ width: 'auto' }}>Data file</span>
          {data ? (
            <>
              <span className="runner-data-name" title={data.path}>{data.name}</span>
              <span className="mute small" title={data.columns.join(', ')}>{data.rows} row{data.rows === 1 ? '' : 's'} · {data.columns.length} variable{data.columns.length === 1 ? '' : 's'}</span>
              <button className="btn small" disabled={running || pickingData} onClick={() => void pickDataFile()}>Change…</button>
              <button className="btn small" disabled={running} onClick={clearDataFile}>Remove</button>
            </>
          ) : (
            <button className="btn small" disabled={running || pickingData} onClick={() => void pickDataFile()}>{pickingData ? 'Reading…' : 'Choose CSV or JSON…'}</button>
          )}
        </div>
      </div>
      <p className="mute small runner-help">
        Sends the saved requests one at a time, in sidebar order, with the environment chosen here. With a data file, they run once per row, and the row&apos;s values are variables for that iteration (over environment values). A request <b>fails</b> when a test or assertion fails or can&apos;t run, a script fails, or, if it has no tests, the response is HTTP 400 or higher. It&apos;s an <b>error</b> when there is no response (not sent, connection failed, timed out). Requests without tests aren&apos;t counted as passed. Each request goes to its history and to Dev tools.
      </p>
      {unsaved > 0 && <p className="warn-text small" role="status" style={{ margin: '0 0 8px' }}>{unsaved} request{unsaved === 1 ? ' has' : 's have'} unsaved edits. The run sends the saved version{unsaved === 1 ? '' : 's'}.</p>}
      {!plan.length && !showRun && <p className="mute">There are no requests in this {label}.</p>}

      {showRun && (
        <div className="runner-summary" role="status" aria-label="Run summary">
          <div>
            <strong>{running ? `Running ${Math.min(done + 1, steps.length)} of ${steps.length}${currentIteration ? ` · iteration ${currentIteration} of ${showRun.iterations}` : ''}` : showRun.error ? "The run couldn't finish" : ENDED[showRun.ended ?? 'completed']}</strong>
            <span className="mute">
              {' · '}{showRun.environment ? `environment ${showRun.environment}` : 'no environment'}
              {showRun.dataFile ? ` · data file ${showRun.dataFile}` : ''}
              {showRun.iterations > 1 ? ` · ${showRun.iterations} iterations` : ''}
              {showRun.delayMs ? ` · ${showRun.delayMs} ms between requests` : ''}
              {showRun.finishedAt ? ` · ${formatMs(showRun.finishedAt - showRun.startedAt)}` : ''}
            </span>
          </div>
          {showRun.error && <div className="bad-text">{showRun.error}</div>}
          <div className="runner-counts" aria-label="Requests">
            <span className="mute">Requests:</span>
            {counts.filter(([n], i) => n > 0 || i === 0).map(([n, word, cls]) => <span key={word} className={n ? cls : 'mute'}>{n} {word}</span>)}
          </div>
          <div className="runner-counts" aria-label="Tests">
            <span className="mute">Tests:</span>
            <span className={sum.tests.passed ? 'ok-text' : 'mute'}>{sum.tests.passed} passed</span>
            <span className={sum.tests.failed ? 'bad-text' : 'mute'}>{sum.tests.failed} failed</span>
            {sum.tests.errors > 0 && <span className="bad-text">{sum.tests.errors} couldn&apos;t run</span>}
          </div>
          {!running && !showRun.error && showRun.finishedAt && (
            <div className="runner-export">
              <span className="mute small">Export (secrets stay redacted):</span>
              <button className="btn small" disabled={exporting} onClick={() => void doExport('junit')}>JUnit XML…</button>
              <button className="btn small" disabled={exporting} onClick={() => void doExport('html')}>HTML report…</button>
            </div>
          )}
        </div>
      )}

      {steps.length > 0 && (
        <table className="runner-steps" aria-label="Requests in this run">
          <thead>
            <tr><th>#</th><th>Result</th><th>Method</th><th>Request</th><th>Status</th><th>Tests</th><th>Time</th></tr>
          </thead>
          {groups && openGroups ? (
            groups.map((g) => {
              const open = openGroups.has(g.iteration);
              const bad = g.summary.failed + g.summary.errors > 0;
              const live = g.steps.some((s) => s.status === 'running');
              return (
                <tbody key={g.iteration} className="runner-iteration-group">
                  <tr className={`runner-iteration ${open ? 'open' : ''}`} aria-expanded={open} onClick={() => toggleGroup(g.iteration)}>
                    <td className="mute">{open ? '▾' : '▸'}</td>
                    <td colSpan={6}>
                      <strong>Iteration {g.iteration}</strong>
                      <span className={`small ${bad ? 'bad-text' : g.done && g.summary.passed ? 'ok-text' : 'mute'}`}>
                        {' '}{live && <span className="spinner" aria-hidden="true" />} {iterationText(g.summary) || (g.done ? '' : 'waiting')}
                      </span>
                    </td>
                  </tr>
                  {open && g.steps.map((s, j) => {
                    const i = g.start + j;
                    return <StepRow key={key(s, i)} step={s} index={j} open={expanded === key(s, i)} toggle={() => setExpanded(expanded === key(s, i) ? null : key(s, i))} />;
                  })}
                </tbody>
              );
            })
          ) : (
            <tbody>
              {steps.map((s, i) => <StepRow key={key(s, i)} step={s} index={i} open={expanded === key(s, i)} toggle={() => setExpanded(expanded === key(s, i) ? null : key(s, i))} />)}
            </tbody>
          )}
        </table>
      )}
    </>
  );
}

export function RunnerDialog(): React.JSX.Element | null {
  const { open, target, run, setOpen } = useRunner();
  // The open step stays open when the dialog is closed and opened again.
  const expandedRow = useState<string | null>(null);
  if (!open || !target) return null;
  const running = run?.nodeId === target.nodeId && run.running;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="dialog wide scroll runner-dialog" role="dialog" aria-label="Collection runner" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
        <div className="dialog-body">
          <RunnerView expandedRow={expandedRow} />
        </div>
        <div className="dialog-actions">
          {running && <span className="mute small" style={{ marginRight: 'auto', alignSelf: 'center' }}>Closing this keeps the run going; the status bar shows its progress.</span>}
          <button className="btn" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Status bar item while a run goes on with its dialog closed. */
export function RunnerStatus(): React.JSX.Element | null {
  const { open, run, setOpen } = useRunner();
  if (!run?.running || open) return null;
  const done = run.steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
  return (
    <button className="status-item status-btn" onClick={() => setOpen(true)} title="Show the collection run">
      <span className="spinner" aria-hidden="true" /> Running {Math.min(done + 1, run.steps.length)}/{run.steps.length}
    </button>
  );
}
