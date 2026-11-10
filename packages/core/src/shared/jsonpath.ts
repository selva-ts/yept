// A small, permissive JSONPath for the response filter. Supports $ (optional), .name, ['name'], [0], [-1], [*], .*,
// ..name, ..*, ..[0], unions [0,2] and ['a','b'], slices [1:5:2] and filters [?(@.price < 10 && @.tags)] with
// == != < <= > >= && || ! and @/$ paths. Never throws: a bad expression comes back as an error message.

export interface JsonPathMatch {
  /** Where the value was found, e.g. $.items[0].id */
  path: string;
  value: unknown;
}

export type JsonPathResult = { ok: true; matches: JsonPathMatch[]; capped: boolean } | { ok: false; error: string };

/** Matches beyond this are dropped (a recursive wildcard over a large body would otherwise copy it many times). */
export const JSONPATH_MAX_MATCHES = 10_000;

type Selector =
  | { kind: 'name'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; start?: number; end?: number; step?: number }
  | { kind: 'filter'; expr: Expr };

interface Segment {
  descendant: boolean;
  selectors: Selector[];
}

type Expr =
  | { kind: 'or' | 'and'; left: Expr; right: Expr }
  | { kind: 'not'; expr: Expr }
  | { kind: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>='; left: Operand; right: Operand }
  | { kind: 'exists'; operand: Operand };

type Operand = { kind: 'literal'; value: unknown } | { kind: 'path'; root: '@' | '$'; steps: (string | number)[] };

class PathError extends Error {}

const NAME_CHAR = /[^\s.[\]()'",=!<>&|?@$*:]/;

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  private fail(what: string): never {
    if (this.i >= this.s.length) throw new PathError(`${what} at the end of the expression`);
    throw new PathError(`${what} at position ${this.i + 1} ("${this.s[this.i]}")`);
  }
  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  private peek(text: string): boolean {
    return this.s.startsWith(text, this.i);
  }
  private eat(text: string): boolean {
    if (!this.peek(text)) return false;
    this.i += text.length;
    return true;
  }
  private expect(text: string): void {
    if (!this.eat(text)) this.fail(`Expected "${text}"`);
  }

  query(): Segment[] {
    this.ws();
    this.eat('$');
    // Permissive: "items[0]" means "$.items[0]".
    const segments: Segment[] = [];
    if (this.i < this.s.length && NAME_CHAR.test(this.s[this.i])) segments.push({ descendant: false, selectors: [{ kind: 'name', name: this.name() }] });
    segments.push(...this.segments(false));
    this.ws();
    if (this.i < this.s.length) this.fail('Unexpected character');
    return segments;
  }

  /** Segments after a root; inFilter stops at what can follow a path inside a filter. */
  private segments(inFilter: boolean): Segment[] {
    const out: Segment[] = [];
    for (;;) {
      if (!inFilter) this.ws();
      if (this.eat('..')) {
        if (this.eat('*')) out.push({ descendant: true, selectors: [{ kind: 'wildcard' }] });
        else if (this.peek('[')) out.push({ descendant: true, selectors: this.bracket() });
        else out.push({ descendant: true, selectors: [{ kind: 'name', name: this.name() }] });
      } else if (this.eat('.')) {
        if (this.eat('*')) out.push({ descendant: false, selectors: [{ kind: 'wildcard' }] });
        else out.push({ descendant: false, selectors: [{ kind: 'name', name: this.name() }] });
      } else if (this.peek('[')) {
        out.push({ descendant: false, selectors: this.bracket() });
      } else return out;
    }
  }

  private name(): string {
    const start = this.i;
    while (this.i < this.s.length && NAME_CHAR.test(this.s[this.i])) this.i++;
    if (this.i === start) this.fail('Expected a property name');
    return this.s.slice(start, this.i);
  }

  private bracket(): Selector[] {
    this.expect('[');
    const selectors: Selector[] = [];
    do {
      this.ws();
      selectors.push(this.selector());
      this.ws();
    } while (this.eat(','));
    this.expect(']');
    return selectors;
  }

  private selector(): Selector {
    if (this.eat('*')) return { kind: 'wildcard' };
    if (this.peek("'") || this.peek('"')) return { kind: 'name', name: this.string() };
    if (this.eat('?')) {
      this.ws();
      // "?(...)" (the classic form) and "?..." (RFC 9535) both work: parentheses are just grouping.
      return { kind: 'filter', expr: this.or() };
    }
    const first = this.peek(':') ? undefined : this.int();
    this.ws();
    if (!this.eat(':')) return { kind: 'index', index: first! };
    this.ws();
    const end = this.peek(':') || this.peek(']') || this.peek(',') ? undefined : this.int();
    this.ws();
    let step: number | undefined;
    if (this.eat(':')) {
      this.ws();
      step = this.peek(']') || this.peek(',') ? undefined : this.int();
    }
    if (step === 0) throw new PathError('A slice step cannot be 0');
    return { kind: 'slice', start: first, end, step };
  }

  private int(): number {
    const m = /^-?\d+/.exec(this.s.slice(this.i));
    if (!m) this.fail('Expected a number, a quoted name, * or a ?filter');
    this.i += m[0].length;
    return Number(m[0]);
  }

  private string(): string {
    const quote = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== quote) {
      if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) {
        const c = this.s[++this.i];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      } else out += this.s[this.i];
      this.i++;
    }
    if (this.i >= this.s.length) throw new PathError('Unclosed quote');
    this.i++;
    return out;
  }

  private or(): Expr {
    let left = this.and();
    for (;;) {
      this.ws();
      if (!this.eat('||')) return left;
      left = { kind: 'or', left, right: this.and() };
    }
  }
  private and(): Expr {
    let left = this.not();
    for (;;) {
      this.ws();
      if (!this.eat('&&')) return left;
      left = { kind: 'and', left, right: this.not() };
    }
  }
  private not(): Expr {
    this.ws();
    if (this.peek('!') && !this.peek('!=')) {
      this.i++;
      return { kind: 'not', expr: this.not() };
    }
    if (this.eat('(')) {
      const e = this.or();
      this.ws();
      this.expect(')');
      return e;
    }
    const left = this.operand();
    this.ws();
    const op = (['==', '!=', '<=', '>=', '<', '>'] as const).find((o) => this.peek(o));
    if (!op) {
      if (this.peek('=') && !this.peek('==')) this.fail('Use == to compare');
      return { kind: 'exists', operand: left };
    }
    this.i += op.length;
    this.ws();
    return { kind: 'cmp', op, left, right: this.operand() };
  }

  private operand(): Operand {
    this.ws();
    const c = this.s[this.i];
    if (c === '@' || c === '$') {
      this.i++;
      const steps: (string | number)[] = [];
      for (const seg of this.segments(true)) {
        const sel = seg.selectors[0];
        if (seg.descendant || seg.selectors.length !== 1 || (sel.kind !== 'name' && sel.kind !== 'index')) throw new PathError('Paths inside a filter can only use names and indexes');
        steps.push(sel.kind === 'name' ? sel.name : sel.index);
      }
      return { kind: 'path', root: c, steps };
    }
    if (c === "'" || c === '"') return { kind: 'literal', value: this.string() };
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.s.slice(this.i));
    if (!m) this.fail('Expected @, $, a number, a quoted string, true, false or null');
    this.i += m[0].length;
    return { kind: 'literal', value: JSON.parse(m[0]) };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const IDENT = /^[A-Za-z_$][\w$]*$/;
