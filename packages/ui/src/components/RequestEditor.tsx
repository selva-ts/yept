import { useEffect, useMemo, useState } from 'react';
import type { RequestPreview } from '@shared/ipc';
import { BODY_MODES, HTTP_METHODS, type BodyMode, type KeyValue, type Param, type RequestDoc } from '@shared/model';
import { paramsFromUrl, urlFromParams } from '@shared/url-params';
import { isBuiltinVar, VAR_RE } from '@shared/vars';
import { yept } from '../api';
import { isDirty, useStore, type Tab } from '../store';
import { OAuth2Token } from './OAuth2Token';
import { AuthEditor, SecretHint } from './AuthEditor';
import { CodeEditor } from './CodeEditor';
import { EnvSwitcher } from './EnvSwitcher';
import { KeyValueTable } from './KeyValueTable';
import { MultipartEditor } from './MultipartEditor';
import { VarContext, VarInput, makeVarLookup } from './VarInput';
import { ScriptsEditor, VarsTable } from './ScriptVarsEditors';

type Section = 'params' | 'headers' | 'body' | 'auth' | 'vars' | 'script' | 'tests' | 'docs' | 'settings';

const BODY_LABELS: Record<BodyMode, string> = { none: 'No body', json: 'JSON', text: 'Text', xml: 'XML', formUrlEncoded: 'Form URL-encoded', multipartForm: 'Multipart' };
// Bruno body modes Yept keeps but doesn't edit or send; any other unknown mode shows its own name.
const UNSUPPORTED_BODY_LABELS: Record<string, string> = { file: 'Binary file', sparql: 'SPARQL', graphql: 'GraphQL' };
const SOURCE_LABELS: Record<string, string> = {
  collection: 'collection variable',
  environment: 'environment file',
  override: 'local override (this machine)',
  secret: 'local secret (this machine)',
  session: 'set by a script this session',
  folder: 'folder variable',
  request: 'request variable',
  runtime: 'runtime variable (this session)'
};

function usePreview(tab: Tab): RequestPreview | null {
  const varsVersion = useStore((s) => s.varsVersion);
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      yept.env
        .preview(tab.id, tab.draft)
        .then((p) => !cancelled && setPreview(p))
        .catch((e) => { console.warn('preview failed', String(e)); if (!cancelled) setPreview(null); });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tab.id, tab.draft, varsVersion]);
  return preview;
}

/** The URL with variables filled in (secrets masked); missing ones in red, sources on hover. */
function ResolvedUrl({ url, preview }: { url: string; preview: RequestPreview | null }): React.JSX.Element {
  const vars = new Map((preview?.vars ?? []).map((v) => [v.name, v]));
  const parts: React.ReactNode[] = [];
  let last = 0;
  const missing: string[] = [];
  for (const m of url.matchAll(VAR_RE)) {
    const name = m[1];
    parts.push(url.slice(last, m.index));
    const v = vars.get(name);
    if (isBuiltinVar(name)) parts.push(<span key={m.index} className="var-builtin" title="Generated when the request is sent">{m[0]}</span>);
    else if (v && v.value !== '') parts.push(<span key={m.index} className={`var-ok ${v.secret ? 'secret' : ''}`} title={`{{${name}}} from ${SOURCE_LABELS[v.source] ?? v.source}`}>{v.value}</span>);
    else {
      missing.push(name);
      parts.push(<span key={m.index} className="var-missing" title={`{{${name}}} has no value in ${preview?.environment ? `"${preview.environment}"` : 'any layer (no environment selected)'}`}>{m[0]}</span>);
    }
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(url.slice(last));
  // Until the first preview arrives, show the raw URL without flagging anything as missing.
  if (!preview) return <div className="resolved" title={url}><span className="mono mute">{url || 'Enter a URL'}</span></div>;
  return (
    <div className="resolved" title={url}>
      <span className="mono">{url ? parts : <span className="mute">Enter a URL</span>}</span>
      {missing.length > 0 && <span className="warn"> · missing {missing.map((n) => `{{${n}}}`).join(', ')}</span>}
      {preview?.skipVerify && <span className="warn"> · TLS checks off</span>}
    </div>
  );
}

function usedVarNames(d: RequestDoc): string[] {
  const on = (l: KeyValue[]): KeyValue[] => l.filter((x) => x.enabled);
  const body = d.body.mode === 'json' ? d.body.json : d.body.mode === 'text' ? d.body.text : d.body.mode === 'xml' ? d.body.xml : '';
  const text = [...on(d.headers).flatMap((h) => [h.name, h.value]), body, ...(d.body.mode === 'formUrlEncoded' ? on(d.body.formUrlEncoded).flatMap((f) => [f.name, f.value]) : []),
    ...(d.body.mode === 'multipartForm' ? d.body.multipartForm.filter((f) => f.enabled).flatMap((f) => [f.name, f.contentType, ...(f.type === 'file' ? [...f.files, ...f.localFiles] : [f.value])]) : [])].join(' ');
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1]).filter((n) => !isBuiltinVar(n)))];
}

