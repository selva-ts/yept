// Source control: collection changes, scoped staging/commits, fast-forward pull and Sync.
// The leak check runs before every commit; what's shown comes from Git itself.
import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { GitCommitResult, GitRepoStatus } from '@shared/ipc';
import type { GitFile, LeakFinding } from '@shared/model';
import { errorMessage, yept } from '@yept/ui/api';
import { isDirty, useStore } from '@yept/ui/store';
import { confirm, prompt } from '@yept/ui/components/Dialogs';
import { useEditorAppearance } from '@yept/ui/components/CodeEditor';

const KIND_LABEL: Record<GitFile['kind'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' };

interface LogLine {
  at: string;
  ok: boolean;
  title: string;
  output?: string;
}

export function GitPanel(): React.JSX.Element | null {
  const { gitOpen, setGitOpen, toast, snapshot, tabs, refreshGitCount } = useStore();
  const editor = useEditorAppearance();
  const [repos, setRepos] = useState<GitRepoStatus[] | null>(null);
  const [outside, setOutside] = useState<string[]>([]);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const refreshId = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<GitFile | null>(null);
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [leaks, setLeaks] = useState<LeakFinding[] | null>(null);
  const [overrideName, setOverrideName] = useState('');
  const repo = repos?.find((r) => r.root === repoRoot) ?? repos?.[0] ?? null;
  const normal = (p: string): string => { const s = p.replace(/\\/g, '/').replace(/\/$/, ''); return navigator.userAgent.includes('Windows') ? s.toLowerCase() : s; };
  const unsaved = !!repo && tabs.some((t) => isDirty(t) && repo.collectionPaths.some((p) => !p || normal(t.path).startsWith(`${normal(p)}/`)));
  const blocked = !!repo?.blockedReason || repo?.files.some((f) => f.kind === 'conflicted');

  const refresh = async (keepSelection = true): Promise<void> => {
    const id = ++refreshId.current;
    setRefreshing(true);
    try {
      const s = await yept.git.status();
      if (id !== refreshId.current) return;
      setRepos(s.repos);
      setOutside(s.collectionsOutsideGit);
      const r = s.repos.find((r) => r.root === repoRoot) ?? s.repos[0];
      setRepoRoot(r?.root ?? null);
      setFocus((f) => r?.files.find((file) => file.path === f?.path) ?? null);
      setSelected((prev) => {
        const paths = new Set(r?.files.map((f) => f.path) ?? []);
        return keepSelection ? new Set([...prev].filter((p) => paths.has(p))) : new Set(paths);
      });
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      if (id === refreshId.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!gitOpen) return;
    setLeaks(null);
    setFocus(null);
    setDiff(null);
    void refresh(false);
  }, [gitOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (gitOpen) void refresh(true);
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!gitOpen || !repo || !focus) return void setDiff(null);
    let current = true;
    setDiff(null);
    yept.git
      .diff(repo.root, focus)
      .then((d) => { if (current) setDiff(d); })
      .catch((e) => { if (current) toast(errorMessage(e), 'error'); });
    return () => { current = false; };
  }, [gitOpen, repo?.root, focus, snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => repo?.files.filter((f) => selected.has(f.path)) ?? [], [repo, selected]);
  if (!gitOpen) return null;
  const addLog = (l: Omit<LogLine, 'at'>): void => setLog((prev) => [{ ...l, at: new Date().toLocaleTimeString() }, ...prev].slice(0, 30));

  const commit = async (override?: string): Promise<void> => {
    if (!repo) return;
    setBusy('commit');
    try {
      const r: GitCommitResult = await yept.git.commit(repo.root, chosen, message, override);
      if (!r.ok && r.leaks && !r.output) {
        setLeaks(r.leaks);
        setOverrideName('');
        return;
      }
      setLeaks(null);
      if (r.ok) {
        addLog({ ok: true, title: `Committed ${chosen.length} file${chosen.length > 1 ? 's' : ''} as ${r.hash}${r.leaks ? ' (leak check overridden)' : ''}`, output: r.output });
        setMessage('');
        setFocus(null);
      } else addLog({ ok: false, title: r.explanation ?? 'Commit failed', output: r.output });
      await refresh(false);
      await refreshGitCount();
    } catch (e) {
      addLog({ ok: false, title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const push = async (setUpstream = false): Promise<void> => {
    if (!repo) return;
    setBusy('push');
    try {
      const r = await yept.git.push(repo.root, setUpstream);
      if (r.needsUpstream) {
        setBusy(null);
        if (await confirm('Set upstream?', `${r.explanation} This runs: git push -u origin ${repo.branch}`, 'Push and set upstream')) await push(true);
        return;
      }
      addLog(r.ok ? { ok: true, title: `Pushed ${repo.branch} to ${repo.upstream ?? `origin/${repo.branch}`}`, output: r.output } : { ok: false, title: r.explanation ?? 'Push failed', output: r.output });
      await refresh(true);
      await refreshGitCount();
    } catch (e) {
      addLog({ ok: false, title: errorMessage(e) });
    } finally {
      setBusy((b) => (b === 'push' ? null : b));
    }
  };

  const newBranch = async (): Promise<void> => {
    const name = await prompt('New branch', 'Branch name', 'Create and switch');
    if (name) await action('create', name.trim());
  };

  const action = async (name: 'fetch' | 'pull' | 'sync' | 'switch' | 'create' | 'stage' | 'unstage' | 'discard', branch?: string): Promise<void> => {
    if (!repo || busy) return;
    setBusy(name);
    setLeaks(null);
    try {
      if (name === 'switch' && unsaved) throw new Error('Save or close unsaved request edits in this repository before switching branches.');
      if (name === 'discard' && !await confirm('Discard selected changes?', `Restore these ${chosen.length} selected file(s) to the last commit, including staged changes? New files will move to the Recycle Bin. Unsaved editor drafts are kept and may need resolving.\n\n${chosen.map((f) => f.path).join('\n')}`, 'Discard changes', true)) return;
      const r = name === 'switch' ? await yept.git.switchBranch(repo.root, branch!) : name === 'create' ? await yept.git.createBranch(repo.root, branch!) : ['stage', 'unstage', 'discard'].includes(name)
        ? await yept.git[name as 'stage' | 'unstage' | 'discard'](repo.root, chosen)
        : await yept.git[name as 'fetch' | 'pull' | 'sync'](repo.root);
      const title = { fetch: 'Fetched upstream', pull: 'Pulled (fast-forward only)', sync: 'Sync complete', switch: `Switched to ${branch}`, create: `Created and switched to ${branch}`, stage: 'Staged selected files', unstage: 'Unstaged selected files', discard: 'Discarded selected changes' }[name];
      addLog({ ok: r.ok, title: r.ok ? title : r.explanation ?? `${name} failed`, output: r.output });
    } catch (e) {
      addLog({ ok: false, title: errorMessage(e) });
    } finally {
      await refresh(true);
      await refreshGitCount();
      setBusy(null);
    }
  };

  const allOn = !!repo && repo.files.length > 0 && selected.size === repo.files.length;
  return (
      <aside className="git-panel" aria-label="Git" aria-busy={!!busy}>
        <div className="git-head">
          <h3>Source control</h3>
          <span className="spacer" />
          <button className="btn small" onClick={() => void refresh(true)} disabled={!!busy || refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
          <button className="btn small" disabled={!!busy} onClick={() => setGitOpen(false)} aria-label="Close Git panel">×</button>
        </div>
        <div className="git-repository">
          {repos && repos.length > 1 && (
            <select className="input" disabled={!!busy} value={repo?.root ?? ''} onChange={(e) => {
              ++refreshId.current;
              setRefreshing(false);
              const r = repos.find((r) => r.root === e.target.value)!;
              setRepoRoot(r.root); setSelected(new Set(r.files.map((f) => f.path))); setFocus(null); setDiff(null); setLeaks(null); setMessage(''); setLog([]);
            }} aria-label="Repository">
              {repos.map((r) => (
                <option key={r.root} value={r.root}>
                  {r.root}
                </option>
              ))}
            </select>
          )}
          {repo && (
            <>
              <label className="git-branch-label">Branch
                <select className="input mono" aria-label="Branch" value={repo.branch ?? ''} disabled={!!busy || refreshing || blocked || repo.dirty || unsaved} onChange={(e) => void action('switch', e.target.value)}>
                  {!repo.branch && <option value="">Detached HEAD</option>}
                  {repo.branch && !repo.branches.includes(repo.branch) && <option value={repo.branch}>{repo.branch}</option>}
                  {repo.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              <div className="git-branch mono">{repo.upstream ? `→ ${repo.upstream}` : 'No upstream'} <span aria-label="Ahead and behind">↑{repo.ahead} ↓{repo.behind}</span></div>
              {(repo.dirty || unsaved) && <p className="mute small git-hint">{unsaved ? 'Save or close unsaved edits before switching branches.' : 'Branch switching requires a clean repository, including files outside collections.'}</p>}
              {blocked && <p className="bad-text small" role="alert">{repo.blockedReason ?? 'Resolve conflicts with your usual Git tool, then refresh.'}</p>}
              <div className="git-actions">
                <button className="btn small" disabled={!!busy || refreshing || blocked || repo.dirty} onClick={() => void newBranch()} title={repo.dirty ? 'Needs a clean repository' : 'Create a branch from the current commit and switch to it'}>New branch…</button>
                <button className="btn small" disabled={!!busy || blocked || !repo.upstream} onClick={() => void action('fetch')}>Fetch</button>
                <button className="btn small" disabled={!!busy || blocked || !repo.upstream || !repo.branch} onClick={() => void action('pull')}>Pull</button>
                <button className="btn small primary" disabled={!!busy || blocked || !repo.upstream || !repo.branch} onClick={() => void action('sync')} title="Fetch, pull fast-forward only, then push">{busy === 'sync' && <span className="spinner" />}Sync ↑{repo.ahead} ↓{repo.behind}</button>
              </div>
              {!repo.upstream && <p className="mute small git-hint">Use Push to set an upstream before Pull or Sync.</p>}
              {busy && <div className="mute small" role="status">Git: {busy}…</div>}
            </>
          )}
        </div>
        {repo && <div className="mute small git-root mono">{repo.root}{repo.remoteUrl ? ` · ${repo.remoteUrl}` : ''}</div>}

        {repos === null ? (
          <div className="empty"><span className="spinner" /></div>
        ) : !repo ? (
          <div className="empty">
            {outside.length === 0 ? (
              <div>
                <p><b>No collections in this folder yet.</b></p>
                <p className="mute">Create or import a collection. If this folder is a Git repository, its changes appear here.</p>
              </div>
            ) : (
              <div>
                <p><b>These collections aren't in a Git repository.</b></p>
                <p className="mute">Clone the team repository with your usual Git tool and open that folder in Yept.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="git-body">
            <aside className="git-files">
              <div className="git-file-list">
              <label className="git-file all">
                <input type="checkbox" checked={allOn} disabled={!!busy || !repo.files.length} onChange={(e) => setSelected(e.target.checked ? new Set(repo.files.map((f) => f.path)) : new Set())} />
                <b>{repo.files.length ? `${repo.files.length} changed file${repo.files.length > 1 ? 's' : ''}` : 'No changes in the collections'}</b>
              </label>
              {repo.files.map((f) => (
                <div key={f.path} className={`git-file ${focus?.path === f.path ? 'active' : ''}`} onClick={() => setFocus(f)}>
                  <input
                    type="checkbox"
                    disabled={!!busy}
                    checked={selected.has(f.path)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(f.path);
                        else n.delete(f.path);
                        return n;
                      })
                    }
                    aria-label={`Include ${f.path}`}
                  />
                  <span className={`git-kind k-${f.kind}`} title={f.kind}>{KIND_LABEL[f.kind]}</span>
                  <span className="git-path" title={f.from ? `${f.from} → ${f.path}` : f.path}>{f.path}</span>
                  <span className="git-index small" title={`Index / working tree: ${f.code}`}>{f.staged ? (f.code[1] !== '.' ? 'staged + edits' : 'staged') : ''}</span>
                </div>
              ))}
              {outside.length > 0 && <p className="mute small" style={{ padding: '8px 10px' }}>Not in Git: {outside.join(', ')}</p>}
              </div>
              <div className="git-commit">
                <div className="git-actions">
                  <button className="btn small" disabled={!!busy || blocked || !chosen.some((f) => !f.staged || f.code[1] !== '.')} onClick={() => void action('stage')}>Stage selected</button>
                  <button className="btn small" disabled={!!busy || blocked || !chosen.some((f) => f.staged)} onClick={() => void action('unstage')}>Unstage selected</button>
                  <button className="btn small danger-text" disabled={!!busy || blocked || !chosen.length} onClick={() => void action('discard')}>Discard selected</button>
                </div>
                <textarea className="input" disabled={!!busy} rows={2} placeholder="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" />
                <div className="git-actions">
                  <button className="btn primary" disabled={!chosen.length || !message.trim() || !!busy || blocked} onClick={() => void commit()}>
                    {busy === 'commit' ? <span className="spinner" /> : null} Commit {chosen.length ? `${chosen.length} file${chosen.length > 1 ? 's' : ''}` : ''}
                  </button>
                  <button className="btn" disabled={!!busy || blocked || !repo.branch} onClick={() => void push()} title={repo.upstream ? `git push to ${repo.upstream}` : 'Push this branch'}>
                    {busy === 'push' ? <span className="spinner" /> : null} Push{repo.ahead ? ` (${repo.ahead})` : ''}
                  </button>
                </div>
                <p className="mute small" style={{ margin: 0 }}>Only the ticked files are committed; anything else you've staged stays staged. Yept never force-pushes.</p>
              </div>
            </aside>
              {(leaks || focus || log.length > 0) && <section className="git-main">
              {leaks ? (
                <div className="pane leak-pane">
                  <div className="error-card" style={{ margin: 0 }}>
                    <h3>Commit blocked: this looks like a secret</h3>
                    <p style={{ margin: '4px 0 8px' }}>Shared files go to everyone with access to the repository, and Git keeps them forever. Replace these with {'{{variables}}'} stored as local secrets.</p>
                    <table className="headers-list">
                      <tbody>
                        {leaks.map((l, i) => (
                          <tr key={i}>
                            <td className="mono" style={{ whiteSpace: 'nowrap', width: '1%' }} title={l.path}>{l.path.split('/').pop()}:{l.line}</td>
                            <td>
                              <div>{l.reason}</div>
                              <div className="mono small mute">{l.excerpt}</div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="leak-actions">
                    <button className="btn primary" onClick={() => setLeaks(null)}>Fix it first</button>
                    <span className="mute small">To commit anyway, type <b className="mono">{leaks[0].path.split('/').pop()}</b>:</span>
                    <input className="input mono" value={overrideName} onChange={(e) => setOverrideName(e.target.value)} aria-label="Type the file name to commit anyway" />
                    <button className="btn danger-text" disabled={overrideName !== leaks[0].path.split('/').pop() || !!busy} onClick={() => void commit(overrideName)}>
                      Commit anyway
                    </button>
                  </div>
                </div>
              ) : focus && diff ? (
                <div className="git-diff">
                  <div className="mono small git-diff-title">{focus.from ? `${focus.from} → ${focus.path}` : focus.path} <span className="mute">· last commit ↔ this file now</span></div>
                  <div className="monaco-host">
                    <DiffEditor original={diff.before} modified={diff.after} language="yaml" theme={editor.theme}
                      originalModelPath={`yept-git://diff/${encodeURIComponent(repo.root)}/before.yml`} modifiedModelPath={`yept-git://diff/${encodeURIComponent(repo.root)}/after.yml`}
                      keepCurrentOriginalModel keepCurrentModifiedModel
                      options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, fontFamily: editor.fontFamily, fontSize: editor.fontSize, automaticLayout: true, originalEditable: false, scrollBeyondLastLine: false }} />
                  </div>
                </div>
              ) : (
                <div className="empty">{repo.files.length ? 'Select a file to see what changed.' : 'Nothing to commit. Push sends commits you made earlier.'}</div>
              )}
              {log.length > 0 && (
                <div className="git-log" aria-label="Git output">
                  {log.map((l, i) => (
                    <div key={i} className={l.ok ? 'ok' : 'bad'}>
                      <span className="mute">{l.at}</span> <b>{l.title}</b>
                      {l.output && <pre>{l.output}</pre>}
                    </div>
                  ))}
                </div>
              )}
              </section>}
          </div>
        )}
      </aside>
  );
}
