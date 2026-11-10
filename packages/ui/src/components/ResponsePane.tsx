import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { LARGE_BODY_CHARS, type HistorySummary, type RunResult, type TestResult } from '@shared/model';
import { queryJsonPath, suggestVariableName, variableText } from '@shared/jsonpath';
import { MEDIA_PREVIEW_MAX_BYTES, mediaKind, responseFileName } from '@shared/response-file';
import { errorMessage, formatBytes, formatMs, yept } from '../api';
import FormatWorker from '../format.worker?worker';
import { formatMarkup, markupKind, previewDocument, type MarkupKind } from '../markup';
import { useStore, type Tab } from '../store';
import { CodeEditor } from './CodeEditor';
import { confirm } from './Dialogs';
import { ResponseCookies } from './ResponseCookies';
import { HistoryCompare, JsonFilterBar, MediaPreview, SetVariableDialog } from './ResponseTools';

type View = 'body' | 'headers' | 'cookies' | 'tests' | 'scripts' | 'timeline';
type BodyMode = 'pretty' | 'raw' | 'preview';
/** data: the parsed body, for a JSON body in the Pretty view (the filter runs on it). */
type Shown = { text: string; language: 'json' | 'xml' | 'html' | 'plaintext'; formatting?: boolean; data?: unknown };
// HTML/XML up to this size formats in a few tens of milliseconds, about as long as starting the worker.
const INLINE_FORMAT_LIMIT = 128 * 1024;

const OUTCOME_TITLES: Record<Exclude<RunResult['outcome'], 'http'>, string> = {
  network: 'Connection failed',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
  prepare_error: 'Not sent'
};

function formatSafely(text: string, kind: MarkupKind): string {
  try {
    return formatMarkup(text, kind);
  } catch {
    return text;
  }
}

function parseJson(text: string): { data: unknown } | null {
  try {
    return { data: JSON.parse(text) };
  } catch {
    return null; // not JSON after all (or a truncated stored body)
  }
}

/**
 * The Pretty or Raw text. JSON and small HTML/XML bodies are formatted here; larger HTML/XML in a worker, showing the body
 * as received until it's done.
 */
