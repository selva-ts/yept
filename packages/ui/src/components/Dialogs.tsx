// Promise-based prompt/confirm dialogs (window.prompt is unavailable in a sandboxed renderer).
import { useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

type Dialog =
  | { kind: 'prompt'; title: string; label?: string; initial: string; confirm: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; resolve: (ok: boolean) => void }
  | { kind: 'choose'; title: string; message: string; options: string[]; resolve: (index: number | null) => void };

const useDialog = create<{ dialog: Dialog | null; set: (d: Dialog | null) => void }>((set) => ({ dialog: null, set: (dialog) => set({ dialog }) }));

export function prompt(title: string, initial = '', confirm = 'OK', label?: string): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().set({ kind: 'prompt', title, initial, confirm, label, resolve }));
}

export function confirm(title: string, message: string, confirmLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => useDialog.getState().set({ kind: 'confirm', title, message, confirm: confirmLabel, danger, resolve }));
}

/** Several choices plus Cancel. Resolves the chosen index, or null when cancelled. */
export function choose(title: string, message: string, options: string[]): Promise<number | null> {
  return new Promise((resolve) => useDialog.getState().set({ kind: 'choose', title, message, options, resolve }));
}

export function DialogHost(): React.JSX.Element | null {
  const { dialog, set } = useDialog();
  const [value, setValue] = useState('');
  const [shownFor, setShownFor] = useState<typeof dialog>(null);
  const input = useRef<HTMLInputElement>(null);

  // Take the prompt's initial text in the same render that opens it, and select it before the first paint;
  // otherwise text typed straight away lands in an empty field and is then joined to the initial value.
  if (dialog !== shownFor) {
    setShownFor(dialog);
    if (dialog?.kind === 'prompt') setValue(dialog.initial);
  }
  useLayoutEffect(() => {
    if (dialog?.kind === 'prompt') {
      input.current?.focus();
      input.current?.select();
    }
  }, [dialog]);

  if (!dialog) return null;
  const close = (result: string | null | boolean | number): void => {
    set(null);
    if (dialog.kind === 'prompt') dialog.resolve(result as string | null);
    else if (dialog.kind === 'choose') dialog.resolve(typeof result === 'number' ? result : null);
    else dialog.resolve(result as boolean);
  };
  const submit = (): void => {
    if (dialog.kind === 'prompt') {
      if (value.trim()) close(value.trim());
    } else if (dialog.kind === 'choose') close(0);
    else close(true);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close(dialog.kind === 'prompt' ? null : false)}>
      <div
        className="dialog"
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close(dialog.kind === 'prompt' ? null : false);
          if (e.key === 'Enter') submit();
        }}
      >
        <div className="dialog-body">
          <h3>{dialog.title}</h3>
          {dialog.kind === 'prompt' ? (
            <input ref={input} className="input" style={{ width: '100%' }} value={value} onChange={(e) => setValue(e.target.value)} aria-label={dialog.label ?? dialog.title} />
          ) : (
            <p style={{ margin: 0 }}>{dialog.message}</p>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => close(dialog.kind === 'prompt' ? null : false)}>
            Cancel
          </button>
          {dialog.kind === 'choose' ? (
            dialog.options.map((o, i) => (
              <button key={o} className={`btn ${i === 0 ? 'primary' : ''}`} onClick={() => close(i)} autoFocus={i === 0}>
                {o}
              </button>
            ))
          ) : (
          <button
            className="btn primary"
            style={dialog.kind === 'confirm' && dialog.danger ? { background: 'var(--bad)', borderColor: 'var(--bad)' } : undefined}
            onClick={submit}
            autoFocus={dialog.kind === 'confirm'}
          >
            {dialog.confirm}
          </button>
          )}
        </div>
      </div>
    </div>
  );
}