const childPath = (path: string, key: string | number): string => (typeof key === 'number' ? `${path}[${key}]` : IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key).replace(/^"|"$/g, "'")}]`);

const MISSING = Symbol('missing');

function resolve(op: Operand, current: unknown, root: unknown): unknown {
  if (op.kind === 'literal') return op.value;
  let v: unknown = op.root === '@' ? current : root;
  for (const step of op.steps) {
    if (Array.isArray(v)) {
      if (step === 'length') v = v.length;
      else if (typeof step === 'number') v = v[step < 0 ? v.length + step : step] ?? MISSING;
      else return MISSING;
    } else if (isObject(v) && typeof step === 'string' && Object.prototype.hasOwnProperty.call(v, step)) v = v[step];
    else if (typeof v === 'string' && step === 'length') v = v.length;
    else return MISSING;
    if (v === MISSING) return MISSING;
  }
  return v;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function test(e: Expr, current: unknown, root: unknown): boolean {
  switch (e.kind) {
    case 'or': return test(e.left, current, root) || test(e.right, current, root);
    case 'and': return test(e.left, current, root) && test(e.right, current, root);
    case 'not': return !test(e.expr, current, root);
    case 'exists': {
      const v = resolve(e.operand, current, root);
      return e.operand.kind === 'path' ? v !== MISSING : !!v;
    }
    case 'cmp': {
      const a = resolve(e.left, current, root);
      const b = resolve(e.right, current, root);
      if (e.op === '==') return a !== MISSING && b !== MISSING && equal(a, b);
      if (e.op === '!=') return !(a !== MISSING && b !== MISSING && equal(a, b));
      if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) return false;
      return e.op === '<' ? a < b : e.op === '<=' ? a <= b : e.op === '>' ? a > b : a >= b;
    }
  }
}

class Capped extends Error {}

function select(sel: Selector, node: JsonPathMatch, root: unknown, push: (m: JsonPathMatch) => void): void {
  const v = node.value;
  switch (sel.kind) {
    case 'name':
      if (isObject(v) && Object.prototype.hasOwnProperty.call(v, sel.name)) push({ path: childPath(node.path, sel.name), value: v[sel.name] });
      return;
    case 'wildcard':
      if (Array.isArray(v)) v.forEach((x, i) => push({ path: childPath(node.path, i), value: x }));
      else if (isObject(v)) for (const [k, x] of Object.entries(v)) push({ path: childPath(node.path, k), value: x });
      return;
    case 'index':
      if (Array.isArray(v)) {
        const i = sel.index < 0 ? v.length + sel.index : sel.index;
        if (i >= 0 && i < v.length) push({ path: childPath(node.path, i), value: v[i] });
      }
      return;
    case 'slice': {
      if (!Array.isArray(v)) return;
      const n = v.length;
      const step = sel.step ?? 1;
      const norm = (x: number): number => (x < 0 ? Math.max(n + x, step > 0 ? 0 : -1) : Math.min(x, step > 0 ? n : n - 1));
      if (step > 0) for (let i = norm(sel.start ?? 0), end = norm(sel.end ?? n); i < end; i += step) push({ path: childPath(node.path, i), value: v[i] });
      else for (let i = norm(sel.start ?? n - 1), end = sel.end === undefined ? -1 : norm(sel.end); i > end; i += step) push({ path: childPath(node.path, i), value: v[i] });
      return;
    }
    case 'filter':
      if (Array.isArray(v)) v.forEach((x, i) => { if (test(sel.expr, x, root)) push({ path: childPath(node.path, i), value: x }); });
      else if (isObject(v)) for (const [k, x] of Object.entries(v)) if (test(sel.expr, x, root)) push({ path: childPath(node.path, k), value: x });
  }
}

/** The node and everything under it, parents first (iterative, so deep documents don't overflow the stack). */
function descendants(start: JsonPathMatch): JsonPathMatch[] {
  const out: JsonPathMatch[] = [];
  const stack = [start];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    const v = n.value;
    const children: JsonPathMatch[] = Array.isArray(v) ? v.map((x, i) => ({ path: childPath(n.path, i), value: x })) : isObject(v) ? Object.entries(v).map(([k, x]) => ({ path: childPath(n.path, k), value: x })) : [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

/** Parses an expression without running it: null when valid, else the message. */
export function checkJsonPath(expression: string): string | null {
  try {
    new Parser(expression).query();
    return null;
  } catch (e) {
    return e instanceof PathError ? e.message : 'Invalid expression';
  }
}

export function queryJsonPath(root: unknown, expression: string, max = JSONPATH_MAX_MATCHES): JsonPathResult {
  let segments: Segment[];
  try {
    segments = new Parser(expression).query();
  } catch (e) {
    return { ok: false, error: e instanceof PathError ? e.message : 'Invalid expression' };
  }
  let nodes: JsonPathMatch[] = [{ path: '$', value: root }];
  let capped = false;
  try {
    for (const seg of segments) {
      const next: JsonPathMatch[] = [];
      const push = (m: JsonPathMatch): void => {
        if (next.length >= max) {
          capped = true;
          throw new Capped();
        }
        next.push(m);
      };
      try {
        for (const node of nodes) for (const n of seg.descendant ? descendants(node) : [node]) for (const sel of seg.selectors) select(sel, n, root, push);
      } catch (e) {
        if (!(e instanceof Capped)) throw e;
      }
      nodes = next;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The expression could not run' };
  }
  return { ok: true, matches: nodes, capped };
}

/** A variable name suggested from where a value was found: the last property name, else "value". */
export function suggestVariableName(path: string): string {
  const names = [...path.matchAll(/\.([A-Za-z_$][\w$]*)|\['((?:[^'\\]|\\.)*)'\]/g)].map((m) => m[1] ?? m[2]);
  const last = (names.at(-1) ?? '').replace(/[^\w]/g, '_').replace(/^(\d)/, '_$1');
  return last || 'value';
}

/** A value as a variable holds it: strings as they are, everything else as JSON. */
export function variableText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
