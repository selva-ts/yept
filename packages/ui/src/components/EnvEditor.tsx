// Environment editor. Two clearly separated layers: shared values saved to the environment file
// (committed to Git), and this machine's overrides, secrets and TLS settings (never committed).
import { useEffect, useMemo, useState } from 'react';
import type { EnvironmentList } from '@shared/ipc';
import type { Environment, EnvironmentView, EnvVariable } from '@shared/model';
import { errorMessage, yept } from '../api';
import { useStore } from '../store';
import { confirm, prompt } from './Dialogs';

const toShared = (e: EnvironmentView): Environment => ({ name: e.name, variables: e.variables.map(({ name, value, secret, enabled }) => ({ name, value, secret, enabled })) });

function LocalCell({ collectionId, env, v }: { collectionId: string; env: string; v: EnvironmentView['variables'][number] }): React.JSX.Element {
  const { setEnvs, toast } = useStore();
  const [value, setValue] = useState(v.secret ? '' : (v.override ?? ''));
  const [revealed, setRevealed] = useState(false);
  useEffect(() => setValue(v.secret ? '' : (v.override ?? '')), [v.secret, v.override]);

  const run = async (fn: () => Promise<EnvironmentList>): Promise<void> => {
    try {
      setEnvs(await fn());
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (v.secret) {
    return (
      <div className="local-cell">
        <input
          className="input mono"
          type={revealed ? 'text' : 'password'}
          value={value}
          placeholder={v.hasSecret ? '•••••• stored · type to replace' : 'not set on this machine'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          onBlur={() => value && void run(() => yept.env.setSecret(collectionId, env, v.name, value)).then(() => { setValue(''); setRevealed(false); })}
          aria-label={`Secret value for ${v.name}`}
          spellCheck={false}
        />
        {v.hasSecret && (
          <>
            <button
              className="btn ghost small"
              title="Show the stored value"
              onClick={async () => {
                const s = await yept.env.revealSecret(collectionId, env, v.name);
                setValue(s ?? '');
                setRevealed(true);
              }}
            >
              Show
            </button>
            <button className="btn ghost small" title="Remove the stored value" onClick={() => void run(() => yept.env.setSecret(collectionId, env, v.name, null))}>
              Clear
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="local-cell">
      <input
        className="input mono"
        value={value}
        placeholder="use shared value"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        onBlur={() => value !== (v.override ?? '') && void run(() => yept.env.setOverride(collectionId, env, v.name, value === '' ? null : value))}
        aria-label={`Local override for ${v.name}`}
        spellCheck={false}
      />
    </div>
  );
}

export function EnvEditor(): React.JSX.Element | null {
  const { envEditor, closeEnvEditor, envs, setEnvs, toast, snapshot } = useStore();
  const list = envEditor ? envs[envEditor.collectionId] : undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Environment | null>(null);
  const collectionName = useMemo(() => snapshot?.collections.find((c) => c.id === envEditor?.collectionId)?.name ?? '', [snapshot, envEditor]);

  const current = list?.environments.find((e) => e.name === selected) ?? null;
  useEffect(() => {
    if (!list) return;
    const pick = selected && list.environments.some((e) => e.name === selected) ? selected : (envEditor?.focus ?? list.active ?? list.environments[0]?.name ?? null);
    setSelected(pick);
  }, [list, envEditor?.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(current ? toShared(current) : null), [current?.name, list]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!envEditor || !list) return null;
  const cid = envEditor.collectionId;
  const ro = list.readOnly;
  const dirty = !!(current && draft && JSON.stringify(toShared(current)) !== JSON.stringify(draft));

  const call = async (fn: () => Promise<EnvironmentList>, then?: () => void): Promise<void> => {
    try {
      setEnvs(await fn());
      then?.();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const create = async (): Promise<void> => {
    const name = await prompt('New environment', list.environments.length ? 'staging' : 'local', 'Create', 'Environment name');
    if (!name) return;
    const variables: EnvVariable[] = current ? current.variables.map((v) => ({ ...v, value: v.secret ? '' : v.value })) : [{ name: 'baseUrl', value: 'http://localhost:5000', secret: false, enabled: true }];
    await call(() => yept.env.save(cid, null, { name, variables }), () => setSelected(name));
  };
  const save = (): Promise<void> => (draft && current ? call(() => yept.env.save(cid, current.name, draft), () => setSelected(draft.name)) : Promise.resolve());
  const remove = async (): Promise<void> => {
    if (!current) return;
    if (!(await confirm(`Delete "${current.name}"?`, 'The environment file moves to the Recycle Bin, and this machine forgets its overrides and secrets for it.', 'Delete environment', true))) return;
    await call(() => yept.env.remove(cid, current.name), () => setSelected(null));
  };
  const updateVar = (i: number, patch: Partial<EnvVariable>): void => {
    if (draft) setDraft({ ...draft, variables: draft.variables.map((v, j) => (j === i ? { ...v, ...patch, ...(patch.secret ? { value: '' } : {}) } : v)) });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !dirty && closeEnvEditor()}>
      <div className="dialog wide" role="dialog" aria-label="Environments">
        <div className="dialog-body env-layout">
          <aside className="env-list">
            <h3>Environments</h3>
            <p className="mute small">{collectionName}</p>
            {list.environments.map((e) => (
              <button key={e.name} className={`env-item ${e.name === selected ? 'active' : ''}`} onClick={() => setSelected(e.name)}>
                <span>{e.name}</span>
                {e.name === list.active && <span className="badge">active</span>}
              </button>
            ))}
            {list.environments.length === 0 && <p className="mute">No environments yet.</p>}
            {!ro && (
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => void create()}>
                + New environment
              </button>
            )}
          </aside>
          <section className="env-main">
            {!current || !draft ? (
              <div className="empty">Create an environment to hold base URLs and credentials for local, dev, test or prod.</div>
            ) : (
              <>
                <div className="env-head">
                  <input className="input env-name" value={draft.name} readOnly={ro} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Environment name" />
                  <span className="mute mono small">{current.path}</span>
                  <span className="spacer" />
                  {list.active !== current.name && (
                    <button className="btn small" onClick={() => void call(() => yept.env.setActive(cid, current.name))}>
                      Use this environment
                    </button>
                  )}
                  {!ro && (
                    <button className="btn small danger-text" onClick={() => void remove()}>
                      Delete
                    </button>
                  )}
                </div>
                <table className="kv env-table">
                  <thead>
                    <tr>
                      <th />
                      <th>Variable</th>
                      <th>Shared value (in the file)</th>
                      <th title="Secret values are never written to the file">Secret</th>
                      <th>This machine only</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.variables.map((v, i) => {
                      const view = current.variables.find((x) => x.name === v.name && x.secret === v.secret);
                      return (
                        <tr key={i} className={v.enabled ? '' : 'disabled'}>
                          <td className="check">
                            <input type="checkbox" checked={v.enabled} disabled={ro} onChange={(e) => updateVar(i, { enabled: e.target.checked })} aria-label="Enabled" />
                          </td>
                          <td>
                            <input type="text" value={v.name} readOnly={ro} onChange={(e) => updateVar(i, { name: e.target.value })} spellCheck={false} aria-label="Variable name" />
                          </td>
                          <td>
                            {v.secret ? (
                              <span className="mute small">— secret, set per machine →</span>
                            ) : (
                              <input type="text" value={v.value} readOnly={ro} onChange={(e) => updateVar(i, { value: e.target.value })} spellCheck={false} aria-label={`Shared value for ${v.name}`} />
                            )}
                          </td>
                          <td className="check">
                            <input type="checkbox" checked={v.secret} disabled={ro} onChange={(e) => updateVar(i, { secret: e.target.checked })} aria-label={`Secret ${v.name}`} />
                          </td>
                          <td>{view ? <LocalCell collectionId={cid} env={current.name} v={view} /> : <span className="mute small">save first</span>}</td>
                          <td className="del">
                            {!ro && (
                              <button className="btn ghost small" title="Remove" onClick={() => setDraft({ ...draft, variables: draft.variables.filter((_, j) => j !== i) })}>
                                ×
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!ro && (
                  <button className="btn small" style={{ margin: '8px 0' }} onClick={() => setDraft({ ...draft, variables: [...draft.variables, { name: '', value: '', secret: false, enabled: true }] })}>
                    + Add variable
                  </button>
                )}

                <h4>TLS on this machine</h4>
                <label className="field-row">
                  <input type="checkbox" checked={current.tls.skipVerify} onChange={(e) => void call(() => yept.env.setTls(cid, current.name, { ...current.tls, skipVerify: e.target.checked }))} />
                  <span>Skip certificate verification (only for test servers with self-signed certificates)</span>
                </label>
                <div className="field-row">
                  <span className="field-label">Extra CA certificate</span>
                  <input className="input mono" readOnly value={current.tls.caFile} placeholder="none — the Windows certificate store is always trusted" />
                  <button
                    className="btn small"
                    onClick={async () => {
                      const f = await yept.env.pickCaFile();
                      if (f) await call(() => yept.env.setTls(cid, current.name, { ...current.tls, caFile: f }));
                    }}
                  >
                    Browse…
                  </button>
                  {current.tls.caFile && (
                    <button className="btn ghost small" onClick={() => void call(() => yept.env.setTls(cid, current.name, { ...current.tls, caFile: '' }))}>
                      Clear
                    </button>
                  )}
                </div>
                <p className="mute small">
                  Shared values are saved to <code>{current.path}</code> and committed with Git. Overrides, secrets and TLS settings stay on this machine, encrypted where secret.
                </p>
              </>
            )}
          </section>
        </div>
        <div className="dialog-actions">
          {current && (
            <button className="btn" style={{ marginRight: 'auto' }} onClick={() => void yept.env.clearRuntime(cid, current.name).then(() => toast('Runtime variables cleared for this session'))}>
              Clear runtime variables
            </button>
          )}
          {dirty && <span className="mute small">Unsaved changes to the shared file</span>}
          <button className="btn" onClick={async () => (!dirty || (await confirm('Discard changes?', 'Your changes to the shared environment file have not been saved.', 'Discard', true))) && closeEnvEditor()}>
            Close
          </button>
          {!ro && (
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              Save to file
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
