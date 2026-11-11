// Dev Tools: a bottom drawer with this session's Console and Network activity, the cookie jar of the current
// collection and environment, and app performance. Everything shown is masked like history.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppMetrics } from '@shared/ipc';
import type { CookieView, NetworkHop, PhaseTimings, RunResult } from '@shared/model';
import { toCurl, type CurlRequest } from '@shared/curl';
import { SNIPPET_LANGUAGES, snippetLabel, toSnippet, type SnippetLanguage } from '@shared/snippets';
import { rawRequestHead, rawResponseHead } from '@shared/raw-http';
import { errorMessage, formatBytes, formatMs, yept } from '../api';
import { useStore } from '../store';
import { DEV_TABS, useDevTools, type ConsoleLevel, type DevTab, type RunEntry } from '../devtools';
import { confirm } from './Dialogs';

const time = (at: number): string => {
  const d = new Date(at);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/** Opens the request and shows that run (the latest one, or the stored run from history). */
async function openRun(requestId: string, runId: string): Promise<void> {
  const s = useStore.getState();
  await s.openRequest(requestId);
  const tab = useStore.getState().tabs.find((t) => t.id === requestId);
  if (!tab) return;
  if (tab.run?.runId === runId) s.backToLatest(requestId);
  else await s.viewRun(requestId, runId);
}

/**
 * What Dev Tools asks of the page it is in: show a run in its request, and open the cookie settings. The desktop does both
 * in its own window; the VS Code extension's Dev Tools view asks its host.
 */
export interface DevToolsHost {
  openRun: (requestId: string, runId: string) => void | Promise<void>;
  openCookieSettings: () => void;
}

export const DevToolsHostContext = createContext<DevToolsHost>({ openRun, openCookieSettings: () => useStore.getState().setAppSettingsOpen(true) });

function useCurrentCollection(): string | null {
  const { view, selectedCollectionId } = useStore();
  return view === 'collection' ? selectedCollectionId : null;
}

/** A value shown as dots until clicked. */
function Masked({ value }: { value: string }): React.JSX.Element {
  const [shown, setShown] = useState(false);
  return shown ? (
    <span className="masked shown" title="Click to hide" onClick={() => setShown(false)}>{value}</span>
  ) : (
    <button className="masked" title="Click to show this value" onClick={() => setShown(true)}>••••••</button>
  );
}

const SENSITIVE_RESPONSE = /^set-cookie$/i;

function HeaderTable({ headers, reveal = SENSITIVE_RESPONSE }: { headers: [string, string][]; reveal?: RegExp }): React.JSX.Element {
  if (!headers.length) return <p className="mute">None</p>;
  return (
    <table className="headers-list">
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}>
            <td>{k}</td>
            <td>{reveal.test(k) ? <Masked value={v} /> : v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- Console ----------

const LEVEL_LIST: ConsoleLevel[] = ['log', 'info', 'warn', 'error'];
const LONG = 500;

function ConsoleText({ text }: { text: string }): React.JSX.Element {
  const [more, setMore] = useState(false);
  if (text.length <= LONG || more) return <span className="dt-text">{text}</span>;
  return (
    <span className="dt-text">
      {text.slice(0, LONG)}…{' '}
      <button className="link-btn" onClick={(e) => { e.stopPropagation(); setMore(true); }}>show more ({formatBytes(text.length)})</button>
    </span>
  );
}

function ConsoleTab(): React.JSX.Element {
  const lines = useDevTools((s) => s.lines);
  const activeId = useStore((s) => s.activeId);
  const host = useContext(DevToolsHostContext);
  const [levels, setLevels] = useState<Record<ConsoleLevel, boolean>>({ log: true, info: true, warn: true, error: true });
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const [search, setSearch] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lines.filter((l) => levels[l.level] && (!onlyCurrent || l.requestId === activeId) && (!q || l.text.toLowerCase().includes(q) || l.requestName.toLowerCase().includes(q)));
  }, [lines, levels, onlyCurrent, activeId, search]);

  // Follow new lines while scrolled to the bottom, like a terminal.
  useEffect(() => {
    if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [shown.length]);

  return (
    <div className="dt-body">
      <div className="dt-toolbar">
        {LEVEL_LIST.map((l) => (
          <label key={l} className={`dt-level ${l}`}>
            <input type="checkbox" checked={levels[l]} onChange={(e) => setLevels({ ...levels, [l]: e.target.checked })} /> {l}
          </label>
        ))}
        <label className="dt-level">
          <input type="checkbox" checked={onlyCurrent} onChange={(e) => setOnlyCurrent(e.target.checked)} /> Current request only
        </label>
        <input className="input dt-search" placeholder="Filter" aria-label="Filter console" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div
        ref={list}
        className="dt-console"
        role="log"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!shown.length && <div className="empty">{lines.length ? 'No lines match the filters.' : 'Send a request: script output, variables, tests and errors show here.'}</div>}
        {shown.map((l) => (
          <div key={l.id} className={`dt-line ${l.level}`} onClick={() => void host.openRun(l.requestId, l.runId)} title="Open this run">
            <span className="dt-time">{time(l.at)}</span>
            <span className="dt-badge">{l.level}</span>
            <span className="dt-req">{l.requestName}</span>
            <span className="dt-src">{l.source}</span>
            <ConsoleText text={l.text} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Network ----------

function outcomeLabel(e: RunEntry): { text: string; cls: string } {
  if (e.running) return { text: '…', cls: 'neutral' };
  const r = e.result;
  if (!r) return { text: 'Failed', cls: 'fail' };
  if (r.outcome === 'http') return { text: String(r.status), cls: `s${String(r.status)[0]}` };
  return { text: { network: 'Failed', timeout: 'Timeout', cancelled: 'Cancelled', prepare_error: 'Not sent' }[r.outcome], cls: r.outcome === 'cancelled' ? 'neutral' : 'fail' };
}

const PHASES: { key: keyof PhaseTimings; label: string }[] = [
  { key: 'dns', label: 'DNS lookup' },
  { key: 'connect', label: 'TCP connect' },
  { key: 'tls', label: 'TLS handshake' },
  { key: 'wait', label: 'Waiting (first byte)' },
  { key: 'download', label: 'Download' }
];

function TimingView({ t }: { t: PhaseTimings }): React.JSX.Element {
  const total = Math.max(1, t.total);
  let offset = 0;
  return (
    <div className="dt-timing">
      {t.reused && <p className="mute small">Reused an open connection: no DNS, connect or TLS time.</p>}
      {PHASES.map(({ key, label }) => {
        const ms = t[key] as number | undefined;
        const left = (offset / total) * 100;
        if (ms !== undefined) offset += ms;
        return (
          <div key={key} className="dt-phase">
            <span>{label}</span>
            <span className="dt-track">{ms !== undefined && <span className={`dt-bar ${key}`} style={{ left: `${left}%`, width: `${Math.max(0.5, (ms / total) * 100)}%` }} />}</span>
            <span className="mono">{ms === undefined ? '—' : formatMs(ms)}</span>
          </div>
        );
      })}
      <div className="dt-phase total">
        <span>Total</span>
        <span />
        <span className="mono">{formatMs(t.total)}</span>
      </div>
    </div>
  );
}

const PROXY_SOURCES = { manual: 'manual proxy', system: 'system settings', environment: 'environment variable' } as const;

function ConnectionView({ hop }: { hop: NetworkHop }): React.JSX.Element {
  const c = hop.connection;
  const cert = c.tls?.certificate;
  const rows: [string, string | undefined][] = [
    ['Remote address', c.remoteAddress ? `${c.remoteAddress}${c.remotePort ? `:${c.remotePort}` : ''}` : undefined],
    ['HTTP version', c.httpVersion],
    ['Proxy', c.proxy ? `${c.proxy}${c.proxySource ? ` (${PROXY_SOURCES[c.proxySource]})` : ''}` : 'None'],
    ['TLS', c.tls ? `${c.tls.protocol} · ${c.tls.cipher}` : 'Not encrypted (http)'],
    ...(cert
      ? ([
          ['Certificate subject', cert.subject],
          ['Issued by', cert.issuer],
          ['Valid', `${cert.validFrom} → ${cert.validTo}`],
          ['SHA-256 fingerprint', cert.fingerprint256]
        ] as [string, string][])
      : [])
  ];
  return (
    <table className="headers-list">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{v ?? <span className="mute">Not recorded</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type HeadFormat = 'table' | 'raw';

function FormatToggle({ format, onChange }: { format: HeadFormat; onChange: (f: HeadFormat) => void }): React.JSX.Element {
  return (
    <div className="view-toggle small" role="group" aria-label="Header format">
      {(['table', 'raw'] as const).map((f) => (
        <button key={f} className={format === f ? 'active' : ''} aria-pressed={format === f} onClick={() => onChange(f)}>{f === 'table' ? 'Table' : 'Raw'}</button>
      ))}
    </div>
  );
}

/** A request or response head as HTTP text. Rebuilt from what Yept recorded, so it says so. */
function RawHead({ text, label, copy, extra }: { text: string; label: string; copy: () => void; extra?: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <p className="mute small dt-raw-note">Reconstructed from the recorded {label}: header case, order and line endings may differ from the exact bytes on the wire. Secret values are masked.</p>
      <pre className="console-out dt-raw" aria-label={`Raw ${label}`}>{text}</pre>
      <div className="dt-raw-actions">
        <button className="btn ghost small" onClick={copy}>Copy</button>
        {extra}
      </div>
    </>
  );
}

const COOKIE_SOURCE: Record<string, string> = { jar: 'from the cookie jar', request: "the request's own Cookie header (the jar wasn't used)", none: 'none sent' };

const urlPath = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/** Links between a run and the requests its scripts sent with bru.sendRequest. */
function ScriptLinks({ entry }: { entry: RunEntry }): React.JSX.Element | null {
  const select = useDevTools((s) => s.select);
  const parentListed = useDevTools((s) => !!entry.parentRunId && s.runs.some((r) => r.runId === entry.parentRunId));
  const sent = entry.result?.scriptRequests ?? [];
  if (entry.parentRunId) {
    return (
      <p className="dt-links small">
        <span>Sent by <code>bru.sendRequest</code> in the {entry.stage} script of <b>{entry.requestName}</b>.</span>
        {parentListed && <button className="link-btn" onClick={() => select(entry.parentRunId!)}>Show the run that sent it</button>}
      </p>
    );
  }
  if (!sent.length) return null;
  return (
    <div className="dt-links small" aria-label="Requests sent by scripts">
      <span>Scripts sent:</span>
      {sent.map((c) => {
        const o = c.result.outcome === 'http' ? String(c.result.status) : c.result.outcome === 'cancelled' ? 'Cancelled' : 'Failed';
        return (
          <button key={c.result.runId} className="dt-hop" onClick={() => select(c.result.runId)} title={`${c.stage}: ${c.result.request.method} ${c.result.request.url}`}>
            <span className={`status s${o[0]}`}>{o}</span> {c.result.request.method} {urlPath(c.result.request.url)}
          </button>
        );
      })}
    </div>
  );
}

/** "Copy as": the request as code in another language. Secrets stay masked unless asked for, each time the menu opens. */
function CopyAsMenu({ disabled, secretsAvailable, onCopy }: { disabled: boolean; secretsAvailable: boolean; onCopy: (language: SnippetLanguage, withSecrets: boolean) => void }): React.JSX.Element {
  const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const [withSecrets, setWithSecrets] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (at) list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [at]);
  const open = (): void => {
    const b = button.current!.getBoundingClientRect();
    const right = Math.max(4, window.innerWidth - b.right);
    // Opens upwards when there isn't room below (Dev Tools sits at the bottom of the window).
    setWithSecrets(false);
    setAt(window.innerHeight - b.bottom >= 260 || b.top < 260 ? { top: b.bottom + 4, right } : { bottom: window.innerHeight - b.top + 4, right });
  };
  const close = (refocus: boolean): void => {
    setAt(null);
    if (refocus) button.current?.focus();
  };
  const focusItem = (step: number): void => {
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + step + all.length) % all.length]?.focus();
  };
  return (
    <>
      <button ref={button} className="btn ghost small" aria-haspopup="menu" aria-expanded={!!at} disabled={disabled} onClick={() => (at ? close(false) : open())}>
        Copy as <span aria-hidden="true">▾</span>
      </button>
      {at && (
        <>
          <div className="dt-menu-backdrop" onMouseDown={() => close(false)} />
          <div
            ref={list}
            className="menu dt-copy-menu"
            role="menu"
            aria-label="Copy as"
            style={at}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(-1); }
              else if (e.key === 'Escape') { e.preventDefault(); close(true); }
            }}
          >
            <button role="menuitemcheckbox" aria-checked={withSecrets} disabled={!secretsAvailable} onClick={() => setWithSecrets((v) => !v)}
              title="Includes secret values and cookies. Available for the last 50 requests sent in this session.">
              <span className="menu-check" aria-hidden="true">{withSecrets ? '✓' : ''}</span>Include secrets and cookies
            </button>
            <hr />
            {SNIPPET_LANGUAGES.map((l) => (
              <button key={l.id} role="menuitem" onClick={() => { close(true); onCopy(l.id, withSecrets); }}><span className="menu-check" aria-hidden="true" />{l.label}</button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function NetworkDetails({ entry, format, setFormat }: { entry: RunEntry; format: HeadFormat; setFormat: (f: HeadFormat) => void }): React.JSX.Element {
  const [view, setView] = useState<'request' | 'response' | 'timing' | 'connection'>('request');
  const [showCookies, setShowCookies] = useState(false);
  const r = entry.result;
  const hops = r?.hops ?? [];
  const [hopIndex, setHopIndex] = useState(hops.length - 1);
  const toast = useStore((s) => s.toast);
  const host = useContext(DevToolsHostContext);
  useEffect(() => setHopIndex((r?.hops?.length ?? 1) - 1), [entry.runId, r?.hops?.length]);
  if (entry.running) return <div className="empty"><span className="spinner" /></div>;
  if (!r) return <div className="pane"><div className="error-card"><h3>The run failed</h3><div className="mono">{entry.error}</div></div></div>;

  const hop: NetworkHop | undefined = hops[Math.min(Math.max(hopIndex, 0), hops.length - 1)];
  const isFinal = !hop || hop === hops[hops.length - 1];
  const sentHeaders = hop?.requestHeaders.length ? hop.requestHeaders : r.request.headers;
  const masked: CurlRequest = { method: hop?.method ?? r.request.method, url: hop?.url ?? r.request.url, headers: sentHeaders, body: isFinal && !r.multipart ? r.requestBody : undefined, form: isFinal ? r.multipart : undefined };
  // Masked from what the page has; with secrets only from the main process, which kept the unmasked request.
  const copy = async (language: SnippetLanguage, withSecrets: boolean): Promise<void> => {
    try {
      await yept.clipboard.write(withSecrets ? await yept.runs.curlWithSecrets(r.runId, language) : language === 'curl' ? toCurl(masked) : toSnippet(language, masked));
      const label = snippetLabel(language);
      toast(withSecrets ? `Copied as ${label}, including secrets and cookies` : `Copied as ${label} (secrets masked)`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const httpVersion = hop?.connection.httpVersion;
  const responseHeaders = isFinal ? r.headers : (hop?.responseHeaders ?? []);
  const rawRequest = rawRequestHead({ method: hop?.method ?? r.request.method, url: hop?.url ?? r.request.url, headers: sentHeaders, httpVersion });
  const rawResponse = rawResponseHead({ status: hop?.status ?? r.status, statusText: hop?.statusText ?? r.statusText, headers: responseHeaders, httpVersion }, { showCookies });
  const hasSetCookie = responseHeaders.some(([k]) => k.toLowerCase() === 'set-cookie');
  const copyRaw = async (text: string | (() => Promise<string>), what: string): Promise<void> => {
    try {
      await yept.clipboard.write(typeof text === 'string' ? text : await text());
      toast(`Copied ${what}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="dt-details">
      <div className="subtabs" role="tablist">
        {(['request', 'response', 'timing', 'connection'] as const).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={`subtab ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <span className="dt-actions">
          {(view === 'request' || view === 'response') && <FormatToggle format={format} onChange={setFormat} />}
          <button className="btn ghost small" onClick={() => void host.openRun(entry.requestId, entry.parentRunId ?? entry.runId)} title={entry.parentRunId ? 'Opens the request whose script sent this one' : undefined}>Open request</button>
          <button className="btn ghost small" onClick={() => void copy('curl', false)} disabled={!hops.length && r.outcome === 'prepare_error'}>Copy as cURL</button>
          <button className="btn ghost small" onClick={() => void copy('curl', true)} disabled={!hops.length} title="Includes secret values and cookies. Available for the last 50 requests sent in this session.">…with secrets</button>
          <CopyAsMenu disabled={!hops.length && r.outcome === 'prepare_error'} secretsAvailable={hops.length > 0} onCopy={(language, withSecrets) => void copy(language, withSecrets)} />
        </span>
      </div>
      <ScriptLinks entry={entry} />
      {hops.length > 1 && (
        <div className="dt-hops" aria-label="Redirects and retries">
          {hops.map((h, i) => (
            <button key={i} className={`dt-hop ${i === hopIndex ? 'active' : ''}`} onClick={() => setHopIndex(i)} title={h.url}>
              <span className={`status s${String(h.status ?? 0)[0]}`}>{h.status ?? '—'}</span> {h.method} {new URL(h.url, 'http://x').pathname}
            </button>
          ))}
        </div>
      )}
      <div className="pane dt-pane">
        {view === 'request' && (
          <>
            <p className="mono dt-url"><b>{hop?.method ?? r.request.method}</b> {hop?.url ?? r.request.url}</p>
            {!hops.length && <p className="mute small">Nothing was sent. These are the headers that would have been sent.</p>}
            <h4 className="section-title">Headers sent</h4>
            {format === 'raw' ? (
              <RawHead text={rawRequest} label="request" copy={() => void copyRaw(rawRequest, 'the raw request (secrets masked)')}
                extra={<button className="btn ghost small" disabled={!hops.length || !isFinal} title={isFinal ? 'Includes secret values and cookies. Available for the last 50 requests sent in this session.' : 'Only for the last request of a redirect chain'}
                  onClick={() => void copyRaw(() => yept.runs.rawWithSecrets(r.runId), 'the raw request, including secrets and cookies')}>…with secrets</button>} />
            ) : <HeaderTable headers={sentHeaders} />}
            {r.cookies && <p className="mute small">Cookies: {COOKIE_SOURCE[r.cookies.source]}{r.cookies.sent.length ? ` (${r.cookies.sent.join(', ')})` : ''}.</p>}
            {isFinal && r.requestBody !== undefined && (
              <>
                <h4 className="section-title">Body</h4>
                <pre className="console-out">{r.requestBody}</pre>
              </>
            )}
          </>
        )}
        {view === 'response' && (
          <>
            {isFinal && r.outcome !== 'http' ? (
              <div className="error-card" style={{ margin: 0 }}><h3>No response</h3><div className="mono">{r.error?.message}</div></div>
            ) : (
              <>
                <p className="mono"><b>{hop?.status ?? r.status} {hop?.statusText ?? r.statusText}</b>{isFinal && <span className="mute"> · {formatMs(r.durationMs)} · {formatBytes(r.sizeBytes)}</span>}</p>
                <h4 className="section-title">Headers</h4>
                {format === 'raw' ? (
                  <RawHead text={rawResponse} label="response" copy={() => void copyRaw(rawResponse, showCookies ? 'the raw response, including cookie values' : 'the raw response (cookie values masked)')}
                    extra={hasSetCookie && <label className="small dt-raw-reveal"><input type="checkbox" checked={showCookies} onChange={(e) => setShowCookies(e.target.checked)} /> Show cookie values</label>} />
                ) : <HeaderTable headers={responseHeaders} />}
                {r.cookies?.stored.length ? <p className="mute small">Stored in the cookie jar: {r.cookies.stored.join(', ')}.</p> : null}
                {isFinal && (
                  <>
                    <h4 className="section-title">Body</h4>
                    {r.body.binary ? <p className="mute">Binary, {formatBytes(r.sizeBytes)}</p> : r.sizeBytes === 0 ? <p className="mute">Empty</p> : <pre className="console-out dt-body-preview">{r.body.text.slice(0, 64 * 1024)}{r.body.text.length > 64 * 1024 ? '\n…' : ''}</pre>}
                  </>
                )}
              </>
            )}
          </>
        )}
        {view === 'timing' && (hop ? <TimingView t={hop.timings} /> : <p className="mute">Nothing was sent.</p>)}
        {view === 'connection' && (hop ? <ConnectionView hop={hop} /> : <p className="mute">Nothing was sent.</p>)}
      </div>
    </div>
  );
}

/** "(1 redirect)", or "(sent again after 401)" for an auth challenge or a rejected OAuth2 token. */
function hopNote(hops: NetworkHop[] | undefined): React.JSX.Element | null {
  const earlier = (hops ?? []).slice(0, -1);
  if (!earlier.length) return null;
  const redirects = earlier.filter((h) => h.status !== undefined && h.status >= 300 && h.status < 400).length;
  const parts = [redirects ? `${redirects} redirect${redirects > 1 ? 's' : ''}` : '', earlier.some((h) => h.status === 401) ? 'sent again after 401' : ''].filter(Boolean);
  return parts.length ? <span className="mute"> ({parts.join(', ')})</span> : null;
}

function NetworkTab(): React.JSX.Element {
  const { runs, selectedRunId, select } = useDevTools();
  // Table or raw headers: kept while moving between runs.
  const [format, setFormat] = useState<HeadFormat>('table');
  const rows = useMemo(() => [...runs].reverse(), [runs]);
  const selected = runs.find((r) => r.runId === selectedRunId) ?? null;
  return (
    <div className="dt-network">
      <div className="dt-table-wrap">
        {!runs.length ? (
          <div className="empty">Requests sent in this session show here, with timings and connection details.</div>
        ) : (
          <table className="dt-table">
            <thead>
              <tr><th>Time</th><th>Method</th><th>URL</th><th>Status</th><th>Duration</th><th>Size</th><th>Env</th></tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const o = outcomeLabel(e);
                const r: RunResult | null = e.result;
                return (
                  <tr key={e.runId} className={e.runId === selectedRunId ? 'active' : ''} onClick={() => select(e.runId)} aria-selected={e.runId === selectedRunId}>
                    <td className="mono">{time(e.startedAt)}</td>
                    <td className="mono">{r?.request.method ?? e.method}</td>
                    <td className="mono dt-ellipsis" title={e.parentRunId ? `Sent by a ${e.stage} script of ${e.requestName}: ${r?.request.url ?? e.url}` : (r?.request.url ?? e.url)}>{e.parentRunId && <span className="dt-script-tag">script</span>}{r?.request.url ?? e.url}{hopNote(r?.hops)}</td>
                    <td><span className={`hstatus ${o.cls}`}>{o.text}</span></td>
                    <td className="mono">{r ? formatMs(r.durationMs) : ''}</td>
                    <td className="mono">{r?.outcome === 'http' ? formatBytes(r.sizeBytes) : ''}</td>
                    <td>{e.environment || <span className="mute">none</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {selected && <NetworkDetails key={selected.runId} entry={selected} format={format} setFormat={setFormat} />}
    </div>
  );
}

// ---------- Cookies ----------

const blankCookie = (domain = ''): CookieView => ({ name: '', value: '', domain, path: '/', expires: null, secure: false, httpOnly: false, sameSite: '', hostOnly: true });
const localInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function CookieForm({ initial, previous, onSave, onCancel }: { initial: CookieView; previous?: CookieView; onSave: (c: CookieView) => void; onCancel: () => void }): React.JSX.Element {
  const [c, setC] = useState(initial);
  const field = (k: 'name' | 'value' | 'domain' | 'path', label: string, placeholder = ''): React.JSX.Element => (
    <label className="dt-field">
      <span>{label}</span>
      <input className="input mono" value={c[k]} placeholder={placeholder} onChange={(e) => setC({ ...c, [k]: e.target.value })} aria-label={`Cookie ${label.toLowerCase()}`} />
    </label>
  );
  return (
    <form className="dt-cookie-form" onSubmit={(e) => { e.preventDefault(); onSave(c); }}>
      <strong>{previous ? `Edit ${previous.name}` : 'Add a cookie'}</strong>
      <div className="dt-form-grid">
        {field('name', 'Name')}
        {field('value', 'Value')}
        {field('domain', 'Domain', 'api.example.test')}
        {field('path', 'Path', '/')}
        <label className="dt-field">
          <span>Expires</span>
          <input className="input mono" type="datetime-local" value={localInput(c.expires)} onChange={(e) => setC({ ...c, expires: e.target.value ? new Date(e.target.value).toISOString() : null })} aria-label="Cookie expiry" />
        </label>
        <label className="dt-field">
          <span>SameSite</span>
          <select className="input" value={c.sameSite} onChange={(e) => setC({ ...c, sameSite: e.target.value })} aria-label="Cookie SameSite">
            <option value="">Not set</option>
            <option value="lax">Lax</option>
            <option value="strict">Strict</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>
      <div className="dt-form-checks">
        <label><input type="checkbox" checked={c.secure} onChange={(e) => setC({ ...c, secure: e.target.checked })} /> Secure (https only)</label>
        <label><input type="checkbox" checked={c.httpOnly} onChange={(e) => setC({ ...c, httpOnly: e.target.checked })} /> HttpOnly</label>
        <label><input type="checkbox" checked={!c.hostOnly} onChange={(e) => setC({ ...c, hostOnly: !e.target.checked })} /> Also send to subdomains</label>
        <span className="mute small">No expiry = a session cookie, cleared when Yept closes.</span>
      </div>
      <div className="dt-form-actions">
        <button type="button" className="btn small" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary small">Save cookie</button>
      </div>
    </form>
  );
}

function CookiesTab(): React.JSX.Element {
  const collectionId = useCurrentCollection();
  const { jars, loadJar, setJar } = useDevTools();
  const { snapshot, toast } = useStore();
  const { openCookieSettings } = useContext(DevToolsHostContext);
  const [editing, setEditing] = useState<{ cookie: CookieView; previous?: CookieView } | null>(null);
  const jar = collectionId ? jars[collectionId] : undefined;
  const collection = snapshot?.collections.find((c) => c.id === collectionId);

  useEffect(() => {
    if (collectionId) void loadJar(collectionId);
  }, [collectionId, loadJar]);

  const groups = useMemo(() => {
    const m = new Map<string, CookieView[]>();
    for (const c of jar?.cookies ?? []) m.set(c.domain, [...(m.get(c.domain) ?? []), c]);
    return [...m.entries()];
  }, [jar]);

  if (!collectionId) return <div className="empty">Open a collection to see the cookies of its current environment.</div>;
  const act = async (fn: () => Promise<typeof jar>): Promise<boolean> => {
    try {
      const next = await fn();
      if (next) setJar(next);
      return true;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return false;
    }
  };
  const clearAll = async (): Promise<void> => {
    if (await confirm('Clear all cookies?', `Every cookie for ${collection?.name ?? 'this collection'} in ${jar?.environment ? `the ${jar.environment} environment` : 'no environment'} is removed.`, 'Clear all', true)) {
      await act(() => yept.cookies.clear(collectionId));
    }
  };

  return (
    <div className="dt-body">
      <div className="dt-toolbar">
        <span>
          Cookie jar for <b>{collection?.name}</b> · {jar?.environment ? <>environment <b>{jar.environment}</b></> : <span className="mute">no environment</span>}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={() => setEditing({ cookie: blankCookie(groups[0]?.[0] ?? '') })}>Add cookie</button>
        <button className="btn small" disabled={!jar?.cookies.length} onClick={() => void clearAll()}>Clear all</button>
      </div>
      {jar && !jar.enabled && (
        <div className="truncated-note">
          Automatic cookies are off: stored cookies aren&apos;t sent and responses aren&apos;t stored. <button className="link-btn" onClick={openCookieSettings}>Settings…</button>
        </div>
      )}
      <div className="dt-scroll">
        {editing && (
          <CookieForm
            key={editing.previous ? `${editing.previous.domain}/${editing.previous.path}/${editing.previous.name}` : 'new'}
            initial={editing.cookie}
            previous={editing.previous}
            onCancel={() => setEditing(null)}
            onSave={(c) => void act(() => yept.cookies.upsert(collectionId, c, editing.previous)).then((ok) => ok && setEditing(null))}
          />
        )}
        {!groups.length && !editing && <div className="empty">No cookies yet. Cookies from responses (Set-Cookie) are stored here automatically.</div>}
        {groups.length > 0 && (
          <table className="dt-table dt-cookies">
            <thead>
              <tr><th>Name</th><th>Value</th><th>Path</th><th>Expires</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th><th /></tr>
            </thead>
            {groups.map(([domain, cookies]) => (
              <tbody key={domain}>
                <tr className="dt-group">
                  <td colSpan={7}><b>{domain}</b> <span className="mute">· {cookies.length} cookie{cookies.length === 1 ? '' : 's'}</span></td>
                  <td className="dt-row-actions"><button className="btn ghost small" onClick={() => void act(() => yept.cookies.clear(collectionId, domain))}>Clear domain</button></td>
                </tr>
                {cookies.map((c) => (
                  <tr key={`${c.path}/${c.name}`}>
                    <td className="mono">{c.name}{!c.hostOnly && <span className="mute" title="Also sent to subdomains"> ⁺</span>}</td>
                    <td className="mono dt-ellipsis"><Masked value={c.value} /></td>
                    <td className="mono">{c.path}</td>
                    <td>{c.expires ? new Date(c.expires).toLocaleString() : <span className="mute">Session</span>}</td>
                    <td>{c.secure ? '✓' : ''}</td>
                    <td>{c.httpOnly ? '✓' : ''}</td>
                    <td>{c.sameSite}</td>
                    <td className="dt-row-actions">
                      <button className="btn ghost small" onClick={() => setEditing({ cookie: c, previous: c })} aria-label={`Edit cookie ${c.name}`}>Edit</button>
                      <button className="btn ghost small" onClick={() => void act(() => yept.cookies.remove(collectionId, c))} aria-label={`Delete cookie ${c.name}`}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </div>
  );
}

// ---------- Performance ----------

const duration = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
};
const PROCESS_NAMES: Record<string, string> = { Browser: 'Main (requests, scripts, files)', Tab: 'Window', GPU: 'GPU', Utility: 'Utility' };

function PerformanceTab(): React.JSX.Element {
  const [m, setM] = useState<AppMetrics | null>(null);
  const [error, setError] = useState('');
  // Polls only while this tab is shown; unmounting stops it.
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      yept.metrics().then((x) => alive && setM(x)).catch((e) => alive && setError(errorMessage(e)));
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (error) return <div className="empty">{error}</div>;
  if (!m) return <div className="empty"><span className="spinner" /></div>;
  const totalMem = m.processes.reduce((n, p) => n + p.memory, 0);
  const totalCpu = m.processes.reduce((n, p) => n + p.cpu, 0);
  return (
    <div className="dt-scroll">
      <div className="dt-stats">
        <span>Uptime <b>{duration(m.uptimeSeconds)}</b></span>
        <span>Memory <b>{formatBytes(totalMem)}</b></span>
        <span>CPU <b>{totalCpu.toFixed(1)}%</b></span>
        <span>History database <b>{formatBytes(m.historyBytes)}</b></span>
        <span>Main process heap <b>{formatBytes(m.mainHeapBytes)}</b></span>
      </div>
      <table className="dt-table">
        <thead>
          <tr><th>Process</th><th>PID</th><th>CPU</th><th>Memory</th></tr>
        </thead>
        <tbody>
          {m.processes.map((p) => (
            <tr key={p.pid}>
              <td>{PROCESS_NAMES[p.type] ?? p.type}{p.name && p.type === 'Utility' ? <span className="mute"> · {p.name}</span> : null}</td>
              <td className="mono">{p.pid}</td>
              <td className="mono">{p.cpu.toFixed(1)}%</td>
              <td className="mono">{formatBytes(p.memory)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mute small" style={{ padding: '0 14px' }}>Scripts run in worker threads inside the main process. Refreshes every 2 seconds while this tab is open.</p>
    </div>
  );
}

// ---------- drawer ----------

export function DevTools(): React.JSX.Element | null {
  const { open, height, setOpen, setHeight } = useDevTools();
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent): void => setHeight(Math.round(Math.min(window.innerHeight - 160, Math.max(120, window.innerHeight - e.clientY - 26))));
    const up = (): void => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, setHeight]);
  if (!open) return null;
  return (
    <section className="devtools" style={{ height: Math.min(height, Math.max(120, window.innerHeight - 160)) }} aria-label="Dev tools">
      <div className={`devtools-resize ${dragging ? 'dragging' : ''}`} onMouseDown={() => setDragging(true)} role="separator" aria-orientation="horizontal" aria-label="Resize dev tools" />
      <DevToolsTabs tabs={DEV_TABS} close={() => setOpen(false)} />
    </section>
  );
}

/** The tab bar and the shown tab: the drawer's content, and the whole of the VS Code extension's Dev Tools view. */
export function DevToolsTabs({ tabs, close }: { tabs: { id: DevTab; label: string }[]; close?: () => void }): React.JSX.Element {
  const { tab: chosen, show, clear, runs, lines } = useDevTools();
  const tab = tabs.some((t) => t.id === chosen) ? chosen : tabs[0].id;
  return (
    <>
      <div className="subtabs devtools-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`subtab ${tab === t.id ? 'active' : ''}`} onClick={() => show(t.id)}>
            {t.label}
            {t.id === 'console' && lines.length > 0 && <span className="count">{lines.length}</span>}
            {t.id === 'network' && runs.length > 0 && <span className="count">{runs.length}</span>}
          </button>
        ))}
        <span className="dt-actions">
          {(tab === 'console' || tab === 'network') && (
            <button className="btn ghost small" onClick={clear} title="Forget this session's console and network activity (history is kept)">Clear</button>
          )}
          {close && <button className="btn ghost small" onClick={close} aria-label="Close dev tools" title="Close (Ctrl+Shift+J)">✕</button>}
        </span>
      </div>
      {tab === 'console' && <ConsoleTab />}
      {tab === 'network' && <NetworkTab />}
      {tab === 'cookies' && <CookiesTab />}
      {tab === 'performance' && <PerformanceTab />}
    </>
  );
}

/** Footer buttons: Dev tools, and the cookie count of the current collection and environment. */
export function DevToolsStatus(): React.JSX.Element {
  const { open, toggle, show, jars, loadJar } = useDevTools();
  const collectionId = useCurrentCollection();
  const jar = collectionId ? jars[collectionId] : undefined;
  useEffect(() => {
    if (collectionId && !useDevTools.getState().jars[collectionId]) void loadJar(collectionId);
  }, [collectionId, loadJar]);
  return (
    <>
      {jar && (
        <button className="status-item status-btn" onClick={() => show('cookies')} title={`Cookies stored for ${jar.environment ? `the ${jar.environment} environment` : 'no environment'}${jar.enabled ? '' : ' (automatic cookies are off)'}`} aria-label={`${jar.cookies.length} cookies`}>
          🍪 {jar.cookies.length}
        </button>
      )}
      <button className={`status-item status-btn ${open ? 'on' : ''}`} onClick={toggle} title="Console, network, cookies and performance (Ctrl+Shift+J)" aria-pressed={open}>
        Dev tools
      </button>
    </>
  );
}
