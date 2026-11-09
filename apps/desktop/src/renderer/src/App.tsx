import { useEffect, useRef, useState } from 'react';
import { yept } from '@yept/ui/api';
import { useStore } from '@yept/ui/store';
import { Sidebar } from './components/Sidebar';
import { Tabs, closeWithPrompt } from './components/Tabs';
import { RequestEditor } from '@yept/ui/components/RequestEditor';
import { ResponsePane } from '@yept/ui/components/ResponsePane';
import { CommandPalette } from './components/CommandPalette';
import { DialogHost } from '@yept/ui/components/Dialogs';
import { EnvEditor } from '@yept/ui/components/EnvEditor';
import { SettingsEditor } from '@yept/ui/components/SettingsEditor';
import { AppSettingsDialog, OrphansDialog } from './components/AppSettings';
import { GitPanel } from './components/GitPanel';
import { ImportDialog } from './components/ImportDialog';
import { PasteCurlDialog } from './components/PasteCurlDialog';
import { Home } from './components/Home';
import { duplicateNames, folderOf } from './collections';
import { AboutDialog, StatusBar, TitleBar } from './components/AppChrome';
import { prompt } from '@yept/ui/components/Dialogs';
import { DevTools } from '@yept/ui/components/DevTools';
import { useDevTools } from '@yept/ui/devtools';
import { useRunner } from '@yept/ui/runner';
import { RunnerDialog } from '@yept/ui/components/RunnerDialog';

function useDrag(onMove: (e: MouseEvent) => void): [boolean, () => void] {
  const [dragging, setDragging] = useState(false);
  const move = useRef(onMove);
  move.current = onMove;
  useEffect(() => {
    if (!dragging) return;
    const m = (e: MouseEvent): void => move.current(e);
    const up = (): void => setDragging(false);
    window.addEventListener('mousemove', m);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', m);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging]);
  return [dragging, () => setDragging(true)];
}

export function App(): React.JSX.Element {
  const { snapshot, view, selectedCollectionId, tabs, activeId, setSnapshot, applyExternal, save, send, setPalette, showHome, mutate, openRequest, openSettings, openEnvEditor, loadEnvs, loadCollectionViewMode, toasts, gitOpen } = useStore();
  const [sidebarW, setSidebarW] = useState(290);
  const [editorPct, setEditorPct] = useState(48);
  const workbench = useRef<HTMLDivElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const [draggingSide, startSide] = useDrag((e) => setSidebarW(Math.min(520, Math.max(200, e.clientX - (layout.current?.getBoundingClientRect().left ?? 0)))));
  const [draggingSplit, startSplit] = useDrag((e) => {
    const box = workbench.current?.getBoundingClientRect();
    if (box) setEditorPct(Math.min(80, Math.max(20, ((e.clientY - box.top) / box.height) * 100)));
  });
  const active = tabs.find((t) => t.id === activeId && t.collectionId === selectedCollectionId) ?? null;
  const collection = snapshot?.collections.find((c) => c.id === selectedCollectionId) ?? null;

  useEffect(() => {
    void yept.workspace.restore().then((s) => s && setSnapshot(s));
    void loadCollectionViewMode();
    return yept.workspace.onExternalChange((c) => void applyExternal(c));
  }, [setSnapshot, applyExternal, loadCollectionViewMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const run = (fn: () => void): void => {
        // Capture phase + stopPropagation: Yept's shortcuts win over the code editor's own (Ctrl+Enter inserts a line in Monaco).
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (k === 'j' && e.shiftKey) run(() => useDevTools.getState().toggle());
      else if (k === 's' && activeId) run(() => void save(activeId));
      else if (k === 'enter' && activeId) run(() => void send(activeId));
      else if (k === 'k' || k === 'p') run(() => setPalette(true));
      else if (k === 'w' && active) run(() => void closeWithPrompt(active));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activeId, active, save, send, setPalette]);

  // Warn before the window closes with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (useStore.getState().tabs.some((t) => !t.readOnly && JSON.stringify(t.saved) !== JSON.stringify(t.draft))) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <>
      <div className="shell">
        <TitleBar />
        <div className="shell-body">
          <GitPanel key={snapshot?.root ?? ''} />
          {!snapshot || view === 'home' || !collection ? (
            <Home />
          ) : (
            <div ref={layout} className={`app ${gitOpen ? 'source-control-open' : ''}`} style={{ ['--sidebar-w' as string]: `${sidebarW}px` }}>
              {!gitOpen && <><Sidebar />
              <div className={`splitter ${draggingSide ? 'dragging' : ''}`} onMouseDown={startSide} /></>}
              <main className="main">
                <div className="collection-crumb">
                  <button onClick={showHome}>Collections</button>
                  <span aria-hidden="true">/</span>
                  {folderOf(collection) && duplicateNames(snapshot.collections).has(collection.name.toLowerCase()) && <><span>{folderOf(collection)}</span><span aria-hidden="true">/</span></>}
                  <strong>{collection.name}</strong>
                </div>
                <Tabs />
                {active ? (
                  <div ref={workbench} className="workbench split" style={{ ['--editor-h' as string]: `${editorPct}%` }}>
                    <RequestEditor key={active.id} tab={active} />
                    <div className={`hsplit ${draggingSplit ? 'dragging' : ''}`} onMouseDown={startSplit} />
                    <ResponsePane key={`r-${active.id}`} tab={active} />
                  </div>
                ) : (
                  <div className="collection-overview">
                    <div className="overview-icon" aria-hidden="true">◇</div>
                    <p className="eyebrow">COLLECTION</p>
                    <h1>{collection.name}</h1>
                    <p className="mute">Choose a request from the sidebar, or create one to get started.</p>
                    <div className="overview-actions">
                      {!collection.readOnly && <>
                        <button className="btn primary" onClick={() => void prompt('New request', 'New request', 'Create').then((name) => { if (name) void mutate(() => yept.requests.create(collection.id, name), (id) => id && openRequest(id)); })}>+ New request</button>
                        <button className="btn" onClick={() => void prompt('New folder', 'New folder', 'Create').then((name) => { if (name) void mutate(() => yept.requests.createFolder(collection.id, name)); })}>New folder</button>
                      </>}
                      <button className="btn" onClick={() => void useRunner.getState().openFor(collection)}>Run collection</button>
                      <button className="btn" onClick={() => void loadEnvs(collection.id).then(() => openEnvEditor(collection.id))}>Environments</button>
                      <button className="btn" onClick={() => openSettings(collection.id)}>Collection settings</button>
                    </div>
                  </div>
                )}
              </main>
            </div>
          )}
        </div>
        <DevTools />
        <StatusBar />
      </div>
      <CommandPalette />
      <EnvEditor />
      <SettingsEditor />
      <AppSettingsDialog />
      <AboutDialog />
      <ImportDialog />
      <PasteCurlDialog />
      <OrphansDialog />
      <RunnerDialog />
      <DialogHost />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
