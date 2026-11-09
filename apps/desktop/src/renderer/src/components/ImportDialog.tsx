// Import wizard: what was found, what will be written, conflicts, and secrets to move to local storage.
// Also used to convert a .bru collection to YAML. Nothing is sent or run during an import.
import { useEffect, useState } from 'react';
import type { ImportPreview } from '@shared/ipc';
import { errorMessage, yept } from '@yept/ui/api';
import { useStore } from '@yept/ui/store';

const FORMAT: Record<ImportPreview['format'], string> = {
  postman: 'Postman collection',
  insomnia: 'Insomnia export',
  openapi: 'OpenAPI document',
  opencollection: 'OpenCollection (bundled)',
  bru: 'Bruno .bru collection'
};

export function ImportDialog(): React.JSX.Element | null {
  const { importPreview, setImportPreview, toast, setSnapshot, openRequest, loadEnvs } = useStore();
  const p = importPreview;
  const [name, setName] = useState('');
  const [fix, setFix] = useState<Set<string>>(new Set());
  const [policy, setPolicy] = useState<'copy' | 'skip' | 'replace'>('copy');
  const [exists, setExists] = useState({ targetExists: false, existingFiles: 0 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!p) return;
    setName(p.collectionName);
    setFix(new Set(p.findings.map((f) => f.id)));
    setPolicy('copy');
    setExists({ targetExists: p.targetExists, existingFiles: p.existingFiles });
  }, [p]);
  useEffect(() => {
    if (!p || !name.trim()) return;
    const t = setTimeout(() => void yept.importer.check(p.planId, name.trim()).then(setExists).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [p, name]);

  if (!p) return null;
  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await yept.importer.apply(p.planId, name.trim(), [...fix], policy);
      setSnapshot(r.snapshot);
      setImportPreview(null);
      if (r.collectionId) void loadEnvs(r.collectionId);
      toast(
        `${p.format === 'bru' ? 'Converted' : 'Imported'} "${name.trim()}": ${r.written} file${r.written === 1 ? '' : 's'} written${r.skipped ? `, ${r.skipped} kept as they were` : ''}${r.secretsStored ? `, ${r.secretsStored} value(s) stored as local secrets` : ''}.`
      );
      if (r.note) toast(r.note, 'error');
      const first = (nodes: typeof r.snapshot.collections): string | undefined => {
        for (const n of nodes) {
          if (n.kind === 'request') return n.id;
          const c = first(n.children ?? []);
          if (c) return c;
        }
        return undefined;
      };
      const col = r.snapshot.collections.find((c) => c.id === r.collectionId);
      const id = col && first(col.children ?? []);
      if (id) void openRequest(id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && setImportPreview(null)}>
      <div className="dialog wide" role="dialog" aria-label={p.format === 'bru' ? 'Convert to YAML' : 'Import collection'}>
        <div className="dialog-body import-body">
          <h3>{p.format === 'bru' ? 'Convert to YAML' : 'Import'} · {p.source}</h3>
          <p className="mute small" style={{ marginTop: 0 }}>
            {FORMAT[p.format]} · {p.counts.requests} request{p.counts.requests === 1 ? '' : 's'}, {p.counts.folders} folder{p.counts.folders === 1 ? '' : 's'}, {p.counts.environments} environment{p.counts.environments === 1 ? '' : 's'}. Nothing is sent or
            run during an import; scripts are converted, not executed.
          </p>
          {p.issues.map((i, k) => (
            <div key={k} className="banner info" style={{ margin: '4px 0' }}>{i}</div>
          ))}
          {p.skipped.length > 0 && (
            <div className="banner warn" style={{ margin: '4px 0' }}>
              Not imported: {p.skipped.join('; ')}
            </div>
          )}

          <label className="field-row" style={{ marginTop: 10 }}>
            <span className="field-label">Collection name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Collection name" />
          </label>
          <p className="mute small mono" style={{ margin: '4px 0 0 120px' }}>{p.parentDir}</p>
          {exists.targetExists && (
            <div className="banner warn" style={{ margin: '8px 0' }}>
              <span>A folder with this name already exists ({exists.existingFiles} of the files already exist).</span>
              <span className="spacer" />
              {(['copy', 'skip', 'replace'] as const).map((k) => (
                <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input type="radio" name="import-policy" checked={policy === k} onChange={() => setPolicy(k)} />
                  {k === 'copy' ? 'Import as a copy' : k === 'skip' ? 'Keep existing files' : 'Replace existing files'}
                </label>
              ))}
            </div>
          )}

          {p.findings.length > 0 && (
            <>
              <h4 className="section-title">Credentials found ({p.findings.length})</h4>
              <p className="mute small" style={{ margin: '0 0 6px' }}>
                Ticked values are replaced by a {'{{variable}}'} marked secret in the environments, and the value is stored as a local secret on this machine, not in the files.
              </p>
              <table className="headers-list">
                <tbody>
                  {p.findings.map((f) => (
                    <tr key={f.id}>
                      <td style={{ width: 28 }}>
                        <input
                          type="checkbox"
                          checked={fix.has(f.id)}
                          onChange={(e) =>
                            setFix((s) => {
                              const n = new Set(s);
                              if (e.target.checked) n.add(f.id);
                              else n.delete(f.id);
                              return n;
                            })
                          }
                          aria-label={`Move ${f.field} of ${f.where} to a secret`}
                        />
                      </td>
                      <td>{f.where}</td>
                      <td>{f.field}</td>
                      <td className="mono small">{f.preview}</td>
                      <td className="mono small">→ {`{{${f.variable}}}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" disabled={busy} onClick={() => setImportPreview(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void apply()}>
            {busy ? <span className="spinner" /> : null} {p.format === 'bru' ? 'Convert' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
