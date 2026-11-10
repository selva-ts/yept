// The OAuth2 token for a request's effective auth (its own or inherited) in the active environment: status,
// Get token and Forget. The token itself stays in the main process; only its expiry and scope are shown.
import { useEffect, useRef, useState } from 'react';
import type { OAuth2TokenView } from '@shared/ipc';
import { OAUTH2_AUTHORIZATION_CODE, type OAuth2Config } from '@shared/model';
import { errorMessage, yept } from '../api';
import { useStore, type Tab } from '../store';

function remaining(iso: string): string {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes < 1) return 'under a minute';
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export function OAuth2Token({ tab, config }: { tab: Tab; config: OAuth2Config }): React.JSX.Element | null {
  const { varsVersion, envs, toast } = useStore();
  const [view, setView] = useState<OAuth2TokenView | null>(null);
  const [busy, setBusy] = useState<'fetch' | 'forget' | null>(null);
  const [error, setError] = useState('');
  const cancelling = useRef(false);
  const interactive = config.grantType === OAUTH2_AUTHORIZATION_CODE;
  const authKey = JSON.stringify(tab.draft.auth) + JSON.stringify(tab.draft.vars.req);
  const active = envs[tab.collectionId]?.active ?? null;

  useEffect(() => {
    let current = true;
    yept.oauth2
      .token(tab.id, tab.draft, 'status')
      .then((v) => { if (current) { setView(v); setError(''); } })
      .catch((e) => { if (current) setError(errorMessage(e)); });
    return () => { current = false; };
    // A run may have fetched or renewed a token, so refresh with variables too.
  }, [tab.id, authKey, varsVersion, active, tab.run?.runId, tab.run?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view && !view.applies) return null;
  const act = async (action: 'fetch' | 'forget'): Promise<void> => {
    setBusy(action);
    cancelling.current = false;
    setError('');
    try {
      setView(await yept.oauth2.token(tab.id, tab.draft, action));
      toast(action === 'fetch' ? 'Got a new OAuth2 token' : 'OAuth2 token forgotten');
    } catch (e) {
      if (!cancelling.current) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const cancel = async (): Promise<void> => {
    cancelling.current = true;
    try { await yept.oauth2.token(tab.id, tab.draft, 'cancel'); }
    catch (e) { cancelling.current = false; setError(errorMessage(e)); }
  };
  const s = view?.applies ? view.status : null;
  const where = active ? `environment "${active}"` : 'no environment';
  return (
    <section className="oauth2-token" aria-label="OAuth2 token">
      <h4 className="section-title">Token for {where}</h4>
      <p className="small" role="status">
        {!s ? (
          <span className="mute">Checking…</span>
        ) : s.state === 'valid' ? (
          <>
            <span className="ok-text">Ready</span>
            {s.expiresAt ? ` · expires in ${remaining(s.expiresAt)}` : ' · no expiry given'}
            {s.scope ? ` · scope ${s.scope}` : ''}
          </>
        ) : s.state === 'expired' ? (
          <span className="warn-text">Expired{config.autoRefreshToken ? interactive ? ': use Get token if renewal needs sign-in.' : ': a new one is fetched on the next send.' : '. Use Get token.'}</span>
        ) : (
          <span className="mute">No token yet{interactive ? '. Use Get token to sign in in your browser.' : config.autoFetchToken ? ': one is fetched on the next send.' : '. Automatic fetching is off, so use Get token.'}</span>
        )}
      </p>
      <div className="oauth2-token-actions">
        <button className="btn small" disabled={!!busy} onClick={() => void act('fetch')}>{busy === 'fetch' ? <span className="spinner" /> : null} Get token</button>
        {busy === 'fetch' && interactive && <button className="btn small" onClick={() => void cancel()}>Cancel sign-in</button>}
        <button className="btn small" disabled={!!busy || !s || s.state === 'none'} onClick={() => void act('forget')}>Forget token</button>
      </div>
      {error && <p className="bad-text small" role="alert">{error}</p>}
    </section>
  );
}
