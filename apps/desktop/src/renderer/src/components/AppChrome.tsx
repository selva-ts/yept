import { useEffect, useRef, useState } from 'react';
import { PALETTES, type ThemeChoice } from '@shared/appearance';
import { errorMessage, yept } from '@yept/ui/api';
import { useStore } from '@yept/ui/store';
import { createCollection, importCollection, openFolder, pasteCurl } from '../actions';
import { collectionLabel } from '../collections';
import { BrandMark } from './BrandMark';
import { DevToolsStatus } from '@yept/ui/components/DevTools';
import { RunnerStatus } from '@yept/ui/components/RunnerDialog';

const isMac = navigator.userAgent.includes('Macintosh');

const MODES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
];

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
}

/** The ☰ application menu. Alt or the button opens it; arrows move; Esc closes. */
function AppMenu(): React.JSX.Element {
  const { snapshot, appearance, setAppearance, setGitOpen, setAppSettingsOpen, setAboutOpen } = useStore();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const items: MenuItem[] = [
    { label: 'Open folder…', run: () => void openFolder() },
    { label: 'Import…', run: () => void importCollection(), disabled: !snapshot },
    { label: 'Paste cURL…', run: () => pasteCurl(), disabled: !snapshot },
    { label: 'New collection…', run: () => void createCollection(), disabled: !snapshot },
    { label: 'Git…', run: () => setGitOpen(true), disabled: !snapshot, separatorBefore: true },
    ...PALETTES.map((p, i) => ({ label: `${p.label} theme`, run: () => void setAppearance({ palette: p.id }), checked: appearance.palette === p.id, separatorBefore: i === 0 })),
    ...MODES.map((m, i) => ({ label: `${m.label} mode`, run: () => void setAppearance({ theme: m.id }), checked: appearance.theme === m.id, separatorBefore: i === 0 })),
    { label: 'Settings…', run: () => setAppSettingsOpen(true), separatorBefore: true },
    { label: 'About Yept', run: () => setAboutOpen(true) },
    // macOS quits from the app menu (⌘Q); closing the window there would leave the app running.
    ...(isMac ? [] : [{ label: 'Exit', run: () => window.close(), separatorBefore: true }])
  ];

  const focusItem = (step: number): void => {
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + step + all.length) % all.length]?.focus();
  };

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  // A lone Alt press opens the menu, as a Windows menu bar would (not on macOS, where Option types characters).
  useEffect(() => {
    if (isMac) return;
    let altAlone = false;
    const down = (e: KeyboardEvent): void => { altAlone = e.key === 'Alt' && !e.repeat; };
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' && altAlone) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      altAlone = false;
    };
    const close = (): void => setOpen(false);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', close);
    };
  }, []);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  return (
    <div className="app-menu">
      <button ref={button} className="titlebar-btn" aria-label="Menu" aria-haspopup="menu" aria-expanded={open} title={isMac ? 'Menu' : 'Menu (Alt)'} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <>
          <div className="app-menu-backdrop" onMouseDown={() => close(false)} />
          <div
            ref={list}
            className="menu app-menu-list"
            role="menu"
            aria-label="Yept"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(-1); }
              else if (e.key === 'Escape') { e.preventDefault(); close(true); }
            }}
          >
            {items.map((item) => (
              <div key={item.label} role="none">
                {item.separatorBefore && <hr />}
                <button
                  role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={item.checked}
                  disabled={item.disabled}
                  onClick={() => { close(false); item.run(); }}
                >
                  <span className="menu-check" aria-hidden="true">{item.checked ? '●' : ''}</span>
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The window's title bar. Windows draws the caption buttons over its right end (titleBarOverlay in main). */
export function TitleBar(): React.JSX.Element {
  const { snapshot, view, selectedCollectionId, showHome } = useStore();
  const collection = view === 'collection' ? snapshot?.collections.find((c) => c.id === selectedCollectionId) : undefined;
  const context = !snapshot ? null : collection ? collectionLabel(collection, snapshot.collections) : 'Collections';
  return (
    <header className="titlebar">
      <AppMenu />
      <button className="titlebar-btn" aria-label="Home: all collections" title="Home" disabled={!snapshot} onClick={showHome}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>
      </button>
      <BrandMark size={18} />
      <span className="titlebar-name">Yept</span>
      {context && <span className="titlebar-context">{context}</span>}
    </header>
  );
}

export function StatusBar(): React.JSX.Element {
  const { snapshot, view, selectedCollectionId, envs, gitChanges, gitSummary, refreshGitCount, setGitOpen, appearance, setAppearance, setAppSettingsOpen, setAboutOpen } = useStore();
  const [version, setVersion] = useState('');
  useEffect(() => {
    if (snapshot) void refreshGitCount();
  }, [snapshot, refreshGitCount]);
  useEffect(() => {
    yept.versions().then((v) => setVersion(v.app ?? '')).catch(() => undefined);
  }, []);

  const collection = view === 'collection' ? snapshot?.collections.find((c) => c.id === selectedCollectionId) : undefined;
  const sync = gitSummary ? `${gitSummary.ahead ? ` ↑${gitSummary.ahead}` : ''}${gitSummary.behind ? ` ↓${gitSummary.behind}` : ''}` : '';
  const count = snapshot?.collections.length ?? 0;
  const mode = appearance.theme;
  const next = MODES[(MODES.findIndex((m) => m.id === mode) + 1) % MODES.length];
  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? 'System';

  return (
    <footer className="app-statusbar">
      <span className="status-item status-path" title={snapshot?.root}>{snapshot ? snapshot.root : 'No folder open'}</span>
      {snapshot && (gitSummary ? (
        <button className="status-item status-btn" onClick={() => setGitOpen(true)} title="Source control: pull, Sync, branches and collection changes">
          ⎇ {gitSummary.branch ?? 'detached HEAD'}{sync} · {gitChanges ? `${gitChanges} changed` : 'no changes'}
          {gitSummary.repos > 1 && ` · ${gitSummary.repos} repositories`}
        </button>
      ) : (
        <span className="status-item">Not in a Git repository</span>
      ))}
      <span className="status-spacer" />
      {collection ? (
        <span className="status-item">Environment: {envs[collection.id]?.active ?? 'none'}</span>
      ) : snapshot ? (
        <span className="status-item">{count} collection{count === 1 ? '' : 's'}</span>
      ) : null}
      <RunnerStatus />
      <DevToolsStatus />
      <button className="status-item status-btn" onClick={() => void setAppearance({ theme: next.id })} title={`Light or dark: ${modeLabel}. Click for ${next.label}.`} aria-label={`Mode: ${modeLabel}`}>
        {mode === 'dark' ? '☾' : mode === 'light' ? '☀' : '◐'} {modeLabel}
      </button>
      <button className="status-item status-btn" onClick={() => setAppSettingsOpen(true)}>Settings</button>
      <button className="status-item status-btn" onClick={() => setAboutOpen(true)}>About</button>
      {version && <span className="status-item status-version">v{version}</span>}
    </footer>
  );
}

export function AboutDialog(): React.JSX.Element | null {
  const { aboutOpen, setAboutOpen, toast } = useStore();
  const [versions, setVersions] = useState<Record<string, string> | null>(null);
  const [notices, setNotices] = useState('');
  useEffect(() => {
    if (!aboutOpen) return;
    void Promise.all([yept.versions(), yept.notices()])
      .then(([v, n]) => { setVersions(v); setNotices(n); })
      .catch((e) => toast(errorMessage(e), 'error'));
  }, [aboutOpen, toast]);
  if (!aboutOpen) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setAboutOpen(false)}>
      <div className="dialog" role="dialog" aria-label="About Yept" style={{ width: 'min(760px, 94vw)' }} onKeyDown={(e) => e.key === 'Escape' && setAboutOpen(false)}>
        <div className="dialog-body" style={{ maxHeight: '72vh', overflow: 'auto' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 9 }}><BrandMark size={30} />About Yept</h3>
          <p>Yept {versions?.app ?? '…'} · Electron {versions?.electron ?? '…'} · Node {versions?.node ?? '…'}</p>
          <p className="mute small">Local-first API client. Licensed under MIT. No telemetry or automatic updates.</p>
          <h4 className="section-title">Third-party notices</h4>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{notices || 'Loading notices…'}</pre>
        </div>
        <div className="dialog-actions"><button className="btn" autoFocus onClick={() => setAboutOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
