import { expect, it } from 'vitest';
import { compareHistory } from './history-compare';
import type { HistoryEntry, RunResult } from './model';

function entry(over: { status?: number; durationMs?: number; headers?: [string, string][]; text?: string; contentType?: string; binary?: boolean; truncated?: boolean; omitted?: boolean }): HistoryEntry {
  const result = {
    runId: 'r', outcome: 'http', status: over.status ?? 200, statusText: 'OK', durationMs: over.durationMs ?? 12, sizeBytes: (over.text ?? '').length,
    headers: over.headers ?? [], body: { text: over.text ?? '', contentType: over.contentType ?? 'application/json', truncated: !!over.truncated, binary: !!over.binary },
    request: { method: 'GET', url: 'http://127.0.0.1:4010/changing', headers: [] }, timeline: [], environment: 'local',
    scriptErrors: [], extractions: [], console: [], tests: [], testsState: 'none'
  } as RunResult;
  return {
    result,
    doc: {} as HistoryEntry['doc'],
    summary: { runId: 'r', requestId: 'q', startedAt: '2026-01-01T00:00:00Z', environment: 'local', method: 'GET', url: result.request.url, outcome: 'http', status: result.status, durationMs: result.durationMs, sizeBytes: result.sizeBytes, passed: 0, failed: 0, errors: 0, testsState: 'none', bodyTruncated: !!over.truncated, bodyOmitted: !!over.omitted, requestName: 'Changing', requestPath: 'Changing.yml' }
  };
}

it('marks the rows that differ', () => {
  const c = compareHistory(entry({ status: 200, durationMs: 10 }), entry({ status: 404, durationMs: 10 }));
  expect(c.rows.find((r) => r.label === 'Status')).toMatchObject({ left: '200 OK', right: '404 OK', changed: true });
  expect(c.rows.find((r) => r.label === 'Time')!.changed).toBe(false);
});

it('lists added, removed and changed headers, ignoring order and case of names', () => {
  const left = entry({ headers: [['X-Run', '1'], ['Content-Type', 'application/json'], ['X-Old', 'a']] });
  const right = entry({ headers: [['content-type', 'application/json'], ['x-run', '2'], ['X-New', 'b']] });
  const c = compareHistory(left, right);
  expect(c.headers.changes).toEqual([{ name: 'X-Run', change: 'changed' }, { name: 'X-Old', change: 'removed' }, { name: 'X-New', change: 'added' }]);
  expect(c.headers.left).toBe('Content-Type: application/json\nX-Old: a\nX-Run: 1');
  expect(compareHistory(left, left).headers.changes).toEqual([]);
});

it('formats JSON bodies so a change of spacing is not a difference', () => {
  const c = compareHistory(entry({ text: '{"a":1,"b":[1,2]}' }), entry({ text: '{ "a": 1, "b": [1, 2] }' }));
  expect(c.body.language).toBe('json');
  expect(c.body.changed).toBe(false);
  expect(c.body.left.text).toContain('\n  "a": 1');
});

it('says why a body is not compared as text', () => {
  expect(compareHistory(entry({ binary: true }), entry({ text: 'x', contentType: 'text/plain' })).body.left.note).toMatch(/Binary body/);
  expect(compareHistory(entry({ omitted: true }), entry({})).body.left.note).toBe('Body not kept in history');
  expect(compareHistory(entry({ text: '{"a":', truncated: true }), entry({})).body.left).toEqual({ text: '{"a":', note: expect.stringContaining('Only the start') });
});

it('compares only what history stored: redacted values stay redacted', () => {
  const left = entry({ headers: [['Set-Cookie', '«redacted»']], text: '{"token":"«secret:accessToken»"}' });
  const right = entry({ headers: [['Set-Cookie', '«redacted»']], text: '{"token":"«secret:accessToken»","n":2}' });
  const c = compareHistory(left, right);
  const all = JSON.stringify(c);
  expect(all).toContain('«secret:accessToken»');
  expect(all).toContain('«redacted»');
  expect(c.headers.changes).toEqual([]);
});
