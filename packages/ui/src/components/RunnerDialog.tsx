import { createContext, useContext, useMemo, useState } from 'react';
import { pendingStep, planRun, summarize, type RunnerStep, type StepStatus } from '@shared/collection-run';
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

/**
 * The runner's setup, summary and results for the target chosen with useRunner.openFor. `unsavedRequestIds` lists the
 * requests with unsaved edits where they are not tabs of this page (the VS Code extension's request panels).
 */
export function RunnerView({ unsavedRequestIds, expandedRow }: { unsavedRequestIds?: readonly string[]; expandedRow?: [string | null, (key: string | null) => void] }): React.JSX.Element | null {
  const { snapshot, envs, tabs } = useStore();
  const { target, environment, stopOnFailure, run, setEnvironment, setStopOnFailure, start, cancel } = useRunner();
  const ownRow = useState<string | null>(null);
  const [expanded, setExpanded] = expandedRow ?? ownRow;

  const node = useMemo(() => {
    const c = target && snapshot?.collections.find((x) => x.id === target.collectionId);
    return c && target ? (c.id === target.nodeId ? c : findNode(c.children ?? [], target.nodeId)) : undefined;
  }, [snapshot, target]);
  const plan = useMemo(() => (node ? planRun(node) : []), [node]);
  if (!target) return null;

  const showRun = run?.nodeId === target.nodeId ? run : null;
  const steps = showRun ? showRun.steps : plan.map(pendingStep);
  const running = !!showRun?.running;
  const sum = summarize(steps);
  const done = steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
  const unsaved = unsavedRequestIds
    ? plan.filter((p) => unsavedRequestIds.includes(p.requestId)).length
    : tabs.filter((t) => isDirty(t) && plan.some((p) => p.requestId === t.id)).length;
  const list = envs[target.collectionId];
  const label = target.kind === 'collection' ? 'collection' : 'folder';
  const key = (s: RunnerStep, i: number): string => `${i}:${s.requestId}`;
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
          <button className="btn primary" disabled={!plan.length || !!run?.running} autoFocus onClick={() => { setExpanded(null); void start(); }}>{showRun ? 'Run again' : `Run ${plan.length} request${plan.length === 1 ? '' : 's'}`}</button>
        )}
      </div>
      <p className="mute small runner-help">
        Sends the saved requests one at a time, in sidebar order, with the environment chosen here. A request <b>fails</b> when a test or assertion fails or can&apos;t run, a script fails, or, if it has no tests, the response is HTTP 400 or higher. It&apos;s an <b>error</b> when there is no response (not sent, connection failed, timed out). Requests without tests aren&apos;t counted as passed. Each request goes to its history and to Dev tools.
      </p>
      {unsaved > 0 && <p className="warn-text small" role="status" style={{ margin: '0 0 8px' }}>{unsaved} request{unsaved === 1 ? ' has' : 's have'} unsaved edits. The run sends the saved version{unsaved === 1 ? '' : 's'}.</p>}
      {!plan.length && !showRun && <p className="mute">There are no requests in this {label}.</p>}

      {showRun && (
        <div className="runner-summary" role="status" aria-label="Run summary">
          <div>
            <strong>{running ? `Running ${Math.min(done + 1, steps.length)} of ${steps.length}` : showRun.error ? "The run couldn't finish" : ENDED[showRun.ended ?? 'completed']}</strong>
            <span className="mute"> · {showRun.environment ? `environment ${showRun.environment}` : 'no environment'}{showRun.finishedAt ? ` · ${formatMs(showRun.finishedAt - showRun.startedAt)}` : ''}</span>
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
        </div>
      )}

      {steps.length > 0 && (
        <table className="runner-steps" aria-label="Requests in this run">
          <thead>
            <tr><th>#</th><th>Result</th><th>Method</th><th>Request</th><th>Status</th><th>Tests</th><th>Time</th></tr>
          </thead>
          <tbody>
            {steps.map((s, i) => <StepRow key={key(s, i)} step={s} index={i} open={expanded === key(s, i)} toggle={() => setExpanded(expanded === key(s, i) ? null : key(s, i))} />)}
          </tbody>
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
