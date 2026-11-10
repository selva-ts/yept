// Response tools beside the body: the JSONPath filter, "Set as variable", the image and PDF preview, and comparing two
// stored runs from history.
import { useEffect, useMemo, useState } from 'react';
import { compareHistory, type HistoryComparison } from '@shared/history-compare';
import { JSONPATH_MAX_MATCHES, type JsonPathResult } from '@shared/jsonpath';
import type { HistoryEntry, RunResult } from '@shared/model';
import { mediaKind, mediaType } from '@shared/response-file';
import { errorMessage, formatMs, yept } from '../api';
import { mediaDocument } from '../markup';
import { useStore } from '../store';
import { DiffViewer } from './CodeEditor';

/** The filter box above a JSON body in the Pretty view. */
export function JsonFilterBar({ filter, onFilter, result, onSetVariable }: { filter: string; onFilter: (f: string) => void; result: JsonPathResult | null; onSetVariable: () => void }): React.JSX.Element {
  const count = result?.ok ? result.matches.length : 0;
  return (
    <div className="json-filter">
      <input
        className="input mono"
        aria-label="Filter with JSONPath"
        placeholder="Filter with JSONPath, e.g. $.items[*].id"
        spellCheck={false}
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onFilter('')}
      />
      {filter && (
        <button className="btn ghost small" aria-label="Clear filter" title="Clear filter (Esc)" onClick={() => onFilter('')}>
          ✕
        </button>
      )}
      <span className={`json-filter-status small ${result && !result.ok ? 'bad-text' : 'mute'}`} role="status">
        {!result ? '' : !result.ok ? result.error : result.capped ? `First ${JSONPATH_MAX_MATCHES.toLocaleString()} matches` : `${count} ${count === 1 ? 'match' : 'matches'}`}
      </span>
      <span className="spacer" />
      <button className="btn small" onClick={onSetVariable} title="Save the selected value, or the one value the filter matches, as a variable of the active environment">
        Set as variable…
      </button>
    </div>
  );
}

const SECRET_NAME = /token|secret|password|passwd|api[-_]?key|auth|session|cookie/i;
const VARIABLE_NAME = /^[A-Za-z_][\w.-]{0,127}$/;

