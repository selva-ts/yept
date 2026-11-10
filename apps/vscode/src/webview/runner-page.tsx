import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunnerActionsContext, RunnerView, type RunnerActions } from '@yept/ui/components/RunnerDialog';
import { useRunner } from '@yept/ui/runner';
import { findNode, useStore } from '@yept/ui/store';
import { errorMessage, yept } from '@yept/ui/api';
import { planRun } from '@yept/core/shared/collection-run';
import type { TreeNode, WorkspaceSnapshot } from '@yept/core/shared/model';
import type { RunnerState, RunnerStateMessage } from '../page-reports';
import { callHost, onHostEvent, postToHost } from './bridge';

// The collection runner panel: the desktop's runner, shown in a VS Code panel. The extension does the sending.
const fail = (error: unknown): void => useStore.getState().toast(errorMessage(error), 'error');
const actions: RunnerActions = {
  openRequest: (requestId) => { callHost('runner:open-request', requestId).catch(fail); },
  showInDevTools: (runId) => { callHost('devtools:show-run', runId).catch(fail); }
};

function Page({ unsaved: initial }: { unsaved: string[] }): React.JSX.Element {
  const [unsaved, setUnsaved] = useState(initial);
  useEffect(() => onHostEvent('panels:unsaved', (e) => setUnsaved(e.requestIds)), []);
  const target = useRunner((s) => s.target);
  const toasts = useStore((s) => s.toasts);
  return (
    <RunnerActionsContext.Provider value={actions}>
      <main className="runner-panel" aria-label="Collection runner">
        <div className="dialog-body">{target ? <RunnerView unsavedRequestIds={unsaved} /> : <p role="status">Choose a collection or folder to run in the Collections view.</p>}</div>
      </main>
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </RunnerActionsContext.Provider>
  );
}

const nodeOf = (nodeId: string): TreeNode | undefined => findNode(useStore.getState().snapshot?.collections ?? [], nodeId);

/** Shows the runner for a collection or folder, as the desktop's "Run collection…" does. */
async function show(nodeId: string): Promise<void> {
  const node = nodeOf(nodeId);
  if (!node || node.kind === 'request') return useStore.getState().toast('That folder or collection no longer exists', 'error');
  await useRunner.getState().openFor(node);
}

// What the page shows, for the panel title, the status bar while the panel is hidden, and the extension's tests.
function report(): void {
  const { target, run } = useRunner.getState();
  const node = target && nodeOf(target.nodeId);
  const state: RunnerState = {
    target: target && { nodeId: target.nodeId, name: target.name, kind: target.kind },
    planned: node ? planRun(node).length : 0,
    run: run && target && run.nodeId === target.nodeId
      ? { runnerId: run.runnerId, running: run.running, ended: run.ended, error: run.error, steps: run.steps.map((s) => ({ name: s.name, status: s.status, httpStatus: s.httpStatus, reason: s.reason })) }
      : null
  };
  postToHost({ runnerState: state } satisfies RunnerStateMessage);
}

const { nodeId = '' } = document.getElementById('root')?.dataset ?? {};
const context = await callHost('runner:context') as { snapshot: WorkspaceSnapshot; unsavedRequestIds: string[] };
useStore.setState({ snapshot: context.snapshot });
createRoot(document.getElementById('root')!).render(<Page unsaved={context.unsavedRequestIds} />);
yept.workspace.onExternalChange((e) => void useStore.getState().applyExternal(e));
onHostEvent('runner:open', (e) => void show(e.nodeId));
// A long run changes the page often; the extension hears at most a few times a second, and always when a run ends.
let reportTimer: ReturnType<typeof setTimeout> | undefined;
const reportSoon = (): void => {
  const run = useRunner.getState().run;
  if (!run?.running) {
    clearTimeout(reportTimer);
    reportTimer = undefined;
    return report();
  }
  reportTimer ??= setTimeout(() => { reportTimer = undefined; report(); }, 250);
};
useRunner.subscribe(reportSoon);
useStore.subscribe((s, previous) => { if (s.snapshot !== previous.snapshot) reportSoon(); });
await show(nodeId);
report();
