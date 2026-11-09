// Collection and folder defaults: auth, headers, variables and scripts inherited by the requests inside.
import { useEffect, useState } from 'react';
import type { SettingsDoc } from '@shared/model';
import { errorMessage, yept } from '../api';
import { useStore } from '../store';
import { AuthEditor } from './AuthEditor';
import { confirm } from './Dialogs';
import { KeyValueTable } from './KeyValueTable';
import { CodeEditor } from './CodeEditor';
import { ScriptsEditor, VarsTable } from './ScriptVarsEditors';

type Section = 'auth' | 'headers' | 'vars' | 'scripts' | 'tests' | 'docs';

export function SettingsEditor(): React.JSX.Element | null {
  const { settingsEditor, closeSettings, toast, setSnapshot, bumpVars } = useStore();
  const [loaded, setLoaded] = useState<{ collectionId: string; doc: SettingsDoc; readOnly: boolean } | null>(null);
  const [draft, setDraft] = useState<SettingsDoc | null>(null);
  const [section, setSection] = useState<Section>('auth');
  const id = settingsEditor?.id;
  const isCollection = id?.startsWith('collection:') ?? false;

  useEffect(() => {
    setLoaded(null);
    setDraft(null);
    setSection('auth');
    if (!id) return;
    yept.settings
      .get(id)
      .then((r) => {
        setLoaded(r);
        setDraft(structuredClone(r.doc));
      })
      .catch((e) => toast(errorMessage(e), 'error'));
  }, [id, toast]);

  if (!settingsEditor || !loaded || !draft) return null;
  const ro = loaded.readOnly;
  const dirty = JSON.stringify(loaded.doc) !== JSON.stringify(draft);
  const close = async (): Promise<void> => {
    if (dirty && !(await confirm('Discard changes?', 'Your changes to these settings have not been saved.', 'Discard', true))) return;
    closeSettings();
  };
  const save = async (): Promise<void> => {
    try {
      const r = await yept.settings.save(settingsEditor.id, draft);
      setSnapshot(r.snapshot);
      setLoaded({ ...loaded, doc: structuredClone(draft) });
      bumpVars();
      toast('Settings saved');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const count = (n: number): string => (n ? ` ${n}` : '');
  const sections: [Section, string][] = [
    ['auth', 'Auth'],
    ['headers', `Headers${count(draft.headers.filter((h) => h.enabled).length)}`],
    ['vars', `Variables${count(draft.vars.filter((v) => v.enabled).length)}`],
    ['scripts', 'Scripts'],
    ['tests', draft.tests.trim() ? 'Tests ●' : 'Tests'],
    ['docs', 'Docs']
  ];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && void close()}>
      <div className="dialog wide tall" role="dialog" aria-label={`${isCollection ? 'Collection' : 'Folder'} settings`}>
        <div className="dialog-body" style={{ paddingBottom: 0 }}>
          <h3>
            {isCollection ? 'Collection' : 'Folder'} settings · {draft.name}
            {ro && <span className="mute small"> (read-only .bru collection)</span>}
          </h3>
          <p className="mute small" style={{ margin: '0 0 6px' }}>
            Requests inside inherit these. A request set to “Inherit” auth uses the nearest folder's auth, then the collection's.
          </p>
        </div>
        <div className="subtabs" role="tablist">
          {sections.map(([s, label]) => (
            <button key={s} role="tab" className={`subtab ${section === s ? 'active' : ''}`} onClick={() => setSection(s)}>
              {label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {section === 'auth' && (
            <div className="pane">
              <AuthEditor auth={draft.auth} onChange={(auth) => setDraft({ ...draft, auth })} readOnly={ro} allowInherit={!isCollection} collectionId={loaded.collectionId} inheritedLabel="the auth of the parent folder or collection" />
            </div>
          )}
          {section === 'headers' && (
            <div className="pane">
              <KeyValueTable rows={draft.headers} readOnly={ro} onChange={(headers) => setDraft({ ...draft, headers })} make={(p) => ({ ...p, enabled: true })} namePlaceholder="header" />
            </div>
          )}
          {section === 'vars' && (
            <div className="pane">
              <VarsTable rows={draft.vars} readOnly={ro} onChange={(vars) => setDraft({ ...draft, vars })} kind="static" />
              <p className="mute small">
                {isCollection ? 'Collection variables are the lowest layer: environments override them.' : 'Folder variables override the environment for requests in this folder.'} Don't put secrets here: these values are saved in the shared file.
              </p>
            </div>
          )}
          {section === 'scripts' && (
            <div className="pane flush">
              <ScriptsEditor script={draft.script} onChange={(script) => setDraft({ ...draft, script })} readOnly={ro} level={isCollection ? 'collection' : 'folder'} />
            </div>
          )}
          {section === 'tests' && (
            <div className="pane flush">
              <div className="script-title">
                <span className="mute small">Runs after every request in this {isCollection ? 'collection' : 'folder'}, before the request's own tests.</span>
              </div>
              <div className="monaco-host">
                <CodeEditor value={draft.tests} language="javascript" readOnly={ro} onChange={(tests) => setDraft({ ...draft, tests })} />
              </div>
            </div>
          )}
          {section === 'docs' && (
            <div className="pane flush">
              <textarea className="input docs-area" value={draft.docs} readOnly={ro} onChange={(e) => setDraft({ ...draft, docs: e.target.value })} placeholder="Notes for teammates (Markdown, saved in the file)." />
            </div>
          )}
        </div>
        <div className="dialog-actions">
          {dirty && <span className="mute small">Unsaved changes</span>}
          <button className="btn" onClick={() => void close()}>
            Close
          </button>
          {!ro && (
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