/** Saves a value from the response as a runtime variable or a local secret of the collection's active environment. */
export function SetVariableDialog({ collectionId, value, initialName, onClose }: { collectionId: string; value: string; initialName: string; onClose: () => void }): React.JSX.Element {
  const { envs, loadEnvs, toast } = useStore();
  const list = envs[collectionId];
  const [name, setName] = useState(initialName);
  const [target, setTarget] = useState<'runtime' | 'secret'>(SECRET_NAME.test(initialName) ? 'secret' : 'runtime');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!list) void loadEnvs(collectionId);
  }, [list, loadEnvs, collectionId]);
  const env = list?.active ?? null;
  const validName = VARIABLE_NAME.test(name);

  const save = async (): Promise<void> => {
    if (!env || !validName || busy) return;
    setBusy(true);
    setError('');
    try {
      if (target === 'secret') await yept.env.storeAsSecret(collectionId, env, name, value);
      else await yept.env.setRuntime(collectionId, env, name, value);
      await loadEnvs(collectionId);
      toast(target === 'secret' ? `Stored {{${name}}} as a local secret of "${env}"` : `Set {{${name}}} as a runtime variable of "${env}"`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog set-variable" role="dialog" aria-label="Set as variable" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') void save(); }}>
        <div className="dialog-body">
          <h3>Set as variable</h3>
          {!env ? (
            <p className="bad-text">Choose an environment for this collection first. Runtime variables and local secrets belong to an environment.</p>
          ) : (
            <p className="mute small" style={{ marginTop: 0 }}>
              In environment <b>{env}</b>. Use it as <code>{`{{${validName ? name : 'name'}}}`}</code> in the next requests.
            </p>
          )}
          <div className="field-row">
            <label className="field-label" htmlFor="set-variable-name">Name</label>
            <input id="set-variable-name" className="input mono" aria-label="Variable name" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} />
          </div>
          {name && !validName && <p className="bad-text small">Use letters, digits, _ . or - (starting with a letter or _).</p>}
          <div className="field-row" role="radiogroup" aria-label="Store as" style={{ marginTop: 10 }}>
            <span className="field-label">Store as</span>
            <label>
              <input type="radio" name="set-variable-target" checked={target === 'runtime'} onChange={() => setTarget('runtime')} /> Runtime variable <span className="mute small">(this session, not saved)</span>
            </label>
          </div>
          <div className="field-row">
            <span className="field-label" />
            <label>
              <input type="radio" name="set-variable-target" checked={target === 'secret'} onChange={() => setTarget('secret')} /> Local secret <span className="mute small">(encrypted on this machine)</span>
            </label>
          </div>
          <div className="field-row" style={{ marginTop: 10, alignItems: 'flex-start' }}>
            <span className="field-label">Value</span>
            <code className="set-variable-value" aria-label="Value">
              {target === 'secret' ? `•••••• (${value.length} characters, hidden)` : value.length > 300 ? `${value.slice(0, 300)}… (${value.length} characters)` : value || '(empty)'}
            </code>
          </div>
          {target === 'secret' && <p className="mute small">The environment file only declares the name as a secret; the value stays in this machine's encrypted store.</p>}
          {error && <p className="bad-text small" role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!env || !validName || busy} onClick={() => void save()}>
            Set variable
          </button>
        </div>
      </div>
    </div>
  );
}

function base64Bytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * An image or PDF from the received bytes, in the same sandboxed frame as the HTML preview: no scripts, no network.
 * PDF pages are drawn as images first (see pdf-render.ts).
 */
export function MediaPreview({ result }: { result: RunResult }): React.JSX.Element {
  const kind = mediaKind(result.body.contentType);
  const type = mediaType(result.body.contentType);
  const [state, setState] = useState<{ runId: string; doc?: string; note?: string; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    void (async () => {
      const b64 = await yept.runs.bodyBytes(result.runId);
      if (kind === 'image') return { doc: mediaDocument([{ src: `data:${type};base64,${b64}`, alt: 'Response image' }]) };
      const { renderPdf } = await import('../pdf-render');
      const pdf = await renderPdf(base64Bytes(b64));
      const pages = pdf.pages.length < pdf.pageCount ? `First ${pdf.pages.length} of ${pdf.pageCount} pages.` : `${pdf.pageCount} ${pdf.pageCount === 1 ? 'page' : 'pages'}.`;
      return { doc: mediaDocument(pdf.pages.map((src, i) => ({ src, alt: `Page ${i + 1}` }))), note: `${pages} Pages are drawn as pictures: links and forms don't work, and fonts the PDF doesn't embed use system fonts.` };
    })().then(
      (s) => !cancelled && setState({ runId: result.runId, ...s }),
      (e: unknown) => !cancelled && setState({ runId: result.runId, error: kind === 'pdf' ? `This PDF can't be shown: ${errorMessage(e)}` : errorMessage(e) })
    );
    return () => {
      cancelled = true;
    };
  }, [result.runId, kind, type]);

  const current = state?.runId === result.runId ? state : null;
  return (
    <>
      <div className="truncated-note">
        Preview of the bytes received.{current?.note ? ` ${current.note}` : ''} No scripts run and nothing is loaded from the network.
      </div>
      {current?.error ? (
        <div className="empty">{current.error}</div>
      ) : !current?.doc ? (
        <div className="empty">
          <span className="spinner" /> {kind === 'pdf' ? 'Drawing PDF pages…' : 'Loading image…'}
        </div>
      ) : (
        <iframe className="html-preview media-preview" title={kind === 'pdf' ? 'PDF preview' : 'Image preview'} sandbox="" referrerPolicy="no-referrer" srcDoc={current.doc} />
      )}
    </>
  );
}

