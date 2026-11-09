import { useEffect, useRef, useState } from 'react';
import type { KeyValue } from '@shared/model';
import { VarInput } from './VarInput';

interface Props<T extends KeyValue> {
  rows: T[];
  readOnly?: boolean;
  onChange: (rows: T[]) => void;
  /** Builds a new row when the user types into the empty last row. */
  make: (partial: Pick<KeyValue, 'name' | 'value'>) => T;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  /** Rows whose name can't be edited (e.g. path params come from the URL). */
  lockName?: (row: T) => boolean;
  canDelete?: (row: T) => boolean;
}

export function KeyValueTable<T extends KeyValue>({ rows, readOnly, onChange, make, namePlaceholder = 'name', valuePlaceholder = 'value', lockName, canDelete }: Props<T>): React.JSX.Element {
  const update = (i: number, patch: Partial<KeyValue>): void => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // Typing into the empty last row creates a real row; move the caret into it so typing continues there.
  const [focus, setFocus] = useState<{ row: number; field: 'name' | 'value' } | null>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (!focus) return;
    const input = tbody.current?.querySelectorAll('tr')[focus.row]?.querySelectorAll<HTMLInputElement>('input[type="text"]')[focus.field === 'name' ? 0 : 1];
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    setFocus(null);
  }, [focus]);
  const add = (field: 'name' | 'value', text: string): void => {
    onChange([...rows, make(field === 'name' ? { name: text, value: '' } : { name: '', value: text })]);
    setFocus({ row: rows.length, field });
  };
  return (
    <table className="kv">
      <thead>
        <tr>
          <th />
          <th>{namePlaceholder}</th>
          <th>{valuePlaceholder}</th>
          <th />
        </tr>
      </thead>
      <tbody ref={tbody}>
        {rows.map((r, i) => (
          <tr key={i} className={r.enabled ? '' : 'disabled'}>
            <td className="check">
              <input type="checkbox" checked={r.enabled} disabled={readOnly} onChange={(e) => update(i, { enabled: e.target.checked })} aria-label="Enabled" />
            </td>
            <td>
              <VarInput type="text" value={r.name} readOnly={readOnly || lockName?.(r)} onChange={(e) => update(i, { name: e.target.value })} spellCheck={false} aria-label={namePlaceholder} />
            </td>
            <td>
              <VarInput type="text" value={r.value} readOnly={readOnly} onChange={(e) => update(i, { value: e.target.value })} spellCheck={false} aria-label={valuePlaceholder} />
            </td>
            <td className="del">
              {!readOnly && (canDelete?.(r) ?? true) && (
                <button className="btn ghost small" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  ×
                </button>
              )}
            </td>
          </tr>
        ))}
        {!readOnly && (
          <tr className="ghost-row">
            <td className="check" />
            <td>
              <input type="text" value="" placeholder={`Add ${namePlaceholder}`} onChange={(e) => add('name', e.target.value)} spellCheck={false} />
            </td>
            <td>
              <input type="text" value="" placeholder={valuePlaceholder} onChange={(e) => add('value', e.target.value)} spellCheck={false} />
            </td>
            <td />
          </tr>
        )}
      </tbody>
    </table>
  );
}
