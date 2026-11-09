import { AUTH_MODES, isEditableAuth, type AuthConfig, type OAuth2Config } from '@shared/model';
import { looksLikeSecret, type SecretField } from '@shared/secrets';
import { errorMessage, yept } from '../api';
import { useStore } from '../store';
import { VarInput } from './VarInput';
import { prompt } from './Dialogs';

const LABELS: Record<string, string> = { inherit: 'Inherit', none: 'No auth', bearer: 'Bearer token', basic: 'Basic', apikey: 'API key', oauth2: 'OAuth2 client credentials' };

interface Props {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
  readOnly?: boolean;
  /** The collection is the top: it can't inherit. */
  allowInherit: boolean;
  /** For "Store as local secret". */
  collectionId: string;
  /** Shown when mode is inherit, e.g. 'Bearer token from collection "Sample Travel"'. */
  inheritedLabel?: string;
}

/** Inline warning when a literal credential is typed into a shared field, with a one-click fix. */
export function SecretHint({ value, field, collectionId, suggestedName, onReplace }: { value: string; field: SecretField; collectionId: string; suggestedName: string; onReplace: (ref: string) => void }): React.JSX.Element | null {
  const { envs, toast, setEnvs } = useStore();
  if (!looksLikeSecret(value, field)) return null;
  const active = envs[collectionId]?.active ?? null;
  const store = async (): Promise<void> => {
    if (!active) return toast('Choose an environment first: the secret is stored for that environment on this machine.', 'error');
    const name = await prompt(`Store as a local secret in "${active}"`, suggestedName, 'Store secret', 'Variable name');
    if (!name) return;
    try {
      setEnvs(await yept.env.storeAsSecret(collectionId, active, name, value.trim()));
      onReplace(`{{${name}}}`);
      toast(`Stored as a local secret. The file now refers to {{${name}}}.`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="banner warn" style={{ margin: '6px 0 0' }}>
      <span>This looks like a real credential. It would be saved in the shared file and committed to Git.</span>
      <span className="spacer" />
      <button className="btn small" onClick={() => void store()}>
        Store as local secret
      </button>
    </div>
  );
}

export function AuthEditor({ auth, onChange, readOnly, allowInherit, collectionId, inheritedLabel }: Props): React.JSX.Element {
  const supported = isEditableAuth(auth);
  const unsupportedName = auth.mode === 'oauth2' ? `OAuth2 ${auth.oauth2.grantType}` : auth.mode;
  const modes = AUTH_MODES.filter((m) => allowInherit || m !== 'inherit');
  const o = auth.oauth2;
  const setOAuth = (patch: Partial<OAuth2Config>): void => onChange({ ...auth, oauth2: { ...o, ...patch } });
  const row = (label: string, el: React.ReactNode): React.JSX.Element => (
    <label className="field-row">
      <span className="field-label">{label}</span>
      {el}
    </label>
  );
  return (
    <div style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
      {row(
        'Type',
        <select className="input" value={supported ? auth.mode : '__other'} disabled={readOnly || !supported} onChange={(e) => onChange({ ...auth, mode: e.target.value })} aria-label="Auth type">
          {modes.map((m) => (
            <option key={m} value={m}>
              {LABELS[m]}
            </option>
          ))}
          {!supported && <option value="__other">{unsupportedName} (not editable in Yept)</option>}
        </select>
      )}
      {!supported && <p className="mute">This file uses "{unsupportedName}" auth, which Yept doesn't support yet. It's kept unchanged when you save; sending stops with an explanation.</p>}
      {auth.mode === 'inherit' && <p className="mute">Uses {inheritedLabel ?? 'the auth of the folder or collection above'}.</p>}
      {auth.mode === 'none' && <p className="mute">No Authorization header is added (use this for login and public endpoints).</p>}
      {auth.mode === 'bearer' && (
        <div>
          {row('Token', <VarInput className="input mono" value={auth.bearer.token} readOnly={readOnly} placeholder="{{accessToken}}" spellCheck={false} onChange={(e) => onChange({ ...auth, bearer: { token: e.target.value } })} aria-label="Bearer token" />)}
          <SecretHint value={auth.bearer.token} field="token" collectionId={collectionId} suggestedName="accessToken" onReplace={(ref) => onChange({ ...auth, bearer: { token: ref } })} />
          <p className="mute">Sent as <code>Authorization: Bearer &lt;token&gt;</code>. Use a variable such as <code>{'{{accessToken}}'}</code> filled by a login request.</p>
        </div>
      )}
      {auth.mode === 'basic' && (
        <div style={{ display: 'grid', gap: 8 }}>
          {row('Username', <VarInput className="input mono" value={auth.basic.username} readOnly={readOnly} placeholder="{{clientId}}" spellCheck={false} onChange={(e) => onChange({ ...auth, basic: { ...auth.basic, username: e.target.value } })} aria-label="Basic username" />)}
          {row('Password', <VarInput className="input mono" value={auth.basic.password} readOnly={readOnly} placeholder="{{clientSecret}}" spellCheck={false} onChange={(e) => onChange({ ...auth, basic: { ...auth.basic, password: e.target.value } })} aria-label="Basic password" />)}
          <SecretHint value={auth.basic.password} field="password" collectionId={collectionId} suggestedName="password" onReplace={(ref) => onChange({ ...auth, basic: { ...auth.basic, password: ref } })} />
        </div>
      )}
      {auth.mode === 'apikey' && (
        <div style={{ display: 'grid', gap: 8 }}>
          {row('Name', <input className="input mono" value={auth.apikey.key} readOnly={readOnly} placeholder="X-Api-Key" spellCheck={false} onChange={(e) => onChange({ ...auth, apikey: { ...auth.apikey, key: e.target.value } })} aria-label="API key name" />)}
          {row('Value', <VarInput className="input mono" value={auth.apikey.value} readOnly={readOnly} placeholder="{{apiKey}}" spellCheck={false} onChange={(e) => onChange({ ...auth, apikey: { ...auth.apikey, value: e.target.value } })} aria-label="API key value" />)}
          {row(
            'Send in',
            <select className="input" value={auth.apikey.placement} disabled={readOnly} onChange={(e) => onChange({ ...auth, apikey: { ...auth.apikey, placement: e.target.value as 'header' | 'queryparams' } })} aria-label="API key placement">
              <option value="header">Header</option>
              <option value="queryparams">Query string</option>
            </select>
          )}
          <SecretHint value={auth.apikey.value} field="apikey" collectionId={collectionId} suggestedName="apiKey" onReplace={(ref) => onChange({ ...auth, apikey: { ...auth.apikey, value: ref } })} />
        </div>
      )}
      {auth.mode === 'oauth2' && supported && (
        <div style={{ display: 'grid', gap: 8 }}>
          {row('Token URL', <VarInput className="input mono" value={o.accessTokenUrl} readOnly={readOnly} placeholder="{{baseUrl}}/oauth/token" spellCheck={false} onChange={(e) => setOAuth({ accessTokenUrl: e.target.value })} aria-label="Token URL" />)}
          {row('Client ID', <VarInput className="input mono" value={o.clientId} readOnly={readOnly} placeholder="{{clientId}}" spellCheck={false} onChange={(e) => setOAuth({ clientId: e.target.value })} aria-label="Client ID" />)}
          {row('Client secret', <VarInput className="input mono" value={o.clientSecret} readOnly={readOnly} placeholder="{{clientSecret}}" spellCheck={false} onChange={(e) => setOAuth({ clientSecret: e.target.value })} aria-label="Client secret" />)}
          <SecretHint value={o.clientSecret} field="password" collectionId={collectionId} suggestedName="clientSecret" onReplace={(ref) => setOAuth({ clientSecret: ref })} />
          {row('Scope', <VarInput className="input mono" value={o.scope} readOnly={readOnly} placeholder="Optional, e.g. bookings.read" spellCheck={false} onChange={(e) => setOAuth({ scope: e.target.value })} aria-label="Scope" />)}
          {row(
            'Send credentials',
            <select className="input" value={o.credentialsPlacement} disabled={readOnly} onChange={(e) => setOAuth({ credentialsPlacement: e.target.value as OAuth2Config['credentialsPlacement'] })} aria-label="Send client credentials">
              <option value="basic_auth_header">As Basic auth header</option>
              <option value="body">In the request body</option>
            </select>
          )}
          {row(
            'Add token to',
            <select className="input" value={o.tokenPlacement} disabled={readOnly} onChange={(e) => setOAuth({ tokenPlacement: e.target.value as OAuth2Config['tokenPlacement'] })} aria-label="Add token to">
              <option value="header">Authorization header</option>
              <option value="url">URL query parameter</option>
            </select>
          )}
          {o.tokenPlacement === 'header'
            ? row('Header prefix', <input className="input mono" value={o.tokenHeaderPrefix} readOnly={readOnly} placeholder="Bearer" spellCheck={false} onChange={(e) => setOAuth({ tokenHeaderPrefix: e.target.value })} aria-label="Token header prefix" />)
            : row('Parameter name', <input className="input mono" value={o.tokenQueryKey} readOnly={readOnly} placeholder="access_token" spellCheck={false} onChange={(e) => setOAuth({ tokenQueryKey: e.target.value })} aria-label="Token query parameter" />)}
          <label className="check-row">
            <input type="checkbox" checked={o.autoFetchToken} disabled={readOnly} onChange={(e) => setOAuth({ autoFetchToken: e.target.checked })} />
            Get a token automatically when there is none
          </label>
          <label className="check-row">
            <input type="checkbox" checked={o.autoRefreshToken} disabled={readOnly} onChange={(e) => setOAuth({ autoRefreshToken: e.target.checked })} />
            Get a new token automatically when it expires or is rejected
          </label>
          <p className="mute small">
            Tokens are kept in memory for each environment, never in files, and a restart gets a new one. If the server rejects a cached token with 401, a GET, HEAD or OPTIONS request is re-sent once with a new
            token; other requests are not re-sent automatically, because they may change data.
          </p>
        </div>
      )}
    </div>
  );
}
