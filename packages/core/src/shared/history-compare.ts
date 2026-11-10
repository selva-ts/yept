// Two stored runs of one request side by side. Only what history keeps is used: it was redacted before it was stored,
// so secrets show as «secret:name» and sensitive headers as «redacted».
import type { HistoryEntry } from './model';

export interface CompareRow {
  label: string;
  left: string;
  right: string;
  changed: boolean;
}

export interface HeaderChange {
  name: string;
  change: 'added' | 'removed' | 'changed';
}

export interface ComparedBody {
  /** Text for the diff editor; empty when there is nothing to compare. */
  text: string;
  /** Why the body isn't compared as text, if it isn't. */
  note?: string;
}

export interface HistoryComparison {
  rows: CompareRow[];
  headers: { left: string; right: string; changes: HeaderChange[] };
  body: { left: ComparedBody; right: ComparedBody; language: 'json' | 'plaintext'; changed: boolean };
}

const statusText = (e: HistoryEntry): string => (e.result.outcome === 'http' ? `${e.result.status ?? ''} ${e.result.statusText ?? ''}`.trim() : e.result.outcome);
const tests = (e: HistoryEntry): string => (e.summary.testsState === 'ran' ? `${e.summary.passed} passed, ${e.summary.failed} failed, ${e.summary.errors} errors` : e.summary.testsState === 'none' ? 'none' : 'not run');

/** Headers one per line, sorted by name (case-insensitive) so a change of order isn't reported as a difference. */
function headerLines(headers: [string, string][]): string {
  return [...headers]
    .map(([k, v], i) => ({ k, v, i }))
    .sort((a, b) => a.k.toLowerCase().localeCompare(b.k.toLowerCase()) || a.i - b.i)
    .map(({ k, v }) => `${k}: ${v}`)
    .join('\n');
}

function headerChanges(left: [string, string][], right: [string, string][]): HeaderChange[] {
  const group = (h: [string, string][]): Map<string, { name: string; values: string[] }> => {
    const m = new Map<string, { name: string; values: string[] }>();
    for (const [k, v] of h) {
      const g = m.get(k.toLowerCase()) ?? { name: k, values: [] };
      g.values.push(v);
      m.set(k.toLowerCase(), g);
    }
    return m;
  };
  const a = group(left);
  const b = group(right);
  const out: HeaderChange[] = [];
  for (const [key, g] of a) {
    const other = b.get(key);
    if (!other) out.push({ name: g.name, change: 'removed' });
    else if (g.values.join('\n') !== other.values.join('\n')) out.push({ name: g.name, change: 'changed' });
  }
  for (const [key, g] of b) if (!a.has(key)) out.push({ name: g.name, change: 'added' });
  return out;
}

function bodyOf(e: HistoryEntry, json: boolean): ComparedBody {
  if (e.summary.bodyOmitted) return { text: '', note: 'Body not kept in history' };
  if (e.result.body.binary) return { text: '', note: `Binary body (${e.result.sizeBytes} bytes), not compared as text` };
  const text = e.result.body.text;
  const cut = e.result.body.truncated || e.result.body.preview ? 'Only the start of this body was kept, so only that part is compared' : undefined;
  if (json && !cut) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      // Not JSON after all: compared as it is.
    }
  }
  return { text, note: cut };
}

/** Builds the comparison; `left` is usually the older run. */
export function compareHistory(left: HistoryEntry, right: HistoryEntry): HistoryComparison {
  const row = (label: string, a: string, b: string): CompareRow => ({ label, left: a, right: b, changed: a !== b });
  const rows = [
    row('Status', statusText(left), statusText(right)),
    row('Time', `${left.result.durationMs} ms`, `${right.result.durationMs} ms`),
    row('Size', `${left.result.sizeBytes} bytes`, `${right.result.sizeBytes} bytes`),
    row('Environment', left.result.environment || 'none', right.result.environment || 'none'),
    row('URL', `${left.result.request.method} ${left.result.request.url}`, `${right.result.request.method} ${right.result.request.url}`),
    row('Tests', tests(left), tests(right))
  ];
  const isJson = (e: HistoryEntry): boolean => /json/i.test(e.result.body.contentType);
  const json = isJson(left) && isJson(right);
  const lb = bodyOf(left, json);
  const rb = bodyOf(right, json);
  return {
    rows,
    headers: { left: headerLines(left.result.headers), right: headerLines(right.result.headers), changes: headerChanges(left.result.headers, right.result.headers) },
    body: { left: lb, right: rb, language: json ? 'json' : 'plaintext', changed: lb.text !== rb.text || lb.note !== rb.note }
  };
}
