import { useEffect, useMemo, useState } from 'react';
import { CODE_FONTS, CODE_SIZE, PALETTES, UI_FONTS } from '@shared/appearance';
import { DEFAULT_APP_SETTINGS, type AppSettings, type HistoryEntry, type OrphanedHistory } from '@shared/model';
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

export function AppSettingsDialog(): React.JSX.Element | null {
  const { appSettingsOpen, setAppSettingsOpen, setOrphansOpen, setAboutOpen, appearance, setAppearance, toast } = useStore();
  const [data, setData] = useState<{ settings: AppSettings; historyRuns: number; historyBytes: number } | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (!appSettingsOpen) return;
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
      const d = await yept.appSettings.set({ ...draft, ...appearance });
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
  const dirty = JSON.stringify({ ...draft, ...appearance }) !== JSON.stringify({ ...data.settings, ...appearance });
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
