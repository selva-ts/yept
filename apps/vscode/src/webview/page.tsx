import { createRoot } from 'react-dom/client';
import { RequestEditor } from '@yept/ui/components/RequestEditor';
import { ResponsePane } from '@yept/ui/components/ResponsePane';
import { DialogHost } from '@yept/ui/components/Dialogs';
import { EnvEditor } from '@yept/ui/components/EnvEditor';
import { EditorAppearanceContext, preloadCodeEditor } from '@yept/ui/components/CodeEditor';
import { isDirty, useStore } from '@yept/ui/store';
import type { RequestDoc, RunResult } from '@yept/core/shared/model';
import { errorMessage, yept } from '@yept/ui/api';

import { onHistoryEntry, onManageEnvironments, openBodyInEditor, postPanelState } from './bridge';
import { watchPanelState } from './panel-state';
import { useVsCodeAppearance } from './theme';

const openInEditor = (result: RunResult): void => {
  openBodyInEditor(result.runId).catch((error: unknown) => useStore.getState().toast(errorMessage(error), 'error'));
};

function Page(): React.JSX.Element {
  const appearance = useVsCodeAppearance();
  const { tabs, activeId, toasts } = useStore();
  const tab = tabs.find((t) => t.id === activeId);
  return <EditorAppearanceContext.Provider value={appearance}><main className="request-panel">{tab ? <><RequestEditor key={tab.id} tab={tab} /><ResponsePane key={`response-${tab.id}`} tab={tab} onOpenInEditor={openInEditor} /></> : <p role="status">Choose a request with Yept: Open Request.</p>}</main><EnvEditor /><DialogHost /><div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div></EditorAppearanceContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Page />);
window.addEventListener('yept-unavailable', () => useStore.getState().toast('This action is not available in the extension yet', 'error'));
const manage = (collectionId: string): void => {
  const { loadEnvs, openEnvEditor } = useStore.getState();
  void loadEnvs(collectionId).then((list) => { if (list) openEnvEditor(collectionId); });
};
onManageEnvironments(manage);
yept.workspace.onExternalChange((e) => void useStore.getState().applyExternal(e));
const { requestId: id, manageEnvironments, draft, viewRun } = document.getElementById('root')?.dataset ?? {};
if (manageEnvironments) manage(manageEnvironments);
// The History view: Open shows the run as the desktop's history list does; Restore puts its request into the unsaved
// draft (keeping the request's name, as the desktop's Restore request does). Nothing is saved until the user saves.
const restore = async (requestId: string, runId: string): Promise<void> => {
  const { tabs, toast, updateDraft, backToLatest } = useStore.getState();
  const tab = tabs.find((t) => t.id === requestId);
  if (!tab) return;
  if (tab.readOnly) return toast('This request is read-only, so a past run cannot be restored into it.', 'error');
  try {
    const entry = await yept.history.get(runId);
    if (entry.summary.requestId !== requestId) return;
    updateDraft(requestId, (current) => ({ ...structuredClone(entry.doc), name: current.name }));
    backToLatest(requestId);
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
};
// Dev Tools' "Open request" shows the latest run when it is that one, as on the desktop.
const show = (requestId: string, runId: string): void => {
  const { tabs, backToLatest, viewRun } = useStore.getState();
  if (tabs.find((t) => t.id === requestId)?.run?.runId === runId) backToLatest(requestId);
  else void viewRun(requestId, runId);
};
onHistoryEntry((runId, action) => {
  if (!id) return;
  if (action === 'restore') void restore(id, runId);
  else if (action === 'show') show(id, runId);
  else void useStore.getState().viewRun(id, runId);
});
// Ctrl+S (Cmd+S) saves the request and Ctrl+Enter (Cmd+Enter) sends it, as on the desktop, ahead of the code editor's
// own keys (Ctrl+Enter inserts a line in Monaco).
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== 's' && key !== 'enter') return;
  e.preventDefault();
  e.stopPropagation();
  const { activeId, save, send } = useStore.getState();
  if (!activeId) return;
  if (key === 's') void save(activeId);
  else void send(activeId);
}, true);
// The request shows first; the code editor loads once the page is idle, ready for the first response or script.
if (id) {
  void useStore.getState().openRequest(id).then(() => {
    // Edits kept when closing the panel was cancelled come back as unsaved changes.
    if (draft) {
      try { useStore.getState().updateDraft(id, () => JSON.parse(draft) as RequestDoc); } catch { /* not restorable */ }
    }
    // Opened from Dev Tools to show one of its runs.
    if (viewRun) show(id, viewRun);
    watchPanelState(id, () => {
      const tab = useStore.getState().tabs.find((t) => t.id === id);
      if (!tab) return undefined;
      const dirty = isDirty(tab);
      return { name: tab.draft.name, dirty, draft: dirty ? tab.draft : null, viewing: tab.viewing?.summary.runId ?? null };
    }, useStore.subscribe, postPanelState);
  }).finally(() => requestIdleCallback(preloadCodeEditor));
}
