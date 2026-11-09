// {{variable}} highlighting for plain text inputs. An <input> can't colour part of its text, so a
// mirror layer draws the coloured text on top while the real input (text made transparent) keeps
// the caret, selection, IME and scrolling native.
import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { ResolvedVar } from '@shared/model';
import { VAR_RE, isBuiltinVar } from '@shared/vars';

export type VarState = 'ok' | 'secret' | 'missing' | 'builtin' | 'pending';

export interface VarLookup {
  state: (name: string) => VarState;
  /** Hover text: value (masked when secret) and where it comes from. */
  describe: (name: string) => string;
}

/** Provided by the request editor from the resolution preview; absent elsewhere (variables then show neutral). */
export const VarContext = createContext<VarLookup | null>(null);

export function makeVarLookup(vars: ResolvedVar[] | null, environment: string | null, sourceLabel: (source: string) => string): VarLookup {
  const byName = new Map((vars ?? []).map((v) => [v.name, v]));
  const state = (name: string): VarState => {
    if (isBuiltinVar(name)) return 'builtin';
    if (!vars) return 'pending';
    const v = byName.get(name);
    if (!v || v.value === '') return 'missing';
    return v.secret ? 'secret' : 'ok';
  };
  const describe = (name: string): string => {
    const s = state(name);
    if (s === 'builtin') return `{{${name}}}: generated when the request is sent`;
    if (s === 'pending') return `{{${name}}}`;
    if (s === 'missing') return `{{${name}}}: no value in ${environment ? `"${environment}"` : 'any layer (no environment selected)'}`;
    const v = byName.get(name)!;
    return `{{${name}}} = ${v.value} (${sourceLabel(v.source)})`;
  };
  return { state, describe };
}

/** Splits text into plain runs and coloured {{variable}} tokens. */
export function highlightVars(text: string, lookup: VarLookup | null): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(VAR_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(<span key={at} className={`var-tok var-${lookup?.state(m[1]) ?? 'pending'}`}>{m[0]}</span>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const MIRRORED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textIndent',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const;

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value'> & { value: string; wrapClassName?: string };

export function VarInput({ value, wrapClassName, className, title, onScroll, onSelect, onKeyUp, ...rest }: Props): React.JSX.Element {
  const lookup = useContext(VarContext);
  const input = useRef<HTMLInputElement>(null);
  const layer = useRef<HTMLSpanElement>(null);
  const sync = (): void => {
    if (layer.current && input.current) layer.current.scrollLeft = input.current.scrollLeft;
  };
  // Mirror the input's box metrics so the coloured text lands exactly over the real (transparent) text.
  useLayoutEffect(() => {
    const el = input.current;
    const mirror = layer.current;
    if (!el || !mirror) return;
    const cs = getComputedStyle(el);
    for (const k of MIRRORED) mirror.style[k] = cs[k];
    sync();
  });
  const names = [...value.matchAll(VAR_RE)].map((m) => m[1]);
  const hover = title ?? (names.length ? [...new Set(names)].map((n) => lookup?.describe(n) ?? `{{${n}}}`).join('\n') : undefined);
  return (
    <span className={`var-field ${wrapClassName ?? ''}`}>
      <input
        ref={input}
        className={`${className ?? ''} var-input`}
        value={value}
        title={hover}
        onScroll={(e) => { sync(); onScroll?.(e); }}
        onSelect={(e) => { sync(); onSelect?.(e); }}
        onKeyUp={(e) => { sync(); onKeyUp?.(e); }}
        {...rest}
      />
      <span ref={layer} className="var-layer" aria-hidden="true">
        {highlightVars(value, lookup)}
        {'​'}
      </span>
    </span>
  );
}
