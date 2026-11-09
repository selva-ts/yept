// "Paste cURL": a curl command becomes a new request in a collection or folder. The command is only read here for
// the preview; main parses it again when creating the request. Files the command names are never read.
import { useEffect, useMemo, useState } from 'react';
import type { TreeNode } from '@shared/model';
import { CurlParseError, curlRequestName, parseCurl, type ParsedCurl } from '@shared/curl';
import { errorMessage, yept } from '@yept/ui/api';
import { useStore } from '@yept/ui/store';
import { collectionLabel } from '../collections';

const BODY: Record<ParsedCurl['body']['mode'], string> = {
  none: 'no body', json: 'JSON body', text: 'text body', xml: 'XML body', formUrlEncoded: 'form body', multipartForm: 'multipart body'
};

interface Target {
  id: string;
  label: string;
}

/** Collections and folders a request can be created in, with the folder holding `requestId` (if any). */
function targets(collections: TreeNode[], requestId: string | null): { list: Target[]; parentOf?: string } {
  const list: Target[] = [];
  let parentOf: string | undefined;
  const walk = (node: TreeNode, label: string): void => {
    list.push({ id: node.id, label });
    for (const child of node.children ?? []) {
      if (child.kind === 'request' && child.id === requestId) parentOf = node.id;
      if (child.kind === 'folder') walk(child, `${label} / ${child.name}`);
    }
  };
  for (const c of collections) if (!c.readOnly) walk(c, collectionLabel(c, collections));
  return { list, parentOf };
}

function parse(command: string): { parsed?: ParsedCurl; error?: string } {
  if (!command.trim()) return {};
  try {
    return { parsed: parseCurl(command) };
  } catch (e) {
    return { error: e instanceof CurlParseError ? e.message : errorMessage(e) };
  }
}

export function PasteCurlDialog(): React.JSX.Element | null {
  const { curlPaste, setCurlPaste, snapshot, selectedCollectionId, activeId, mutate, openRequest } = useStore();
  const [command, setCommand] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const { list, parentOf } = useMemo(() => targets(snapshot?.collections ?? [], activeId), [snapshot, activeId]);
  const { parsed, error } = useMemo(() => parse(command), [command]);

  useEffect(() => {
    if (!curlPaste) return;
    setCommand(curlPaste.command);
    setNameEdited(false);
    // The open request's folder, else the collection on screen, else the first one.
    setTarget(parentOf ?? list.find((t) => t.id === selectedCollectionId)?.id ?? list[0]?.id ?? '');
    // Only when the dialog opens: later tree changes must not move the user's choice.
  }, [curlPaste]);
  useEffect(() => {
    if (!nameEdited) setName(parsed ? curlRequestName(parsed) : '');
  }, [parsed, nameEdited]);

  if (!curlPaste) return null;
  const close = (): void => {
    if (!busy) setCurlPaste(null);
  };
  const create = async (): Promise<void> => {
    setBusy(true);
    await mutate(() => yept.requests.createFromCurl(target, name.trim(), command), (id) => {
      setCurlPaste(null);
      if (id) void openRequest(id);
    });
    setBusy(false);
  };
  const auth = parsed?.auth ? `${parsed.auth.mode} auth` : 'auth inherited';
  const canCreate = !!parsed && !!name.trim() && !!target && !busy;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog wide" role="dialog" aria-label="Paste cURL" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="dialog-body curl-body">
          <h3>Paste cURL</h3>
          <p className="mute small" style={{ marginTop: 0 }}>
            Creates a request from a curl command (bash, or Windows cmd as browsers copy it). Nothing is sent, and files named in the command are not read.
          </p>
          <textarea
            className="input mono curl-command"
            rows={8}
            autoFocus
            spellCheck={false}
            value={command}
            placeholder="curl https://api.example.test/users -H 'Accept: application/json'"
            aria-label="cURL command"
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCreate) {
                e.preventDefault();
                void create();
              }
            }}
          />
          {error && <div className="banner warn" role="alert" style={{ margin: '8px 0' }}>{error}</div>}
          {parsed && (
            <div className="curl-preview" aria-label="Preview">
              <div className="curl-summary">
                <span className={`method-tag m-${parsed.method}`}>{parsed.method}</span>
                <span className="mono curl-url">{parsed.url}</span>
              </div>
              <p className="mute small" style={{ margin: '4px 0 0' }}>
                {parsed.headers.length} header{parsed.headers.length === 1 ? '' : 's'} · {BODY[parsed.body.mode]} · {auth}
              </p>
              {parsed.credentials.length > 0 && (
                <div className="banner warn" style={{ margin: '8px 0' }}>
                  <span>
                    The command contains {parsed.credentials.join(', ')}. It is saved in the request file as it is: move it to a secret before you commit (the Git panel's leak check flags it).
                  </span>
                </div>
              )}
              {parsed.notes.length > 0 && (
                <div className="banner info" style={{ margin: '8px 0', display: 'block' }}>
                  <strong>Notes</strong>
                  <ul className="curl-notes">{parsed.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          <label className="field-row" style={{ marginTop: 10 }}>
            <span className="field-label">Request name</span>
            <input className="input" value={name} aria-label="Request name" onChange={(e) => { setName(e.target.value); setNameEdited(true); }} />
          </label>
          <label className="field-row" style={{ marginTop: 6 }}>
            <span className="field-label">Save in</span>
            <select className="input" value={target} aria-label="Save in" onChange={(e) => setTarget(e.target.value)}>
              {list.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          {!list.length && <p className="mute small">No collection to save in: create or open one first.</p>}
        </div>
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={close}>Cancel</button>
          <button className="btn primary" disabled={!canCreate} onClick={() => void create()}>
            {busy ? <span className="spinner" /> : null} Create request
          </button>
        </div>
      </div>
    </div>
  );
}
