import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '@shared/model';
import { useStore } from '@yept/ui/store';
import { pasteCurl } from '../actions';

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => (n.kind === 'request' ? [n] : flatten(n.children ?? [])));
}

interface Command {
  kind: 'command';
  id: string;
  label: string;
  run: () => void;
}

const isCurl = (s: string): boolean => /^curl(\.exe)?\s/i.test(s.trim());

export function CommandPalette(): React.JSX.Element | null {
  const { paletteOpen, setPalette, snapshot, openRequest } = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQ('');
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [paletteOpen]);

  const items = useMemo((): (Command | TreeNode)[] => {
    if (isCurl(q)) return [{ kind: 'command', id: 'command:curl-this', label: 'Create request from this cURL command', run: () => pasteCurl(q) }];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const commands: Command[] = words.length && words.every((w) => w.length > 1 && ['paste', 'curl', 'import'].some((k) => k.startsWith(w)))
      ? [{ kind: 'command', id: 'command:curl', label: 'Paste cURL…', run: () => pasteCurl() }]
      : [];
    const all = flatten(snapshot?.collections ?? []);
    return [...commands, ...all.filter((n) => words.every((w) => `${n.method} ${n.name} ${n.path}`.toLowerCase().includes(w))).slice(0, 50)];
  }, [snapshot, q]);

  if (!paletteOpen) return null;
  const pick = (n: Command | TreeNode | undefined): void => {
    if (!n) return;
    setPalette(false);
    if (n.kind === 'command') n.run();
    else void openRequest(n.id);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div className="dialog palette" role="dialog" aria-label="Go to request">
        <input
          ref={input}
          value={q}
          placeholder="Go to request…  (name, path or method), or paste a curl command"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onPaste={(e) => {
            // A one-line input would drop the line breaks of a multi-line command: open the dialog with all of it.
            const pasted = e.clipboardData.getData('text');
            if (!q && isCurl(pasted)) {
              e.preventDefault();
              setPalette(false);
              pasteCurl(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPalette(false);
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') pick(items[sel]);
          }}
        />
        <div className="palette-list">
          {items.map((n, i) => (
            <div key={n.id} className={`palette-item ${i === sel ? 'active' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pick(n)}>
              {n.kind === 'command' ? (
                <>
                  <span className="method-tag mute">CMD</span>
                  <span>{n.label}</span>
                </>
              ) : (
                <>
                  <span className={`method-tag m-${n.method}`}>{n.method}</span>
                  <span>{n.name}</span>
                  <span className="path">{n.path}</span>
                </>
              )}
            </div>
          ))}
          {items.length === 0 && <div className="palette-item mute">No matching requests</div>}
        </div>
      </div>
    </div>
  );
}
