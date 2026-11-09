import { useEffect, useRef, useState } from 'react';
import type { RunCookie, RunResult } from '@shared/model';
import { errorMessage, yept } from '../api';
import { useDevTools } from '../devtools';

function CookieValue({ runId, index, cookie, historical }: { runId: string; index: number; cookie: RunCookie; historical: boolean }): React.JSX.Element {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reveal = async (): Promise<void> => {
    if (value !== null) { setValue(null); return; }
    setBusy(true); setError('');
    try {
      const raw = await yept.runs.cookieValue(runId, index);
      if (alive.current) setValue(raw);
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  return (
    <>
      <button className="masked response-cookie-value" disabled={historical || busy} aria-pressed={value !== null}
        aria-label={`${value === null ? 'Reveal' : 'Hide'} ${cookie.direction} cookie ${cookie.name} on hop ${cookie.hop + 1}`}
        title={historical ? 'Cookie values are not kept in history' : value === null ? 'Reveal this recorded value' : 'Hide this value'}
        onClick={() => void reveal()}>{busy ? '…' : value === null ? '••••••' : value || '(empty)'}</button>
      {error && <span className="bad-text small cookie-reveal-error" role="alert">{error}</span>}
    </>
  );
}

function lifetime(c: RunCookie): string {
  const parts: string[] = [];
  if (c.maxAge !== undefined) parts.push(`Max-Age: ${c.maxAge} s${Number(c.maxAge) <= 0 ? ' (delete)' : ''}`);
  if (c.expires) parts.push(`Expires: ${c.expires}`);
  return parts.join(' · ') || 'Session';
}

function hopLabel(result: RunResult, index: number): string {
  const hop = result.hops?.[index];
  let target = '';
  try { const url = new URL(hop?.url ?? result.request.url); target = `${url.host}${url.pathname}`; } catch { /* old or masked URL */ }
  return `Hop ${index + 1} · ${hop?.method ?? result.request.method}${target ? ` ${target}` : ''}${hop?.status ? ` · ${hop.status}` : ''}`;
}

export function ResponseCookies({ result, historical }: { result: RunResult; historical: boolean }): React.JSX.Element {
  const entries = result.cookieDetails?.map((cookie, index) => ({ cookie, index }));
  const hops = result.hops?.length ?? 1;
  return (
    <div className="pane response-cookies" aria-label="Response cookies">
      <div className="response-cookies-head">
        <p className="mute small">Cookies recorded for this run · {result.environment ? `environment ${result.environment}` : 'no environment'}. Read-only.</p>
        <button className="btn small" onClick={() => useDevTools.getState().show('cookies')}>Open current cookie jar in Dev Tools</button>
      </div>
      <p className="mute small">The jar shows this collection's current environment. Response entries show Set-Cookie headers; they do not imply the jar accepted or retained them.</p>
      {historical && <p className="mute small">History keeps cookie metadata only. Values cannot be revealed.</p>}
      {!entries ? (
        <p className="mute">Cookie details were not recorded for this older run.</p>
      ) : Array.from({ length: hops }, (_, hop) => {
        const sent = entries.filter((e) => e.cookie.hop === hop && e.cookie.direction === 'sent');
        const received = entries.filter((e) => e.cookie.hop === hop && e.cookie.direction === 'received');
        return (
          <section className="response-cookie-hop" key={hop} aria-label={`Cookie hop ${hop + 1}`}>
            <h3 className="mono small">{hopLabel(result, hop)}</h3>
            <h4 className="section-title">Cookies sent ({sent.length})</h4>
            {!sent.length ? <p className="mute small">No cookies sent on this hop.</p> : (
              <table className="headers-list response-cookie-table" aria-label={`Cookies sent on hop ${hop + 1}`}>
                <thead><tr><th>Name</th><th>Value</th><th>Source</th></tr></thead>
                <tbody>{sent.map(({ cookie, index }) => (
                  <tr key={index}><td>{cookie.name}</td>
                    <td><CookieValue runId={result.runId} index={index} cookie={cookie} historical={historical} /></td>
                    <td>{cookie.source === 'jar' ? 'Cookie jar' : cookie.source === 'request' ? 'Request Cookie header' : 'Not recorded'}</td></tr>
                ))}</tbody>
              </table>
            )}
            <h4 className="section-title">Cookies set by response ({received.length})</h4>
            {!received.length ? <p className="mute small">No cookie entries recorded in this response.</p> : (
              <table className="headers-list response-cookie-table" aria-label={`Cookies received on hop ${hop + 1}`}>
                <thead><tr><th>Name</th><th>Value</th><th>Domain / path</th><th>Lifetime</th><th>Attributes</th></tr></thead>
                <tbody>{received.map(({ cookie, index }) => (
                  <tr key={index}><td>{cookie.name}</td>
                    <td><CookieValue runId={result.runId} index={index} cookie={cookie} historical={historical} /></td>
                    <td>{cookie.domain}<br />{cookie.path}</td><td>{lifetime(cookie)}</td>
                    <td>{[cookie.secure && 'Secure', cookie.httpOnly && 'HttpOnly', cookie.sameSite && `SameSite=${cookie.sameSite}`].filter(Boolean).join(' · ') || '—'}</td></tr>
                ))}</tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}