function useBodyText(r: RunResult | null, kind: MarkupKind | null, mode: 'pretty' | 'raw', force: boolean): Shown | null {
  const [formatted, setFormatted] = useState<{ source: RunResult; text: string } | null>(null);
  const body = r && r.outcome === 'http' && !r.body.binary ? r.body : null;
  // A preview (only the start of the body) is never formatted: the rest is missing.
  const tooLarge = !!body && (!!body.preview || (body.text.length > LARGE_BODY_CHARS && !force));
  const parsed = useMemo(
    () => (body && mode === 'pretty' && !tooLarge && (/json/i.test(body.contentType) || /^\s*[[{]/.test(body.text)) ? parseJson(body.text) : null),
    [body, mode, tooLarge]
  );
  const json = useMemo(() => (parsed ? JSON.stringify(parsed.data, null, 2) : null), [parsed]);
  const inline = useMemo(() => (body && kind && mode === 'pretty' && json === null && body.text.length <= INLINE_FORMAT_LIMIT ? formatSafely(body.text, kind) : null), [body, kind, mode, json]);
  const wanted = mode === 'pretty' && !tooLarge && json === null && inline === null && kind !== null && formatted?.source !== r;

  useEffect(() => {
    if (!wanted || !r || !kind) return;
    const worker = new FormatWorker();
    const done = (text: string): void => {
      setFormatted({ source: r, text });
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ ok: boolean; text?: string }>) => done(e.data.ok ? e.data.text! : r.body.text);
    worker.onerror = () => done(r.body.text);
    worker.postMessage({ text: r.body.text, kind });
    return () => worker.terminate();
  }, [wanted, r, kind]);

  if (!body) return null;
  if (mode === 'raw' || tooLarge) return { text: body.text, language: 'plaintext' };
  if (json !== null) return { text: json, language: 'json', data: parsed!.data };
  if (!kind) return { text: body.text, language: 'plaintext' };
  if (inline !== null) return { text: inline, language: kind };
  return formatted?.source === r ? { text: formatted.text, language: kind } : { text: body.text, language: kind, formatting: true };
}

/** Content-Disposition's file name, else the URL's last segment, else the request name. */
function suggestedName(tab: Tab, r: RunResult): string {
  return responseFileName(r.headers, r.request.url, r.body.contentType, tab.draft.name);
}

/** A selected piece of JSON as a variable value: a quoted string loses its quotes, anything else stays as selected. */
function selectedValue(text: string): string {
  const t = text.trim();
  try {
    return variableText(JSON.parse(t));
  } catch {
    return t;
  }
}

const when = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString() : `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
};

function testCounts(tests: TestResult[]): { passed: number; failed: number; errors: number } {
  const c = { passed: 0, failed: 0, errors: 0 };
  for (const t of tests) c[t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'errors']++;
  return c;
}

function TestsBadge({ r, onClick }: { r: RunResult; onClick: () => void }): React.JSX.Element | null {
  if (r.testsState === 'none') return null;
  if (r.testsState === 'not-run') {
    return (
      <button className="btn ghost small" onClick={onClick} title={r.testsNote}>
        <span className="mute">Tests not run</span>
      </button>
    );
  }
  const c = testCounts(r.tests);
  const total = r.tests.length;
  const cls = c.failed || c.errors ? 'bad-text' : 'ok-text';
  return (
    <button className="btn ghost small" onClick={onClick} title="Show test results">
      <span className={cls}>
        Tests {c.passed}/{total} passed
        {c.errors ? ` · ${c.errors} error${c.errors > 1 ? 's' : ''}` : ''}
      </span>
    </button>
  );
}

/** onOpenInEditor: where the host can show the whole body in an editor (the VS Code extension). Adds "Open in editor". */
export function ResponsePane({ tab, onOpenInEditor }: { tab: Tab; onOpenInEditor?: (result: RunResult) => void }): React.JSX.Element {
  const { toast, loadHistory, toggleHistory, viewRun, backToLatest, restoreFromHistory } = useStore();
  const [view, setView] = useState<View>('body');
  const [bodyMode, setBodyMode] = useState<BodyMode>('pretty');
  const [forceLarge, setForceLarge] = useState(false);
  const run = tab.run;
  const viewing = tab.viewing;
  const r = viewing?.result ?? run?.result ?? null;
  const kind = useMemo(() => (r && r.outcome === 'http' && !r.body.binary ? markupKind(r.body.contentType, r.body.text) : null), [r]);
  // Images and PDFs from the received bytes. A binary one has nothing else to show, so it always shows the preview.
  const media = r && r.outcome === 'http' ? mediaKind(r.body.contentType) : null;
  // Preview stays chosen while the tab keeps sending; a response that can't be previewed shows Pretty meanwhile.
  // A PDF, or a binary image, opens in Preview; Pretty or Raw chosen for it applies to that response only.
  const [mediaMode, setMediaMode] = useState<{ runId: string; mode: BodyMode } | null>(null);
  const previewFirst = !!r && (media === 'pdf' || (media === 'image' && r.body.binary));
  const mode: BodyMode = previewFirst ? (mediaMode?.runId === r.runId && !r.body.binary ? mediaMode.mode : 'preview') : bodyMode === 'preview' && kind !== 'html' && !media ? 'pretty' : bodyMode;
  const shown = useBodyText(r, kind, mode === 'preview' ? 'raw' : mode, forceLarge);
  const partial = !!r?.body.preview;
  const large = !!r && (partial || (r.body.text.length > LARGE_BODY_CHARS && !forceLarge));
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const data = shown?.data;
  const filtered = useMemo(() => (data !== undefined && deferredFilter.trim() ? queryJsonPath(data, deferredFilter) : null), [data, deferredFilter]);
  const filteredText = useMemo(() => (filtered?.ok ? JSON.stringify(filtered.matches.map((m) => m.value), null, 2) : null), [filtered]);
  const [selection, setSelection] = useState('');
  const [variable, setVariable] = useState<{ value: string; name: string } | null>(null);
  // Picking runs to compare: null when not comparing, then up to two run ids.
  const [compare, setCompare] = useState<string[] | null>(null);

  useEffect(() => {
    if (tab.history === null) void loadHistory(tab.id);
  }, [tab.id, tab.history, loadHistory]);

  const historyButton = (
    <button className={`btn small ${tab.historyOpen ? 'active-toggle' : ''}`} onClick={() => toggleHistory(tab.id)} title="Past runs of this request (kept on this machine)">
      History{tab.history?.length ? ` · ${tab.history.length}` : ''}
    </button>
  );

  const copy = async (): Promise<void> => {
    if (!shown) return;
    // What is on screen: the filter's matches while a filter is applied.
    await yept.clipboard.write(mode === 'pretty' && filteredText !== null ? filteredText : shown.text);
    toast('Response body copied');
  };
  const saveToFile = async (): Promise<void> => {
    if (!r) return;
    try {
      const path = await yept.runs.saveBody(r.runId, suggestedName(tab, r));
      if (path) toast(`Saved to ${path}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  /** From the editor's selection (or text passed from its context menu), else the filter's one match. */
  const setAsVariable = (text?: string): void => {
    const picked = (text ?? selection).trim();
    const single = filtered?.ok && filtered.matches.length === 1 ? filtered.matches[0] : null;
    if (picked) setVariable({ value: selectedValue(picked), name: single && variableText(single.value) === selectedValue(picked) ? suggestVariableName(single.path) : 'value' });
    else if (single) setVariable({ value: variableText(single.value), name: suggestVariableName(single.path) });
    else toast(filtered?.ok && filtered.matches.length > 1 ? 'The filter matches more than one value. Narrow it to one, or select a value in the body.' : 'Select a value in the body, or filter the body down to one value.', 'error');
  };
  const pickRun = (runId: string): void =>
    setCompare((c) => {
      const current = c ?? [];
      if (current.includes(runId)) return current.filter((id) => id !== runId);
      return [...current, runId].slice(-2);
    });
  const statusClass = r ? (r.outcome === 'http' ? `s${String(r.status)[0]}` : r.outcome === 'cancelled' ? 'neutral' : 'fail') : 'neutral';

  const content = !r ? (
    <>
      <div />
      <div className="empty">
        {run?.running ? (
          <span className="spinner" />
        ) : (
          <div>
            <p>Send the request to see the response here.</p>
            <p>
              <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
            </p>
            {!!tab.history?.length && <p className="mute">Or open a past run from History.</p>}
          </div>
        )}
      </div>
    </>
  ) : r.outcome !== 'http' ? (
    <>
      <div />
      <div className="pane">
        <div className="error-card">
          <h3>{OUTCOME_TITLES[r.outcome]}</h3>
          <div className="mono">{r.error?.message}</div>
          {r.error?.code && <div className="mute mono" style={{ marginTop: 4 }}>code: {r.error.code}</div>}
          <div className="mute" style={{ marginTop: 8 }}>
            {r.outcome === 'network' && 'No HTTP response was received, so there is no status code.'}
            {r.outcome === 'timeout' && 'The server did not finish responding in time. Change the timeout in Settings.'}
            {r.outcome === 'prepare_error' && 'Nothing was sent to the server.'}
            {r.outcome === 'cancelled' && 'You cancelled the request before it finished.'}
          </div>
        </div>
        {r.testsState === 'not-run' && <p className="mute">{r.testsNote}</p>}
        <ScriptsReport result={r} />
        <Timeline result={r} />
      </div>
    </>
  ) : (
    <>
      <div className="subtabs" role="tablist">
        {(['body', 'headers', 'cookies', 'tests', 'scripts', 'timeline'] as View[]).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={`subtab ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
            {v[0].toUpperCase() + v.slice(1)}
            {v === 'headers' && <span className="count">{r.headers.length}</span>}
            {v === 'cookies' && r.cookieDetails !== undefined && <span className="count">{r.cookieDetails.length}</span>}
            {v === 'tests' && r.testsState === 'ran' && <span className="count">{r.tests.length}</span>}
            {v === 'tests' && r.tests.some((t) => t.status !== 'passed') && <span className="count warn-dot">●</span>}
            {v === 'scripts' && (r.scriptErrors.length > 0 || r.extractions.some((x) => !x.ok)) && <span className="count warn-dot">●</span>}
          </button>
        ))}
        {view === 'body' && !r.body.binary && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
            {(kind === 'html' || media ? (['pretty', 'raw', 'preview'] as const) : (['pretty', 'raw'] as const)).map((m) => (
              <button key={m} className="btn ghost small" aria-pressed={mode === m} onClick={() => (previewFirst ? setMediaMode({ runId: r.runId, mode: m }) : setBodyMode(m))} style={mode === m ? { background: 'var(--sel)' } : undefined}>
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </span>
        )}
      </div>
      {view === 'body' && (
        <div className="pane flush">
          {r.body.truncated && (
            <div className="truncated-note">
              {viewing
                ? `Only the first ${formatBytes(new Blob([r.body.text]).size)} of this ${formatBytes(r.sizeBytes)} response were kept in history.`
                : `The response was larger than the processing limit. Only the first ${formatBytes(r.sizeBytes)} were read, and tests didn't run.`}
            </div>
          )}
          {viewing?.summary.bodyOmitted ? (
            <div className="empty">The body wasn't kept in history (Settings → body size limit is 0).</div>
          ) : media && mode === 'preview' && r.sizeBytes > 0 ? (
            r.body.truncated ? (
              <div className="empty">Only part of this body was {viewing ? 'kept in history' : 'received'}, so it can't be previewed. Save to file keeps what there is.</div>
            ) : r.sizeBytes > MEDIA_PREVIEW_MAX_BYTES ? (
              <div className="empty">
                {formatBytes(r.sizeBytes)} is more than the {formatBytes(MEDIA_PREVIEW_MAX_BYTES)} preview limit · use <b>&nbsp;Save to file…&nbsp;</b> to keep it.
              </div>
            ) : (
              <MediaPreview key={r.runId} result={r} />
            )
          ) : r.body.binary ? (
            <div className="empty">
              Binary response · {formatBytes(r.sizeBytes)} · use <b>&nbsp;Save to file…&nbsp;</b> to keep it.
            </div>
          ) : r.sizeBytes === 0 ? (
            <div className="empty">Empty body</div>
          ) : (
            <>
              {partial ? (
                <div className="truncated-note">
                  Large response: only the first {formatBytes(r.body.text.length)} are shown here.{' '}
                  {onOpenInEditor && (
                    <button className="btn small" onClick={() => onOpenInEditor(r)}>
                      Open in editor
                    </button>
                  )}
                </div>
              ) : mode !== 'raw' && large && (
                <div className="truncated-note">
                  Large response shown as raw text.{' '}
                  <button className="btn small" onClick={() => setForceLarge(true)}>
                    {mode === 'preview' ? 'Preview anyway' : 'Format anyway'}
                  </button>
                </div>
              )}
              {mode === 'pretty' && shown?.formatting && <div className="truncated-note">Formatting…</div>}
              {mode === 'pretty' && shown?.data !== undefined && <JsonFilterBar filter={filter} onFilter={setFilter} result={filtered} onSetVariable={() => setAsVariable()} />}
              {mode === 'preview' && !large ? (
                <HtmlPreview html={r.body.text} />
              ) : (
                <div className="monaco-host">
                  <CodeEditor
                    value={filteredText ?? shown!.text}
                    language={shown!.language}
                    readOnly
                    onSelectionText={setSelection}
                    onSetAsVariable={(text) => setAsVariable(text)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
      {view === 'headers' && (
        <div className="pane">
          <table className="headers-list">
            <tbody>
              {r.headers.map(([k, v], i) => (
                <tr key={i}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === 'cookies' && <ResponseCookies key={`${r.runId}:${!!viewing}`} result={r} historical={!!viewing} />}
      {view === 'tests' && (
        <div className="pane">
          <TestsReport result={r} historical={!!viewing} />
        </div>
      )}
      {view === 'scripts' && (
        <div className="pane">
          <ScriptsReport result={r} />
        </div>
      )}
      {view === 'timeline' && (
        <div className="pane">
          <Timeline result={r} />
        </div>
      )}
    </>
  );

  return (
    <section className={`response ${tab.historyOpen ? 'with-history' : ''}`}>
      <div className="statusbar">
        {run?.running && !viewing && (
          <span className="metric">
            <span className="spinner" /> Sending…
          </span>
        )}
        {r ? (
          <>
            <span className={`status ${statusClass}`}>{r.outcome === 'http' ? `${r.status} ${r.statusText ?? ''}`.trim() : OUTCOME_TITLES[r.outcome]}</span>
            <span className="metric">
              <b>{formatMs(r.durationMs)}</b>
            </span>
            {r.outcome === 'http' && (
              <span className="metric">
                <b>{formatBytes(r.sizeBytes)}</b>
              </span>
            )}
            <span className="metric">{r.environment ? `env: ${r.environment}` : 'no environment'}</span>
            {r.oauth2 && (
              <span className="metric" title={r.oauth2.expiresAt ? `Token expires ${new Date(r.oauth2.expiresAt).toLocaleTimeString()}` : undefined}>
                OAuth2: {r.oauth2.retried ? 'renewed after 401' : { cached: 'cached token', fetched: 'new token', renewed: 'renewed token' }[r.oauth2.token]}
              </span>
            )}
            <TestsBadge r={r} onClick={() => setView('tests')} />
            <ScriptBadges result={r} onClick={() => setView('scripts')} />
          </>
        ) : (
          !run?.running && <span className="mute">Response</span>
        )}
        <span className="spacer" />
        {r?.outcome === 'http' && (
          <>
            {!r.body.binary && !r.body.preview && (
              <button className="btn small" onClick={() => void copy()}>
                Copy
              </button>
            )}
            {!r.body.binary && onOpenInEditor && (
              <button className="btn small" onClick={() => onOpenInEditor(r)} title="Open the whole body in a read-only editor">
                Open in editor
              </button>
            )}
            <button className="btn small" onClick={() => void saveToFile()}>
              Save to file…
            </button>
          </>
        )}
        {historyButton}
      </div>
      {r?.oauth2?.note && <div className="banner warn oauth2-note" role="status">{r.oauth2.note}</div>}
      {viewing && (
        <div className="banner info history-banner">
          <span>
            Run from <b>{when(viewing.summary.startedAt)}</b> in <b>{viewing.summary.environment || 'no environment'}</b>: the stored result, redacted. Nothing was re-sent; the tests shown are the
            results from that run.
          </span>
          <span className="spacer" />
          {!tab.readOnly && (
            <button className="btn small" onClick={() => restoreFromHistory(tab.id)} title="Copy that run's request into the editor (not saved)">
              Restore request
            </button>
          )}
          <button className="btn small" onClick={() => backToLatest(tab.id)}>
            Back to latest
          </button>
        </div>
      )}
      <div className="response-body">
        {tab.historyOpen && <HistoryPanel tab={tab} onOpen={(runId) => void viewRun(tab.id, runId)} compare={compare} onCompare={setCompare} onPick={pickRun} />}
        <div className="response-main">
          {tab.historyOpen && compare?.length === 2 ? <HistoryCompare runIds={[compare[0], compare[1]]} onClose={() => setCompare(null)} /> : content}
        </div>
      </div>
      {variable && <SetVariableDialog collectionId={tab.collectionId} value={variable.value} initialName={variable.name} onClose={() => setVariable(null)} />}
    </section>
  );
}

/**
 * The page rendered in a sandboxed frame. No allow-* flags: no scripts, forms, popups or plugins, and it can't navigate
 * the app. Its own Content-Security-Policy (previewDocument) blocks every request, including images and styles it links to.
 */
function HtmlPreview({ html }: { html: string }): React.JSX.Element {
  const doc = useMemo(() => previewDocument(html), [html]);
  return (
    <>
      <div className="truncated-note">Preview without scripts, forms or links. Nothing is loaded from the network, so linked images and stylesheets are missing.</div>
      <iframe className="html-preview" title="HTML preview" sandbox="" referrerPolicy="no-referrer" srcDoc={doc} />
    </>
  );
}

/** compare: null, or the runs picked so far for comparing (two show the comparison). */
function HistoryPanel({ tab, onOpen, compare, onCompare, onPick }: { tab: Tab; onOpen: (runId: string) => void; compare: string[] | null; onCompare: (c: string[] | null) => void; onPick: (runId: string) => void }): React.JSX.Element {
  const { loadHistory, toast, backToLatest } = useStore();
  const items = tab.history ?? [];
  const current = tab.viewing?.summary.runId ?? tab.run?.runId;
  const clear = async (): Promise<void> => {
    if (!(await confirm('Clear history?', `This deletes all ${items.length} stored runs of "${tab.draft.name}" from this machine.`, 'Clear history', true))) return;
    await yept.history.clear(tab.id);
    backToLatest(tab.id);
    await loadHistory(tab.id);
  };
  const exportAll = async (): Promise<void> => {
    if (!(await confirm('Export history?', 'Exports these runs to a JSON file. Secrets are already redacted, but response bodies may still contain customer or vendor data. Bodies are included.', 'Choose file…'))) return;
    try {
      const path = await yept.history.export(items.map((i) => i.runId), true, `${tab.draft.name}-history.json`);
      if (path) toast(`Exported to ${path}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <aside className="history-panel" aria-label="History">
      <div className="history-head">
        <b>History</b>
        <span className="mute small">this machine</span>
        <span className="spacer" />
        {items.length > 1 && (
          <button className={`btn ghost small ${compare ? 'active-toggle' : ''}`} aria-pressed={!!compare} onClick={() => onCompare(compare ? null : [])} title="Pick two runs to see their differences">
            Compare
          </button>
        )}
        {items.length > 0 && (
          <>
            <button className="btn ghost small" onClick={() => void exportAll()} title="Export to JSON">
              Export
            </button>
            <button className="btn ghost small danger-text" onClick={() => void clear()}>
              Clear
            </button>
          </>
        )}
      </div>
      {items.length === 0 && <p className="mute small" style={{ padding: '0 10px' }}>No runs yet. Every send is kept here (redacted), up to the limit in Settings.</p>}
      {compare && <p className="mute small compare-hint">{compare.length === 0 ? 'Pick two runs to compare.' : compare.length === 1 ? 'Pick one more run.' : 'Pick another run to change the pair.'}</p>}
      {items.map((h: HistorySummary) => (
        <button
          key={h.runId}
          className={`history-item ${compare ? (compare.includes(h.runId) ? 'picked' : '') : h.runId === current ? 'active' : ''}`}
          aria-pressed={compare ? compare.includes(h.runId) : undefined}
          onClick={() => (compare ? onPick(h.runId) : onOpen(h.runId))}
        >
          <span className={`hstatus ${h.outcome === 'http' ? `s${String(h.status)[0]}` : 'fail'}`}>{h.outcome === 'http' ? h.status : OUTCOME_TITLES[h.outcome as Exclude<RunResult['outcome'], 'http'>]}</span>
          <span className="htime">{when(h.startedAt)}</span>
          <span className="hmeta mute">
            {h.environment || 'no env'} · {formatMs(h.durationMs)} · {formatBytes(h.sizeBytes)}
          </span>
          {h.testsState === 'ran' && (
            <span className={`hmeta ${h.failed || h.errors ? 'bad-text' : 'ok-text'}`}>
              tests {h.passed}/{h.passed + h.failed + h.errors}
            </span>
          )}
          {h.testsState === 'not-run' && <span className="hmeta mute">tests not run</span>}
        </button>
      ))}
    </aside>
  );
}

function TestsReport({ result, historical }: { result: RunResult; historical: boolean }): React.JSX.Element {
  if (result.testsState === 'none') {
    return (
      <div className="empty" style={{ height: 'auto', padding: 24 }}>
        <div>
          <p>
            <b>No tests</b>
          </p>
          <p className="mute">Add assertions or JavaScript tests in the request's Tests tab.</p>
        </div>
      </div>
    );
  }
  if (result.testsState === 'not-run') return <p className="mute">{result.testsNote ?? 'Tests were not run.'}</p>;
  const c = testCounts(result.tests);
  return (
    <div>
      <p className="tests-summary">
        <span className="ok-text">{c.passed} passed</span> · <span className={c.failed ? 'bad-text' : 'mute'}>{c.failed} failed</span> · <span className={c.errors ? 'bad-text' : 'mute'}>{c.errors} errors</span>
        {historical && <span className="mute"> · results from that run</span>}
      </p>
      <table className="headers-list tests-table">
        <tbody>
          {result.tests.map((t, i) => (
            <tr key={i} className={`test-${t.status}`}>
              <td style={{ width: 90 }}>
                <span className={`tstatus ${t.status}`}>{t.status === 'passed' ? '✓ passed' : t.status === 'failed' ? '✗ failed' : '⚠ error'}</span>
              </td>
              <td>
                <div>{t.name}</div>
                {t.message && <div className="mono small test-message">{t.message}</div>}
              </td>
              <td className="mute small" style={{ width: 200 }}>
                {t.kind === 'assertion' ? 'assertion' : t.source}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Timeline({ result }: { result: RunResult }): React.JSX.Element {
  return (
    <div className="timeline">
      <ul>
        {result.timeline.map((t, i) => (
          <li key={i}>
            <span className="mute">{formatMs(t.atMs)}</span>
            <span>{t.label}</span>
            <span style={{ wordBreak: 'break-all' }}>{t.detail}</span>
          </li>
        ))}
      </ul>
      {result.request.headers.length > 0 && (
        <>
          <p className="mute" style={{ marginTop: 14, marginBottom: 4 }}>
            Request headers sent
          </p>
          <table className="headers-list">
            <tbody>
              {result.request.headers.map(([k, v], i) => (
                <tr key={i}>
                  <td>{k}</td>
                  <td>{/^authorization$/i.test(k) ? '•••••• (hidden)' : v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {result.requestBody && (
        <>
          <p className="mute" style={{ marginTop: 14, marginBottom: 4 }}>
            Request body sent
          </p>
          <pre className="console-out">{result.requestBody}</pre>
        </>
      )}
    </div>
  );
}

function ScriptBadges({ result, onClick }: { result: RunResult; onClick: () => void }): React.JSX.Element | null {
  const stored = result.extractions.filter((x) => x.ok);
  const failed = result.extractions.filter((x) => !x.ok);
  if (!stored.length && !failed.length && !result.scriptErrors.length) return null;
  return (
    <button className="btn ghost small" onClick={onClick} title="Show script and extraction details">
      {stored.length > 0 && <span className="ok-text">✓ {stored.map((x) => x.variable).join(', ')} {stored.some((x) => x.target === 'secret') ? 'stored as secret' : 'set'}</span>}
      {failed.length > 0 && <span className="bad-text"> ✗ extraction failed</span>}
      {result.scriptErrors.length > 0 && <span className="bad-text"> ✗ script error</span>}
    </button>
  );
}

function ScriptsReport({ result }: { result: RunResult }): React.JSX.Element | null {
  if (!result.extractions.length && !result.scriptErrors.length && !result.console.length) {
    return <p className="mute">No scripts or extractions ran for this request.</p>;
  }
  return (
    <div className="scripts-report">
      {result.extractions.length > 0 && (
        <>
          <h4 className="section-title">Extracted values</h4>
          <table className="headers-list">
            <tbody>
              {result.extractions.map((x, i) => (
                <tr key={i}>
                  <td>
                    {x.ok ? <span className="ok-text">✓</span> : <span className="bad-text">✗</span>} {x.variable}
                  </td>
                  <td>
                    <code>{x.expression}</code>{' '}
                    {x.ok ? <span className="mute">→ {x.target === 'secret' ? 'stored as a local secret for this environment' : 'runtime variable for this session'}</span> : <span className="bad-text">{x.message} — the variable was cleared</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {result.scriptErrors.length > 0 && (
        <>
          <h4 className="section-title">Script errors</h4>
          {result.scriptErrors.map((e, i) => (
            <div key={i} className="error-card" style={{ margin: '6px 0' }}>
              <h3>{e.stage}</h3>
              <div className="mono" style={{ whiteSpace: 'pre-wrap' }}>{e.message}</div>
            </div>
          ))}
        </>
      )}
      {result.console.length > 0 && (
        <>
          <h4 className="section-title">Console</h4>
          <pre className="console-out">
            {result.console.map((c, i) => (
              <div key={i} className={`console-${c.level}`}>
                <span className="mute">[{c.stage}]</span> {c.text}
              </div>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}