export function RequestEditor({ tab }: { tab: Tab }): React.JSX.Element {
  const { updateDraft, send, cancel, save, resolveConflict } = useStore();
  const [section, setSection] = useState<Section>('params');
  const preview = usePreview(tab);
  const d = tab.draft;
  const ro = tab.readOnly;
  const edit = (fn: (d: RequestDoc) => RequestDoc): void => updateDraft(tab.id, fn);
  const running = !!tab.run?.running;

  const setUrl = (url: string): void => edit((x) => ({ ...x, url, params: paramsFromUrl(url, x.params) }));
  const setParams = (params: Param[]): void => edit((x) => ({ ...x, params, url: urlFromParams(x.url, params) }));
  const setBody = (patch: Partial<RequestDoc['body']>): void => edit((x) => ({ ...x, body: { ...x.body, ...patch } }));
  const setSettings = (patch: Partial<RequestDoc['settings']>): void => edit((x) => ({ ...x, settings: { ...x.settings, ...patch } }));

  const known = new Set((preview?.vars ?? []).filter((v) => v.value !== '').map((v) => v.name));
  const missingElsewhere = preview ? usedVarNames(d).filter((n) => !known.has(n)) : [];
  const count = (l: KeyValue[]): number => l.filter((x) => x.enabled && x.name).length;
  // The effective auth after inheritance; unknown until the first preview arrives.
  const effective = preview?.auth.mode;
  const unsupportedBody = d.body.unsupported ? (UNSUPPORTED_BODY_LABELS[d.body.unsupported] ?? d.body.unsupported) : undefined;
  const sections: { id: Section; label: string; badge?: string | number }[] = [
    { id: 'params', label: 'Params', badge: count(d.params) || undefined },
    { id: 'headers', label: 'Headers', badge: count(d.headers) || undefined },
    { id: 'body', label: 'Body', badge: unsupportedBody ?? (d.body.mode === 'none' ? undefined : BODY_LABELS[d.body.mode]) },
    { id: 'auth', label: 'Auth', badge: d.auth.mode === 'inherit' ? (!effective || effective === 'none' ? 'inherit' : `inherit · ${effective}`) : d.auth.mode === 'none' ? undefined : d.auth.mode },
    { id: 'vars', label: 'Vars', badge: count(d.vars.req) + count(d.vars.res) || undefined },
    { id: 'script', label: 'Script', badge: d.script.req.trim() || d.script.res.trim() ? '●' : undefined },
    { id: 'tests', label: 'Tests', badge: count(d.assertions) + (d.tests.match(/\btest\s*\(/g)?.length ?? 0) || undefined },
    { id: 'docs', label: 'Docs' },
    { id: 'settings', label: 'Settings' }
  ];
  const authHeader = d.headers.findIndex((h) => h.enabled && h.name.toLowerCase() === 'authorization');
  const varLookup = useMemo(() => makeVarLookup(preview?.vars ?? null, preview?.environment ?? null, (s) => SOURCE_LABELS[s] ?? s), [preview]);

  return (
    <VarContext.Provider value={varLookup}>
      <div className="editor-section">
        <div>
          <div className="doc-head">
            <div className="doc-title">
              {d.name}
              {isDirty(tab) && <span className="dirty-dot" title="Unsaved changes" />}
              {ro && <span className="badge mute" style={{ fontSize: 11, border: '1px solid var(--line)', borderRadius: 8, padding: '0 6px' }}>read-only · .bru</span>}
            </div>
            <div className="doc-path">{tab.path}</div>
            <div className="urlbar">
              <select value={d.method} disabled={ro} className={`m-${d.method}`} onChange={(e) => edit((x) => ({ ...x, method: e.target.value as RequestDoc['method'] }))} aria-label="Method">
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <VarInput
                className="input url"
                value={d.url}
                readOnly={ro}
                placeholder="{{baseUrl}}/items  ·  https://api.example.test/v1/items"
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void send(tab.id)}
                aria-label="URL"
              />
              <EnvSwitcher collectionId={tab.collectionId} />
              {running ? (
                <button className="btn" onClick={() => void cancel(tab.id)}>
                  <span className="spinner" /> Cancel
                </button>
              ) : (
                <button className="btn primary" onClick={() => void send(tab.id)} title="Send (Ctrl+Enter)">
                  Send
                </button>
              )}
              <button className="btn" disabled={ro || !isDirty(tab)} onClick={() => void save(tab.id)} title="Save (Ctrl+S)">
                Save
              </button>
            </div>
            <ResolvedUrl url={d.url} preview={preview} />
            {missingElsewhere.length > 0 && (
              <div className="resolved">
                <span className="warn">Also missing in headers or body: {missingElsewhere.map((n) => `{{${n}}}`).join(', ')}</span>
              </div>
            )}
          </div>
          {tab.conflict && (
            <div className="banner warn">
              <span>{tab.conflict === 'changed' ? 'This file changed on disk while you were editing it.' : 'This file was deleted or moved outside Yept. Your unsaved edits are still here.'}</span>
              <span className="spacer" />
              <button className="btn small" onClick={() => void resolveConflict(tab.id, 'reload')}>
                {tab.conflict === 'changed' ? 'Reload from disk (lose my edits)' : 'Close tab'}
              </button>
              {tab.conflict === 'changed' && (
                <button className="btn small" onClick={() => void resolveConflict(tab.id, 'keep')}>
                  Keep my edits
                </button>
              )}
            </div>
          )}
          <div className="subtabs" role="tablist">
            {sections.map((s) => (
              <button key={s.id} role="tab" className={`subtab ${section === s.id ? 'active' : ''}`} onClick={() => setSection(s.id)}>
                {s.label}
                {s.badge !== undefined && <span className="count">{s.badge}</span>}
              </button>
            ))}
          </div>
        </div>

        {section === 'params' && (
          <div className="pane">
            <KeyValueTable rows={d.params} readOnly={ro} onChange={setParams} make={(p): Param => ({ ...p, enabled: true, type: 'query' })} namePlaceholder="parameter" lockName={(r) => r.type === 'path'} canDelete={(r) => r.type === 'query'} />
            {d.params.some((p) => p.type === 'path') && <p className="mute">Path parameters come from <code>:name</code> segments in the URL.</p>}
          </div>
        )}

        {section === 'headers' && (
          <div className="pane">
            <KeyValueTable rows={d.headers} readOnly={ro} onChange={(headers) => edit((x) => ({ ...x, headers }))} make={(p) => ({ ...p, enabled: true })} namePlaceholder="header" />
            {authHeader >= 0 && (
              <SecretHint
                value={d.headers[authHeader].value.replace(/^(bearer|basic)\s+/i, '')}
                field="token"
                collectionId={tab.collectionId}
                suggestedName="accessToken"
                onReplace={(ref) => edit((x) => ({ ...x, headers: x.headers.map((h, i) => (i === authHeader ? { ...h, value: `Bearer ${ref}` } : h)) }))}
              />
            )}
            <p className="mute small">Collection and folder headers are added too; a header here with the same name wins.</p>
          </div>
        )}

        {section === 'body' && (
          <div className="pane flush">
            <div className="body-toolbar">
              {BODY_MODES.map((m) => (
                <label key={m} style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: ro ? 'default' : 'pointer' }}>
                  <input type="radio" name={`body-${tab.id}`} checked={!unsupportedBody && d.body.mode === m} disabled={ro} onChange={() => setBody({ mode: m, unsupported: undefined })} />
                  {BODY_LABELS[m]}
                </label>
              ))}
            </div>
            {unsupportedBody && (
              <div className="empty">
                This body type ({unsupportedBody}) isn't supported yet and is kept unchanged when you save. Sending stops with an explanation. Choosing another body type above replaces it when you save.
              </div>
            )}
            {!unsupportedBody && d.body.mode === 'none' && <div className="empty">This request has no body.</div>}
            {(d.body.mode === 'json' || d.body.mode === 'text' || d.body.mode === 'xml') && (
              <div className="monaco-host">
                <CodeEditor value={d.body[d.body.mode]} language={d.body.mode === 'text' ? 'plaintext' : d.body.mode} readOnly={ro} highlightVars onChange={(v) => setBody({ [d.body.mode]: v })} />
              </div>
            )}
            {d.body.mode === 'multipartForm' && (
              <div className="pane">
                <MultipartEditor requestId={tab.id} fields={d.body.multipartForm} readOnly={ro} onChange={(multipartForm) => setBody({ multipartForm })} />
              </div>
            )}
            {d.body.mode === 'formUrlEncoded' && (
              <div className="pane">
                <KeyValueTable rows={d.body.formUrlEncoded} readOnly={ro} onChange={(formUrlEncoded) => setBody({ formUrlEncoded })} make={(p) => ({ ...p, enabled: true })} namePlaceholder="field" />
              </div>
            )}
          </div>
        )}

        {section === 'auth' && (
          <div className="pane">
            <AuthEditor
              auth={d.auth}
              onChange={(auth) => edit((x) => ({ ...x, auth }))}
              readOnly={ro}
              allowInherit
              collectionId={tab.collectionId}
              inheritedLabel={preview ? `${preview.auth.mode === 'none' ? 'no auth' : preview.auth.mode === 'oauth2' ? 'OAuth2' : `${preview.auth.mode} auth`} from ${preview.authFrom}` : undefined}
            />
            {preview?.auth.mode === 'oauth2' && <OAuth2Token tab={tab} autoFetch={preview.auth.oauth2.autoFetchToken} />}
          </div>
        )}

        {section === 'vars' && (
          <div className="pane">
            <h4 className="section-title">Before the request</h4>
            <p className="mute small">Request variables: the highest shared layer, above the environment and folders.</p>
            <VarsTable rows={d.vars.req} readOnly={ro} onChange={(req) => edit((x) => ({ ...x, vars: { ...x.vars, req } }))} kind="static" />
            <h4 className="section-title">After the response: extract values</h4>
            <p className="mute small">
              For example <code>accessToken</code> = <code>res.body.access_token</code>. Values are only kept from 2xx responses with a non-empty result; otherwise the variable is cleared. If the name is a secret in the
              environment, the value is stored as a local secret for that environment; otherwise it's a runtime variable for this session.
            </p>
            <VarsTable rows={d.vars.res} readOnly={ro} onChange={(res) => edit((x) => ({ ...x, vars: { ...x.vars, res } }))} kind="extract" />
          </div>
        )}

        {section === 'script' && (
          <div className="pane flush">
            <ScriptsEditor script={d.script} onChange={(script) => edit((x) => ({ ...x, script }))} readOnly={ro} level="request" />
          </div>
        )}

        {section === 'tests' && (
          <div className="pane flush tests-editor">
            <div className="tests-assertions">
              <h4 className="section-title">Assertions</h4>
              <p className="mute small">
                Quick checks without code: <code>res.status</code> <code>eq 200</code>, <code>res.body.items</code> <code>length 3</code>, <code>res.body.id</code> <code>isDefined</code>. Operators: eq, neq, gt, gte, lt, lte, in, notIn,
                contains, notContains, length, matches, notMatches, startsWith, endsWith, between, isEmpty, isNull, isUndefined, isDefined, isTruthy, isFalsy, isJson, isNumber, isString, isBoolean, isArray.
              </p>
              <KeyValueTable rows={d.assertions} readOnly={ro} onChange={(assertions) => edit((x) => ({ ...x, assertions }))} make={(p) => ({ ...p, enabled: true })} namePlaceholder="expression, e.g. res.status" valuePlaceholder="check, e.g. eq 200" />
            </div>
            <div className="script-pane" style={{ flex: 1 }}>
              <div className="script-title">
                <b>Tests</b>{' '}
                <span className="mute small">
                  <code>test("name", () =&gt; expect(res.status).to.equal(200))</code>, using Chai's <code>expect</code>. Collection and folder tests run too. A script error or an unknown matcher shows as an error, never as a pass.
                </span>
              </div>
              <div className="monaco-host">
                <CodeEditor value={d.tests} language="javascript" readOnly={ro} onChange={(tests) => edit((x) => ({ ...x, tests }))} />
              </div>
            </div>
          </div>
        )}

        {section === 'docs' && (
          <div className="pane flush">
            <textarea className="input docs-area" value={d.docs} readOnly={ro} placeholder="Notes for teammates: what this request is for, sample values, gotchas. Saved in the file (Markdown)." onChange={(e) => edit((x) => ({ ...x, docs: e.target.value }))} />
          </div>
        )}

        {section === 'settings' && (
          <div className="pane" style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Timeout
              <input className="input mono" type="number" min={0} style={{ width: 110 }} value={d.settings.timeoutMs} readOnly={ro} onChange={(e) => setSettings({ timeoutMs: Math.max(0, Number(e.target.value) || 0) })} />
              <span className="mute">ms (0 = app default, 30 s)</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={d.settings.followRedirects} disabled={ro} onChange={(e) => setSettings({ followRedirects: e.target.checked })} />
              Follow redirects, up to
              <input className="input mono" type="number" min={0} max={50} style={{ width: 70 }} value={d.settings.maxRedirects} readOnly={ro} onChange={(e) => setSettings({ maxRedirects: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={d.settings.forwardAuthorizationHeader} disabled={ro} onChange={(e) => setSettings({ forwardAuthorizationHeader: e.target.checked })} />
              Send the Authorization header to other hosts after a redirect
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={d.settings.encodeUrl} disabled={ro} onChange={(e) => setSettings({ encodeUrl: e.target.checked })} />
              Encode the URL (spaces and non-ASCII characters; existing %XX escapes are kept)
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!d.settings.sendCookies} disabled={ro} onChange={(e) => setSettings({ sendCookies: !e.target.checked })} />
              <span>
                Don&apos;t send stored cookies
                <span className="mute small" style={{ display: 'block' }}>Cookies this request receives are still stored. Saved on this computer only, not in the request file.</span>
              </span>
            </label>
          </div>
        )}
      </div>
    </VarContext.Provider>
  );
}
