import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '@shared/model';
import { errorMessage, yept } from '@yept/ui/api';
import { isDirty, useStore } from '@yept/ui/store';
import { choose, confirm, prompt } from '@yept/ui/components/Dialogs';
import { deleteCollection, importCollection, openFolder } from '../actions';
import { useRunner } from '@yept/ui/runner';

interface MenuState {
  x: number;
  y: number;
  node: TreeNode;
}

function groupIds(n: TreeNode): string[] {
  return n.kind === 'request' ? [] : [n.id, ...(n.children ?? []).flatMap(groupIds)];
}

function GroupIcon({ kind, open }: { kind: TreeNode['kind']; open: boolean }): React.JSX.Element {
  if (kind === 'collection') {
    return (
      <svg className="node-icon collection-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 4.5 8 2l6 2.5L8 7z" fill="currentColor" />
        <path d="M2 8l6 2.5L14 8M2 11.3l6 2.5 6-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg className="node-icon folder-icon" viewBox="0 0 16 16" aria-hidden="true">
      {open
        ? <path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.4l1.4 1.5h5.3c.7 0 1.2.5 1.2 1.2v.8H4.3L1.5 12.6z M4.3 6.5h10.6l-2.6 6.5H1.6z" fill="currentColor" />
        : <path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.4l1.4 1.5h5.8c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z" fill="currentColor" />}
    </svg>
  );
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes;
  const needle = q.toLowerCase();
  return nodes.flatMap((n) => {
    if (n.kind === 'request') return n.name.toLowerCase().includes(needle) || n.path.toLowerCase().includes(needle) ? [n] : [];
    const children = filterTree(n.children ?? [], q);
    return children.length || n.name.toLowerCase().includes(needle) ? [{ ...n, children }] : [];
  });
}

export function Sidebar(): React.JSX.Element {
  const { snapshot, selectedCollectionId, activeId, openRequest, mutate, showHome, tabs, closeTab, openSettings, openEnvEditor, loadEnvs, setGitOpen, gitChanges, setImportPreview, toast, collapsed: collapsedIds, setCollapsed } = useStore();
  const [query, setQuery] = useState('');
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<{ id: string; collection: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Keep the context menu inside the window (it opens at the click, which may be near an edge).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4));
    const y = Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4));
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
  }, [menu]);

  useEffect(() => {
    const close = (): void => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, []);

  const tree = useMemo(() => filterTree((snapshot?.collections ?? []).filter((c) => c.id === selectedCollectionId), query.trim()), [snapshot, selectedCollectionId, query]);

  const convertBru = async (node: TreeNode): Promise<void> => {
    try {
      setImportPreview(await yept.importer.fromBru(node.id));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const exportCollection = async (node: TreeNode): Promise<void> => {
    const choice = await choose(
      `Export "${node.name}"`,
      'Writes the whole collection to one OpenCollection YAML file that Yept or Bruno can import. Secret values are never included.',
      ['With environments', 'Without environments']
    );
    if (choice === null) return;
    try {
      const path = await yept.importer.export(node.id, choice === 0);
      if (path) toast(`Exported to ${path}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const setOpen = (ids: string[], open: boolean): void => {
    const next = new Set(collapsed);
    ids.forEach((id) => (open ? next.delete(id) : next.add(id)));
    setCollapsed([...next]);
  };
  const toggle = (id: string): void => setOpen([id], collapsed.has(id));


  // ---------- actions ----------
  const newRequest = async (parent: TreeNode): Promise<void> => {
    const name = await prompt('New request', 'New request', 'Create');
    if (name) await mutate(() => yept.requests.create(parent.id, name), (id) => id && openRequest(id));
  };
  const newFolder = async (parent: TreeNode): Promise<void> => {
    const name = await prompt('New folder', 'New folder', 'Create');
    if (name) await mutate(() => yept.requests.createFolder(parent.id, name));
  };
  const rename = async (node: TreeNode): Promise<void> => {
    const tab = tabs.find((t) => t.id === node.id);
    if (tab && isDirty(tab)) return useStore.getState().toast('Save or discard the open edits before renaming.', 'error');
    const name = await prompt(`Rename ${node.kind}`, node.name, 'Rename');
    if (name && name !== node.name) {
      await mutate(() => yept.requests.rename(node.id, name), () => {
        if (tab) void useStore.getState().resolveConflict(node.id, 'reload');
      });
    }
  };
  const duplicate = (node: TreeNode): Promise<void> => mutate(() => yept.requests.duplicate(node.id), (id) => id && openRequest(id));
  const remove = async (node: TreeNode): Promise<void> => {
    const what = node.kind === 'folder' ? `the folder "${node.name}" and everything in it` : `"${node.name}"`;
    if (!(await confirm('Move to Recycle Bin?', `This moves ${what} to the Recycle Bin. You can restore it from there.`, 'Move to Recycle Bin', true))) return;
    await mutate(() => yept.requests.remove(node.id), () => {
      if (node.kind === 'request') closeTab(node.id);
      else tabs.filter((t) => t.path.startsWith(node.path + '/')).forEach((t) => closeTab(t.id));
    });
  };

  const collectionOf = (path: string): string => path.split('/')[0];

  // ---------- rendering ----------
  // Arrow keys move between visible rows (tree pattern); Enter opens or toggles; the menu key opens the context menu.
  const focusRow = (id: string | undefined): void => {
    if (!id) return;
    setFocusId(id);
    treeRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>, n: TreeNode, open: boolean, parentId?: string): void => {
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const i = rows.findIndex((el) => el.dataset.id === n.id);
    const isGroup = n.kind !== 'request';
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'ArrowDown') { handled(); focusRow(rows[i + 1]?.dataset.id); }
    else if (e.key === 'ArrowUp') { handled(); focusRow(rows[i - 1]?.dataset.id); }
    else if (e.key === 'Home') { handled(); focusRow(rows[0]?.dataset.id); }
    else if (e.key === 'End') { handled(); focusRow(rows[rows.length - 1]?.dataset.id); }
    else if (e.key === 'ArrowRight' && isGroup) { handled(); if (!open) toggle(n.id); else focusRow(n.children?.[0]?.id); }
    else if (e.key === 'ArrowLeft') { handled(); if (isGroup && open && !query) toggle(n.id); else focusRow(parentId); }
    else if (e.key === 'Enter' || e.key === ' ') { handled(); if (isGroup) toggle(n.id); else void openRequest(n.id); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      handled();
      const box = e.currentTarget.getBoundingClientRect();
      setMenu({ x: box.left + 24, y: box.bottom, node: n });
    }
  };

  const tabStop = focusId ?? activeId ?? tree[0]?.id;
  const row = (n: TreeNode, parentId?: string): React.JSX.Element => {
    const isGroup = n.kind !== 'request';
    const open = !collapsed.has(n.id) || !!query;
    const canDrop = isGroup && drag && drag.id !== n.id && drag.collection === collectionOf(n.path) && !n.readOnly;
    return (
      <div key={n.id} className="tree-node" role="none">
        <div
          className={`tree-row ${n.kind} ${activeId === n.id ? 'active' : ''} ${dropTarget === n.id ? 'drop-target' : ''}`}
          role="treeitem"
          aria-expanded={isGroup ? open : undefined}
          aria-selected={activeId === n.id}
          aria-label={n.kind === 'request' ? `${n.method} ${n.name}` : n.name}
          tabIndex={tabStop === n.id ? 0 : -1}
          data-id={n.id}
          title={n.path}
          draggable={n.kind !== 'collection' && !n.readOnly}
          onFocus={() => setFocusId(n.id)}
          onKeyDown={(e) => onRowKey(e, n, open, parentId)}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            setDrag({ id: n.id, collection: collectionOf(n.path) });
          }}
          onDragEnd={() => {
            setDrag(null);
            setDropTarget(null);
          }}
          onDragOver={(e) => {
            if (!canDrop) return;
            e.preventDefault();
            setDropTarget(n.id);
          }}
          onDragLeave={() => setDropTarget((t) => (t === n.id ? null : t))}
          onDrop={(e) => {
            e.preventDefault();
            const d = drag;
            setDrag(null);
            setDropTarget(null);
            if (d && canDrop) void mutate(() => yept.requests.move(d.id, n.id));
          }}
          onClick={() => (isGroup ? toggle(n.id) : void openRequest(n.id))}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: n });
          }}
        >
          {isGroup ? (
            <>
              <span className="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
              <GroupIcon kind={n.kind} open={open} />
            </>
          ) : (
            <span className={`method-tag m-${n.method}`}>{n.method}</span>
          )}
          <span className="name">{n.name}</span>
          {n.kind === 'collection' && n.readOnly && <span className="badge">.bru · read-only</span>}
        </div>
        {isGroup && open && !!n.children?.length && (
          <div className="tree-children" role="group">
            {n.children.map((c) => row(c, n.id))}
          </div>
        )}
      </div>
    );
  };

  const m = menu?.node;
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="sidebar-home" onClick={showHome}>← All collections</button>
      </div>
      <div className="sidebar-actions">
        <input className="input" placeholder="Search requests" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search requests" />
        <button className="btn" onClick={() => void openFolder()} title="Open another folder">
          Open…
        </button>
      </div>
      <div className="sidebar-actions" style={{ paddingTop: 0 }}>
        <button className="btn small" onClick={() => setGitOpen(true)} title="Commit and push collection changes">
          Git{gitChanges ? <span className="git-count">{gitChanges}</span> : null}
        </button>
        <button className="btn small" onClick={() => void importCollection()} title="Import Postman, Insomnia, OpenAPI or OpenCollection">
          Import…
        </button>
      </div>
      <div className="tree" role="tree" aria-label="Requests" ref={treeRef}>
        {tree.map((n) => row(n))}
        {snapshot && snapshot.collections.length === 0 && (
          <p className="mute" style={{ padding: '8px 12px' }}>
            No collections here. A collection is a folder with an <code>opencollection.yml</code> (or a Bruno <code>bruno.json</code>).
          </p>
        )}
      </div>
      {!!snapshot?.problems.length && (
        <div className="problems">
          <b>{snapshot.problems.length} file(s) couldn't be read</b>
          {snapshot.problems.map((p) => (
            <div key={p.path} title={p.message}>
              {p.path}: {p.message}
            </div>
          ))}
        </div>
      )}
      {menu && m && (
        <div ref={menuRef} className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {m.kind !== 'request' && !m.readOnly && (
            <>
              <button onClick={() => { setMenu(null); void newRequest(m); }}>New request</button>
              <button onClick={() => { setMenu(null); void newFolder(m); }}>New folder</button>
            </>
          )}
          {m.kind === 'request' && <button onClick={() => { setMenu(null); void openRequest(m.id); }}>Open</button>}
          {m.kind !== 'request' && (
            <>
              <button onClick={() => { setMenu(null); setOpen(groupIds(m), true); }}>Expand all</button>
              <button onClick={() => { setMenu(null); setOpen(groupIds(m).slice(1), false); }}>Collapse all</button>
              <hr />
            </>
          )}
          {m.kind !== 'request' && <button onClick={() => { setMenu(null); void useRunner.getState().openFor(m); }}>{m.kind === 'collection' ? 'Run collection…' : 'Run folder…'}</button>}
          {m.kind !== 'request' && <button onClick={() => { setMenu(null); openSettings(m.id); }}>{m.kind === 'collection' ? 'Collection settings…' : 'Folder settings…'}</button>}
          {m.kind === 'collection' && <button onClick={() => { setMenu(null); void loadEnvs(m.id).then(() => openEnvEditor(m.id)); }}>Environments…</button>}
          {m.kind === 'collection' && m.readOnly && <button onClick={() => { setMenu(null); void convertBru(m); }}>Convert to YAML…</button>}
          {m.kind === 'collection' && <button onClick={() => { setMenu(null); void exportCollection(m); }}>Export as single file…</button>}
          {m.kind === 'collection' && (
            <>
              <hr />
              <button className="danger" onClick={() => { setMenu(null); void deleteCollection(m); }}>Move to Recycle Bin</button>
            </>
          )}
          {m.kind !== 'collection' && !m.readOnly && (
            <>
              <button onClick={() => { setMenu(null); void rename(m); }}>Rename…</button>
              {m.kind === 'request' && <button onClick={() => { setMenu(null); void duplicate(m); }}>Duplicate</button>}
              <hr />
              <button className="danger" onClick={() => { setMenu(null); void remove(m); }}>Move to Recycle Bin</button>
            </>
          )}
          {m.readOnly && <button disabled>Read-only (.bru collection)</button>}
        </div>
      )}
    </aside>
  );
}