const when = (iso: string): string => new Date(iso).toLocaleString();

/** Two stored runs of the request side by side. Only the redacted copies history keeps are compared. */
export function HistoryCompare({ runIds, onClose }: { runIds: [string, string]; onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<{ key: string; left: HistoryEntry; right: HistoryEntry } | null>(null);
  const [error, setError] = useState('');
  const [section, setSection] = useState<'headers' | 'body'>('headers');
  const key = runIds.join('|');

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all(runIds.map((id) => yept.history.get(id))).then(
      ([a, b]) => {
        if (cancelled) return;
        // Older on the left.
        const [left, right] = a.summary.startedAt <= b.summary.startedAt ? [a, b] : [b, a];
        setEntries({ key, left, right });
      },
      (e: unknown) => !cancelled && setError(errorMessage(e))
    );
    return () => {
      cancelled = true;
    };
    // runIds is a new array on each render; key carries its content.
  }, [key]);

  const current = entries?.key === key ? entries : null;
  const c: HistoryComparison | null = useMemo(() => (current ? compareHistory(current.left, current.right) : null), [current]);
  const changedHeaders = c?.headers.changes ?? [];

  return (
    <div className="history-compare" aria-label="Compare runs">
      <div className="banner info compare-note">
        <span>
          Comparing two stored runs. History keeps redacted copies, so secrets show as <code>«secret:name»</code> and auth and cookie headers as <code>«redacted»</code>. Nothing was re-sent.
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={onClose}>
          Close comparison
        </button>
      </div>
      {error && <div className="empty bad-text">{error}</div>}
      {!error && !c && (
        <div className="empty">
          <span className="spinner" />
        </div>
      )}
      {c && current && (
        <>
          <table className="headers-list compare-table">
            <thead>
              <tr>
                <th />
                <th>{when(current.left.summary.startedAt)}</th>
                <th>{when(current.right.summary.startedAt)}</th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.label} className={r.changed ? 'compare-changed' : undefined}>
                  <td>{r.label}</td>
                  <td>{r.label === 'Time' ? formatMs(current.left.result.durationMs) : r.left}</td>
                  <td>{r.label === 'Time' ? formatMs(current.right.result.durationMs) : r.right}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="subtabs" role="tablist">
            <button role="tab" aria-selected={section === 'headers'} className={`subtab ${section === 'headers' ? 'active' : ''}`} onClick={() => setSection('headers')}>
              Headers<span className="count">{changedHeaders.length ? `${changedHeaders.length} changed` : 'same'}</span>
            </button>
            <button role="tab" aria-selected={section === 'body'} className={`subtab ${section === 'body' ? 'active' : ''}`} onClick={() => setSection('body')}>
              Body<span className="count">{c.body.changed ? 'changed' : 'same'}</span>
            </button>
          </div>
          {section === 'headers' && changedHeaders.length > 0 && (
            <div className="compare-changes small" aria-label="Header changes">
              {changedHeaders.map((h) => (
                <span key={h.name} className={`compare-chip ${h.change}`}>
                  {h.name} {h.change}
                </span>
              ))}
            </div>
          )}
          {section === 'body' && (c.body.left.note || c.body.right.note) && (
            <div className="truncated-note">
              {[c.body.left.note && `Older: ${c.body.left.note}.`, c.body.right.note && `Newer: ${c.body.right.note}.`].filter(Boolean).join(' ')}
            </div>
          )}
          <div className="monaco-host compare-diff">
            {section === 'headers' ? (
              <DiffViewer key="headers" original={c.headers.left} modified={c.headers.right} language="plaintext" />
            ) : (
              <DiffViewer key="body" original={c.body.left.text} modified={c.body.right.text} language={c.body.language} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
