import { useEffect, useMemo, useState } from 'react';
import type { TreeNode } from '@shared/model';
import { errorMessage, yept } from '@yept/ui/api';
import { useStore } from '@yept/ui/store';
import { choose } from '@yept/ui/components/Dialogs';
import { createCollection, deleteCollection, importCollection, openFolder } from '../actions';
import { duplicateNames, folderOf } from '../collections';
import { BrandMark } from './BrandMark';
import { useRunner } from '@yept/ui/runner';

function counts(node: TreeNode): { requests: number; folders: number } {
  return (node.children ?? []).reduce((total, child) => {
    const nested = counts(child);
    return {
      requests: total.requests + (child.kind === 'request' ? 1 : 0) + nested.requests,
      folders: total.folders + (child.kind === 'folder' ? 1 : 0) + nested.folders
    };
  }, { requests: 0, folders: 0 });
}

export function Home(): React.JSX.Element {
  const { snapshot, collectionViewMode, setCollectionViewMode, openCollection, setImportPreview, loadEnvs, openEnvEditor, openSettings, toast } = useStore();
  const [query, setQuery] = useState('');
  const collections = useMemo(() => (snapshot?.collections ?? []).filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase())), [snapshot, query]);
  // Collections from more than one folder are shown in a section per folder, so same-named ones can be told apart.
  const groups = useMemo(() => {
    const byFolder = new Map<string, TreeNode[]>();
    for (const c of collections) byFolder.set(folderOf(c), [...(byFolder.get(folderOf(c)) ?? []), c]);
    return [...byFolder].sort(([a], [b]) => a.localeCompare(b));
  }, [collections]);
  const duplicates = useMemo(() => duplicateNames(snapshot?.collections ?? []), [snapshot]);

  // The ⋯ menus are <details>: close them on a click outside (or on an item) and on Escape.
  useEffect(() => {
    const closeAll = (except?: Element | null): void => {
      document.querySelectorAll<HTMLDetailsElement>('details.collection-more[open]').forEach((d) => { if (d !== except) d.open = false; });
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const owner = target?.closest('details.collection-more') ?? null;
      closeAll(owner && target?.closest('.collection-menu button') ? null : owner);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    const onBlur = (): void => closeAll();
    window.addEventListener('blur', onBlur);
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); window.removeEventListener('blur', onBlur); };
  }, []);

  const exportCollection = async (node: TreeNode): Promise<void> => {
    const choice = await choose(`Export "${node.name}"`, 'Choose whether to include shared environment files. Local secrets are never exported.', ['With environments', 'Without environments']);
    if (choice === null) return;
    try {
      const path = await yept.importer.export(node.id, choice === 0);
      if (path) toast(`Exported to ${path}`);
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  return (
    <div className="home">
      <div className="home-content">
        <div className="home-heading">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h1>Collections</h1>
            <p className="home-subtitle">{snapshot ? `${snapshot.collections.length} collection${snapshot.collections.length === 1 ? '' : 's'} · ${snapshot.root}` : 'Open a folder to work with your API collections.'}</p>
          </div>
          <div className="home-actions">
            {snapshot && <>
              <button className="btn" onClick={() => void openFolder()}>Open folder…</button>
              <button className="btn" onClick={() => void importCollection()}>Import…</button>
              <button className="btn primary" onClick={() => void createCollection()}>+ New collection</button>
            </>}
          </div>
        </div>
        {!snapshot ? (
          <div className="home-empty"><BrandMark size={54} /><h2>Start with your collections</h2><p>Choose a local folder containing OpenCollection YAML or Bruno collections. Your requests stay on your computer and in your chosen Git repository.</p><button className="btn primary" onClick={() => void openFolder()}>Open folder…</button></div>
        ) : (
          <>
            <div className="home-toolbar">
              <input className="input" type="search" placeholder="Search collections" aria-label="Search collections" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="view-toggle" role="group" aria-label="Collection view">
                <button className={collectionViewMode === 'grid' ? 'active' : ''} aria-pressed={collectionViewMode === 'grid'} onClick={() => void setCollectionViewMode('grid')}>Grid</button>
                <button className={collectionViewMode === 'list' ? 'active' : ''} aria-pressed={collectionViewMode === 'list'} onClick={() => void setCollectionViewMode('list')}>List</button>
              </div>
            </div>
            {collections.length === 0 ? (
              <div className="home-empty"><h2>{query ? 'No matching collections' : 'No collections yet'}</h2><p>{query ? 'Try another name.' : 'Create a collection here or import one from another client.'}</p></div>
            ) : (
              groups.map(([folder, nodes]) => (
                <section key={folder} className="collection-group" aria-label={groups.length > 1 ? `Collections in ${folder || 'the workspace folder'}` : undefined}>
                  {groups.length > 1 && <h2 className="collection-group-title"><svg className="node-icon folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.4l1.4 1.5h5.8c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z" fill="currentColor" /></svg> {folder || 'Workspace folder'} <span className="mute">· {nodes.length}</span></h2>}
                  <div className={`collection-browser ${collectionViewMode}`}>
                    {nodes.map((node) => {
                      const total = counts(node);
                      const dup = duplicates.has(node.name.toLowerCase());
                      return <article className="collection-card" key={node.id}>
                        <button className="collection-open" onClick={() => openCollection(node.id)} aria-label={dup && folder ? `Open ${node.name} in ${folder}` : `Open ${node.name}`}>
                          <span className="collection-symbol" aria-hidden="true">◇</span>
                          <span className="collection-summary"><strong>{node.name}</strong><span className="collection-path" title={node.path}>{node.path}</span></span>
                        </button>
                        <div className="collection-meta"><span>{total.requests} request{total.requests === 1 ? '' : 's'}</span><span>{total.folders} folder{total.folders === 1 ? '' : 's'}</span>{node.readOnly && <span className="badge">.bru · read-only</span>}{dup && <span className="badge" title="Another collection in this workspace has the same name">same name elsewhere</span>}</div>
                        <details className="collection-more"><summary aria-label={`More actions for ${node.name}`}>⋯</summary><div className="collection-menu">
                          <button onClick={() => void useRunner.getState().openFor(node)}>Run collection</button>
                          <button onClick={() => openSettings(node.id)}>Collection settings</button>
                          <button onClick={() => void loadEnvs(node.id).then(() => openEnvEditor(node.id))}>Environments</button>
                          <button onClick={() => void exportCollection(node)}>Export</button>
                          {node.readOnly && <button onClick={() => void yept.importer.fromBru(node.id).then(setImportPreview).catch((e) => toast(errorMessage(e), 'error'))}>Convert to YAML</button>}
                          <button className="danger" onClick={() => void deleteCollection(node)}>Move to Recycle Bin</button>
                        </div></details>
                      </article>;
                    })}
                  </div>
                </section>
              ))
            )}
          </>
        )}
        {!!snapshot?.problems.length && <p className="home-problems">{snapshot.problems.length} collection file(s) could not be read. Open a collection to inspect the details.</p>}
      </div>
    </div>
  );
}
