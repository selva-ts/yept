import { useEffect, useMemo, useState } from 'react';
import { CODE_FONTS, CODE_SIZE, PALETTES, UI_FONTS } from '@shared/appearance';
import { DEFAULT_APP_SETTINGS, type AppSettings, type HistoryEntry, type OrphanedHistory, type ProxySettings } from '@shared/model';
import type { AppSettingsView } from '@shared/ipc';
import { errorMessage, formatBytes, yept } from '@yept/ui/api';
import { useStore } from '@yept/ui/store';
import { useDevTools } from '@yept/ui/devtools';
import { fontInstalled } from '@yept/ui/appearance';
import { confirm } from '@yept/ui/components/Dialogs';

const OTHER = '(other)';

/** An installed font: the curated ones found on this computer, or any other installed font typed by name. */
function FontPicker({ label, value, choices, defaultLabel, onChange }: { label: string; value: string; choices: string[]; defaultLabel: string; onChange: (font: string) => void }): React.JSX.Element {
  const installed = useMemo(() => choices.filter(fontInstalled), [choices]);
  const [other, setOther] = useState(!!value && !installed.includes(value));
  const [typed, setTyped] = useState(value);
  useEffect(() => {
    setTyped(value);
    // A reset or a curated choice leaves "Other"; a typed name keeps it.
    setOther(!!value && !installed.includes(value));
  }, [value, installed]);
  const missing = !!value && !fontInstalled(value);
  const commit = (): void => { if (typed.trim() !== value) onChange(typed.trim()); };
  return (
    <label className="field-row" style={{ alignItems: 'flex-start' }}>
      <span className="field-label" style={{ width: 200 }}>{label}</span>
      <span style={{ display: 'grid', gap: 4 }}>
        <span style={{ display: 'flex', gap: 6 }}>
          <select className="input" style={{ flex: 'none', width: 240 }} aria-label={label} value={other ? OTHER : value} onChange={(e) => {
            const v = e.target.value;
            setOther(v === OTHER);
            if (v !== OTHER) onChange(v);
          }}>
            <option value="">{defaultLabel}</option>
            {installed.map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{f}</option>)}
            <option value={OTHER}>Other installed font…</option>
          </select>
          {other && (
            <input className="input" style={{ flex: 'none', width: 180 }} aria-label={`${label} name`} placeholder="Font name" value={typed} maxLength={64}
              onChange={(e) => setTyped(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
          )}
        </span>
        {missing && <span className="warn-text small" role="status">&quot;{value}&quot; isn&apos;t installed on this computer, so the default font is used.</span>}
      </span>
    </label>
  );
}

/** How requests reach the network: system settings, a manual proxy, or direct; and the proxy's sign-in. */
function ProxySection({ value, onChange, passwordSet, password, onPassword, onClearPassword }: {
  value: ProxySettings;
  onChange: (p: ProxySettings) => void;
  passwordSet: boolean;
  /** A new password typed here, saved with Save; null when unchanged. */
  password: string | null;
  onPassword: (p: string | null) => void;
  onClearPassword: () => void;
}): React.JSX.Element {
  const set = (change: Partial<ProxySettings>): void => onChange({ ...value, ...change });
  const row = (label: string, control: React.JSX.Element, help?: string): React.JSX.Element => (
    <label className="field-row" style={{ alignItems: 'flex-start' }}>
      <span className="field-label" style={{ width: 200 }}>{label}</span>
      <span style={{ display: 'grid', gap: 2, flex: 1 }}>
        {control}
        {help && <span className="mute small">{help}</span>}
      </span>
    </label>
  );
  return (
    <>
      <h4 className="section-title">Proxy</h4>
      <p className="mute small" style={{ margin: 0 }}>
        For requests, redirects, OAuth2 tokens and script requests. Localhost always connects directly. Kept on this computer only.
      </p>
      {row('Connect', (
        <select className="input" style={{ width: 240 }} aria-label="Proxy" value={value.mode} onChange={(e) => set({ mode: e.target.value as ProxySettings['mode'] })}>
          <option value="system">System proxy settings</option>
          <option value="manual">Manual proxy</option>
          <option value="off">Directly (no proxy)</option>
        </select>
      ), value.mode === 'system'
        ? 'Uses HTTPS_PROXY, HTTP_PROXY and NO_PROXY when they are set, otherwise the Windows proxy settings (including a setup script).'
        : value.mode === 'off' ? 'Ignores proxy settings and environment variables.' : undefined)}
      {value.mode === 'manual' && (
        <>
          {row('Proxy address', (
            <input className="input mono" aria-label="Proxy address" placeholder="http://proxy.example.test:8080" value={value.url} maxLength={2000} onChange={(e) => set({ url: e.target.value })} />
          ), 'An HTTP proxy, http:// or https://. HTTPS requests go through it with CONNECT.')}
          {row('Bypass for', (
            <textarea className="input mono" rows={2} aria-label="Bypass proxy for" placeholder="*.internal.example.test, 10.0.0.0/8, <local>" value={value.bypass} maxLength={4000} onChange={(e) => set({ bypass: e.target.value })} />
          ), 'Hosts that connect directly: separate with commas or new lines. example.test covers its subdomains; <local> means names without a dot.')}
        </>
      )}
      {value.mode !== 'off' && (
        <>
          {row('Proxy username', (
            <input className="input" style={{ width: 240 }} aria-label="Proxy username" autoComplete="off" value={value.username} maxLength={500} onChange={(e) => set({ username: e.target.value })} />
          ), 'Basic sign-in, sent to the proxy only. Leave empty if the proxy needs none.')}
          {row('Proxy password', (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className="input" type="password" style={{ flex: 'none', width: 240 }} aria-label="Proxy password" autoComplete="new-password"
                placeholder={passwordSet ? 'Saved (type to replace)' : 'Not set'} value={password ?? ''} onChange={(e) => onPassword(e.target.value === '' ? null : e.target.value)} />
              {passwordSet && password === null && <button className="btn small" onClick={(e) => { e.preventDefault(); onClearPassword(); }}>Remove</button>}
            </span>
          ), 'Stored encrypted on this computer.')}
        </>
      )}
    </>
  );
}

export function AppSettingsDialog(): React.JSX.Element | null {
  const { appSettingsOpen, setAppSettingsOpen, setOrphansOpen, setAboutOpen, appearance, setAppearance, toast } = useStore();
  const [data, setData] = useState<AppSettingsView | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [proxyPassword, setProxyPassword] = useState<string | null>(null);

  useEffect(() => {
    if (!appSettingsOpen) return;
    setProxyPassword(null);
    yept.appSettings
      .get()
      .then((d) => {
        setData(d);
        setDraft(d.settings);
      })
      .catch((e) => toast(errorMessage(e), 'error'));
  }, [appSettingsOpen, toast]);

  if (!appSettingsOpen || !data || !draft) return null;
  const save = async (): Promise<void> => {
    try {
      // Appearance is applied on its own (below); keep whatever is current.
      let d = await yept.appSettings.set({ ...draft, ...appearance });
      if (proxyPassword !== null) d = await yept.appSettings.setProxyPassword(proxyPassword);
      setProxyPassword(null);
      setData(d);
      setDraft(d.settings);
      // The Cookies tab shows whether automatic cookies are on.
      for (const id of Object.keys(useDevTools.getState().jars)) void useDevTools.getState().loadJar(id);
      toast('Settings saved');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const num = (k: 'historyRunsPerRequest' | 'historyCapMb' | 'historyBodyLimitMb', label: string, unit: string, step: number, help: string): React.JSX.Element => (
    <label className="field-row" style={{ alignItems: 'flex-start' }}>
      <span className="field-label" style={{ width: 200 }}>{label}</span>
      <span style={{ display: 'grid', gap: 2 }}>
        <span>
          <input className="input mono" type="number" min={0} step={step} style={{ width: 110 }} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} aria-label={label} /> <span className="mute">{unit}</span>
        </span>
        <span className="mute small">{help}</span>
      </span>
    </label>
  );
  // Appearance is applied immediately, so only the other settings count as unsaved.
  const dirty = proxyPassword !== null || JSON.stringify({ ...draft, ...appearance }) !== JSON.stringify({ ...data.settings, ...appearance });
  const clearProxyPassword = async (): Promise<void> => {
    try {
      setData(await yept.appSettings.setProxyPassword(null));
      toast('Proxy password removed');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const { theme, palette, uiFont, codeFont, codeFontSize } = DEFAULT_APP_SETTINGS;
  const isDefault = JSON.stringify(appearance) === JSON.stringify({ theme, palette, uiFont, codeFont, codeFontSize });
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setAppSettingsOpen(false)}>
      <div className="dialog scroll" role="dialog" aria-label="Settings" style={{ width: 'min(640px, 94vw)' }}>
        <div className="dialog-body" style={{ display: 'grid', gap: 12 }}>
          <h3>Settings</h3>
          <h4 className="section-title" style={{ marginTop: 0 }}>Appearance</h4>
          <p className="mute small" style={{ margin: 0 }}>Applies immediately and is kept on this computer only.</p>
          <label className="field-row">
            <span className="field-label" style={{ width: 200 }}>Theme</span>
            <select className="input" style={{ flex: 'none', width: 240 }} value={appearance.palette} onChange={(e) => void setAppearance({ palette: e.target.value as AppSettings['palette'] })} aria-label="Theme">
              {PALETTES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="mute small">{PALETTES.find((p) => p.id === appearance.palette)?.description}</span>
          </label>
          <label className="field-row">
            <span className="field-label" style={{ width: 200 }}>Light or dark</span>
            <select className="input" style={{ flex: 'none', width: 240 }} value={appearance.theme} onChange={(e) => void setAppearance({ theme: e.target.value as AppSettings['theme'] })} aria-label="Light or dark">
              <option value="system">System (follow Windows)</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <FontPicker label="Interface font" value={appearance.uiFont} choices={UI_FONTS} defaultLabel="Default (Aptos or Segoe UI)" onChange={(uiFont) => void setAppearance({ uiFont })} />
          <FontPicker label="Code font" value={appearance.codeFont} choices={CODE_FONTS} defaultLabel="Default (Cascadia Code or Consolas)" onChange={(codeFont) => void setAppearance({ codeFont })} />
          <label className="field-row">
            <span className="field-label" style={{ width: 200 }}>Code font size</span>
            <input className="input mono" type="number" min={CODE_SIZE.min} max={CODE_SIZE.max} step={0.5} style={{ flex: 'none', width: 80 }} aria-label="Code font size"
              key={appearance.codeFontSize} defaultValue={appearance.codeFontSize}
              onBlur={(e) => e.target.value !== '' && Number(e.target.value) !== appearance.codeFontSize && void setAppearance({ codeFontSize: Number(e.target.value) })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
            <span className="mute small">px, in editors ({CODE_SIZE.min}–{CODE_SIZE.max})</span>
          </label>
          <div>
            <button className="btn small" disabled={isDefault} onClick={() => void setAppearance({ theme, palette, uiFont, codeFont, codeFontSize })}>Reset appearance to defaults</button>
          </div>
          <h4 className="section-title">Response history</h4>
          <p className="mute small" style={{ margin: 0 }}>
            Every send is kept on this machine (never in the repository), with secrets redacted. Now: {data.historyRuns} runs, {formatBytes(data.historyBytes)}.
          </p>
          {num('historyRunsPerRequest', 'Runs kept per request', 'runs', 1, 'Older runs of a request are removed first.')}
          {num('historyCapMb', 'Total history size', 'MB', 10, 'When exceeded, the oldest runs across all requests are removed.')}
          {num('historyBodyLimitMb', 'Response body kept per run', 'MB', 0.5, 'Larger bodies are kept truncated and labelled. 0 keeps no bodies at all.')}
          <div>
            <button className="btn small" onClick={() => { setAppSettingsOpen(false); setOrphansOpen(true); }}>
              History of deleted or moved requests…
            </button>
          </div>
          <h4 className="section-title">Cookies</h4>
          <label className="field-row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={draft.cookies} onChange={(e) => setDraft({ ...draft, cookies: e.target.checked })} />
            <span style={{ display: 'grid', gap: 2 }}>
              <span>Store and send cookies automatically</span>
              <span className="mute small">
                Each collection and environment has its own cookie jar, kept on this machine only and encrypted. Session cookies are cleared when Yept closes. A request&apos;s own Cookie header always wins.
              </span>
            </span>
          </label>
          <ProxySection value={draft.proxy} onChange={(proxy) => setDraft({ ...draft, proxy })} passwordSet={!!data.proxyPasswordSet}
            password={proxyPassword} onPassword={setProxyPassword} onClearPassword={() => void clearProxyPassword()} />
          <div><button className="btn small" onClick={() => { setAppSettingsOpen(false); setAboutOpen(true); }}>About Yept and third-party notices…</button></div>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => setAppSettingsOpen(false)}>
            Close
          </button>
          <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** History whose request no longer exists: look at it, attach it to the open request, or delete it. */
export function OrphansDialog(): React.JSX.Element | null {
  const { orphansOpen, setOrphansOpen, toast, tabs, activeId, loadHistory } = useStore();
  const [items, setItems] = useState<OrphanedHistory[] | null>(null);
  const [peek, setPeek] = useState<HistoryEntry | null>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  const load = (): void => {
    yept.history
      .orphans()
      .then(setItems)
      .catch((e) => toast(errorMessage(e), 'error'));
  };
  useEffect(() => {
    if (orphansOpen) {
      setItems(null);
      setPeek(null);
      load();
    }
  }, [orphansOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!orphansOpen) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOrphansOpen(false)}>
      <div className="dialog wide" role="dialog" aria-label="Orphaned history">
        <div className="dialog-body">
          <h3>History of deleted or moved requests</h3>
          <p className="mute small">
            These runs belong to requests Yept can no longer find (deleted, or renamed outside Yept and not matched). Yept never guesses where they belong: attach them to the open request, or delete
            them.
          </p>
          {items === null && <span className="spinner" />}
          {items?.length === 0 && <p>Nothing here: all history belongs to existing requests.</p>}
          {!!items?.length && (
            <table className="headers-list">
              <tbody>
                {items.map((o) => (
                  <tr key={o.requestId}>
                    <td>
                      <b>{o.requestName}</b>
                      <div className="mono small mute">{o.requestPath}</div>
                    </td>
                    <td className="small">
                      {o.runs} run{o.runs > 1 ? 's' : ''} · last {new Date(o.lastRun).toLocaleString()}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn small"
                        onClick={async () => {
                          const list = await yept.history.list(o.requestId);
                          if (list[0]) setPeek(await yept.history.get(list[0].runId));
                        }}
                      >
                        View last run
                      </button>{' '}
                      <button
                        className="btn small"
                        disabled={!active}
                        title={active ? `Attach to "${active.draft.name}"` : 'Open the request it belongs to first'}
                        onClick={async () => {
                          if (!active) return;
                          await yept.history.reattach(o.requestId, active.id);
                          await loadHistory(active.id);
                          toast(`Attached to "${active.draft.name}"`);
                          load();
                        }}
                      >
                        Attach to {active ? `"${active.draft.name}"` : 'open request'}
                      </button>{' '}
                      <button
                        className="btn small danger-text"
                        onClick={async () => {
                          if (!(await confirm('Delete this history?', `Deletes ${o.runs} stored run(s) of "${o.requestName}" from this machine.`, 'Delete', true))) return;
                          await yept.history.clear(o.requestId);
                          load();
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {peek && (
            <div className="peek">
              <h4 className="section-title">
                Last run of {peek.summary.requestName}: {peek.result.outcome === 'http' ? peek.result.status : peek.result.outcome} · {peek.summary.environment || 'no environment'}
              </h4>
              <pre className="console-out" style={{ maxHeight: 220, overflow: 'auto' }}>
                {peek.result.request.method} {peek.result.request.url}
                {'\n\n'}
                {peek.result.body.text.slice(0, 4000) || '(no body kept)'}
              </pre>
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => setOrphansOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
