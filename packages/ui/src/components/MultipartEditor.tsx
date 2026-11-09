// Body tab, Multipart: text and file fields. Files inside the collection folder are saved in the request file,
// relative to it; files anywhere else are kept on this computer only, so no machine path reaches Git.
import type { MultipartField } from '@shared/model';
import { fileNameOf, pathLocation } from '@shared/multipart';
import { errorMessage, yept } from '../api';
import { useStore } from '../store';
import { VarInput } from './VarInput';

interface Props {
  requestId: string;
  fields: MultipartField[];
  readOnly: boolean;
  onChange: (fields: MultipartField[]) => void;
}

const newField = (type: MultipartField['type']): MultipartField => ({ name: '', type, value: '', files: [], localFiles: [], contentType: '', enabled: true });

const LOCATION_NOTE: Record<string, string | undefined> = {
  outside: 'Outside the collection folder: teammates need the same folder layout.',
  absolute: 'Absolute path in the shared request file: it only works on computers with the same path.'
};

export function MultipartEditor({ requestId, fields, readOnly, onChange }: Props): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const update = (i: number, patch: Partial<MultipartField>): void => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const choose = async (i: number): Promise<void> => {
    try {
      const picked = await yept.requests.pickFiles(requestId);
      if (!picked) return;
      const f = fields[i];
      update(i, { files: [...f.files, ...picked.files], localFiles: [...f.localFiles, ...picked.localFiles] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="multipart">
      <table className="kv">
        <thead>
          <tr>
            <th />
            <th>field</th>
            <th>type</th>
            <th>value</th>
            <th>content type</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i} className={f.enabled ? '' : 'disabled'}>
              <td className="check">
                <input type="checkbox" checked={f.enabled} disabled={readOnly} onChange={(e) => update(i, { enabled: e.target.checked })} aria-label="Enabled" />
              </td>
              <td className="mp-name">
                <VarInput type="text" value={f.name} readOnly={readOnly} onChange={(e) => update(i, { name: e.target.value })} spellCheck={false} aria-label="Field name" placeholder="name" />
              </td>
              <td className="mp-type">
                <select value={f.type} disabled={readOnly} aria-label="Field type" onChange={(e) => update(i, { type: e.target.value as MultipartField['type'] })}>
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
              </td>
              <td>
                {f.type === 'text' ? (
                  <VarInput type="text" value={f.value} readOnly={readOnly} onChange={(e) => update(i, { value: e.target.value })} spellCheck={false} aria-label="Field value" placeholder="value" />
                ) : (
                  <FileList field={f} readOnly={readOnly} onChange={(patch) => update(i, patch)} onChoose={() => void choose(i)} />
                )}
              </td>
              <td className="mp-ct">
                <VarInput type="text" value={f.contentType} readOnly={readOnly} onChange={(e) => update(i, { contentType: e.target.value })} spellCheck={false} aria-label="Content type" placeholder={f.type === 'file' ? 'from file name' : 'none'} />
              </td>
              <td className="del">
                {!readOnly && (
                  <button className="btn ghost small" title="Remove field" onClick={() => onChange(fields.filter((_, j) => j !== i))}>
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div className="mp-add">
          <button className="btn small" onClick={() => onChange([...fields, newField('text')])}>+ Text field</button>
          <button className="btn small" onClick={() => onChange([...fields, newField('file')])}>+ File field</button>
        </div>
      )}
      <p className="mute small">
        Files inside the collection folder are saved in the request file, relative to it, so teammates get them through Git. Files anywhere else are kept on this computer only: teammates choose their own. File
        contents are never stored in history. Yept sets the multipart Content-Type header and its boundary.
      </p>
    </div>
  );
}

function FileList({ field, readOnly, onChange, onChoose }: { field: MultipartField; readOnly: boolean; onChange: (patch: Partial<MultipartField>) => void; onChoose: () => void }): React.JSX.Element {
  const none = field.files.length === 0 && field.localFiles.length === 0;
  return (
    <div className="mp-files">
      {field.files.map((p, j) => {
        const where = pathLocation(p);
        return (
          <div key={`s${j}`} className="mp-file">
            <VarInput
              type="text"
              value={p}
              readOnly={readOnly}
              onChange={(e) => onChange({ files: field.files.map((x, k) => (k === j ? e.target.value : x)) })}
              spellCheck={false}
              aria-label="File path"
              title={where === 'collection' ? 'Saved in the request file, relative to the collection folder' : LOCATION_NOTE[where]}
            />
            {where === 'absolute' && !readOnly && (
              <button className="btn ghost small" title="Remove the path from the shared request file and keep it on this computer only" onClick={() => onChange({ files: field.files.filter((_, k) => k !== j), localFiles: [...field.localFiles, p] })}>
                Keep on this computer only
              </button>
            )}
            {!readOnly && <button className="btn ghost small" title="Remove file" aria-label="Remove file" onClick={() => onChange({ files: field.files.filter((_, k) => k !== j) })}>×</button>}
            {LOCATION_NOTE[where] && <div className="warn-text small">{LOCATION_NOTE[where]}</div>}
          </div>
        );
      })}
      {field.localFiles.map((p, j) => (
        <div key={`l${j}`} className="mp-file local" title={`${p}\nOutside the collection: kept on this computer, not in the request file. Teammates choose their own file.`}>
          <span className="mono">{fileNameOf(p)}</span>
          <span className="badge mute mp-local">this computer only</span>
          {!readOnly && <button className="btn ghost small" title="Remove file" aria-label="Remove file" onClick={() => onChange({ localFiles: field.localFiles.filter((_, k) => k !== j) })}>×</button>}
        </div>
      ))}
      {none && <span className="warn-text small">No file chosen on this computer</span>}
      {!readOnly && (
        <span className="mp-file-actions">
          <button className="btn small" onClick={onChoose}>Choose files…</button>
          <button className="btn ghost small" title="Type a path relative to the collection folder; {{variables}} work" onClick={() => onChange({ files: [...field.files, ''] })}>Type a path</button>
        </span>
      )}
    </div>
  );
}
