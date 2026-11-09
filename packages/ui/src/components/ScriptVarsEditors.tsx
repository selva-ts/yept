import type { KeyValue, Scripts } from '@shared/model';
import { CodeEditor } from './CodeEditor';
import { KeyValueTable } from './KeyValueTable';

export function ScriptsEditor({ script, onChange, readOnly, level }: { script: Scripts; onChange: (s: Scripts) => void; readOnly?: boolean; level: 'request' | 'folder' | 'collection' }): React.JSX.Element {
  const order =
    level === 'request' ? 'Collection and folder scripts run first.' : level === 'folder' ? 'Runs for every request in this folder, after the collection script.' : 'Runs for every request in this collection, before folder and request scripts.';
  return (
    <div className="scripts-grid">
      <div className="script-pane">
        <div className="script-title">
          <b>Before the request</b> <span className="mute small">{order} Use <code>req.setHeader()</code>, <code>bru.setVar()</code>.</span>
        </div>
        <div className="monaco-host">
          <CodeEditor value={script.req} language="javascript" readOnly={readOnly} onChange={(req) => onChange({ ...script, req })} />
        </div>
      </div>
      <div className="script-pane">
        <div className="script-title">
          <b>After the response</b> <span className="mute small">Read <code>res.status</code>, <code>res.body</code>. Secret variable names are stored as local secrets.</span>
        </div>
        <div className="monaco-host">
          <CodeEditor value={script.res} language="javascript" readOnly={readOnly} onChange={(res) => onChange({ ...script, res })} />
        </div>
      </div>
    </div>
  );
}

export function VarsTable({ rows, onChange, readOnly, kind }: { rows: KeyValue[]; onChange: (rows: KeyValue[]) => void; readOnly?: boolean; kind: 'static' | 'extract' }): React.JSX.Element {
  return (
    <KeyValueTable
      rows={rows}
      readOnly={readOnly}
      onChange={onChange}
      make={(p) => ({ ...p, enabled: true })}
      namePlaceholder="variable"
      valuePlaceholder={kind === 'extract' ? 'expression, e.g. res.body.access_token' : 'value'}
    />
  );
}
