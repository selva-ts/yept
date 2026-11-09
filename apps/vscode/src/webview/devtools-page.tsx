import { createRoot } from 'react-dom/client';
import { DevToolsHostContext, DevToolsTabs, type DevToolsHost } from '@yept/ui/components/DevTools';
import { DialogHost } from '@yept/ui/components/Dialogs';
import { DEV_TABS, useDevTools } from '@yept/ui/devtools';
import { useStore } from '@yept/ui/store';
import { errorMessage } from '@yept/ui/api';
import type { DevToolsState, DevToolsStateMessage } from '../page-reports';
import { callHost, onHostEvent, postToHost } from './bridge';

// The Dev Tools view: the desktop's Console, Network and Cookies tabs, fed by every request panel and the runner.
// Performance is left out: it shows the desktop app's own processes.
const TABS = DEV_TABS.filter((t) => t.id !== 'performance');
const fail = (error: unknown): void => useStore.getState().toast(errorMessage(error), 'error');
const host: DevToolsHost = {
  openRun: (requestId, runId) => callHost('devtools:open-run', requestId, runId).then(() => undefined, fail),
  openCookieSettings: () => { callHost('devtools:open-settings').catch(fail); }
};

function Page(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts);
  return (
    <DevToolsHostContext.Provider value={host}>
      <section className="devtools devtools-view" aria-label="Dev tools"><DevToolsTabs tabs={TABS} /></section>
      <DialogHost />
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </DevToolsHostContext.Provider>
  );
}

const devtools = useDevTools.getState;
// A request panel's send, recorded as the desktop's send from a tab is; the cookie jar may have changed after it.
onHostEvent('devtools:run', (e) => {
  if (e.type === 'start') {
    const { type: _type, ...entry } = e;
    devtools().runStarted(entry);
    return;
  }
  devtools().runFinished(e.runId, e.result, e.error);
  void devtools().loadJar(e.collectionId);
});
// A collection run's steps, recorded as the desktop's runner does.
const runnerCollections = new Map<string, string>();
onHostEvent('runner:event', (e) => {
  if (e.type === 'step-start') {
    runnerCollections.set(e.step.runId, e.collectionId);
    devtools().runStarted({ runId: e.step.runId, requestId: e.step.requestId, requestName: e.step.name, collectionId: e.collectionId, environment: e.environment, method: e.step.method, url: e.url });
    return;
  }
  devtools().runFinished(e.step.runId, e.result, e.result ? undefined : e.error);
  const collectionId = runnerCollections.get(e.step.runId);
  runnerCollections.delete(e.step.runId);
  if (collectionId) void devtools().loadJar(collectionId);
});
// The panel last focused: its request for "Current request only", its collection for the Cookies tab.
onHostEvent('devtools:context', ({ snapshot, requestId, collectionId }) => {
  useStore.setState({ snapshot, activeId: requestId, view: collectionId ? 'collection' : 'home', selectedCollectionId: collectionId });
  // The jar follows the collection's active environment, which may have changed.
  if (collectionId) void devtools().loadJar(collectionId);
});
onHostEvent('devtools:select', ({ runId }) => {
  devtools().select(runId);
  devtools().show('network');
});

createRoot(document.getElementById('root')!).render(<Page />);
// The extension sends this session's earlier sends and the current panel, then new ones as they happen.
await callHost('devtools:ready');
let reported: DevToolsState | undefined;
const report = (): void => {
  const { runs, lines } = devtools();
  if (reported?.runs === runs.length && reported.lines === lines.length) return;
  reported = { runs: runs.length, lines: lines.length };
  // An empty view after Clear lets the extension forget the sends it keeps for the view.
  postToHost({ devtoolsState: reported } satisfies DevToolsStateMessage);
};
useDevTools.subscribe(report);
report();
