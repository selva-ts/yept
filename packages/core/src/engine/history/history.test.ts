import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, type AppSettings, type RequestDoc, type RunResult } from '../../shared/model';
import { HistoryStore, type HistoryInput } from './store';

let dir: string;
let settings: AppSettings;
let store: HistoryStore;
const open = (): HistoryStore => new HistoryStore(join(dir, 'history.db'), () => settings);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yept-hist-'));
  settings = { ...DEFAULT_APP_SETTINGS };
  store = open();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Assembled at runtime so secret scanners don't flag this synthetic value.
const TOKEN = ['tok', '9f8e7d6c5b4a'].join('-');
const PASSWORD = 'hunter2-password';

const result = (over: Partial<RunResult> = {}): RunResult => ({
  runId: 'r', outcome: 'http', status: 200, statusText: 'OK', durationMs: 12, sizeBytes: 40,
  headers: [['content-type', 'application/json'], ['set-cookie', 'session=abc123456']],
  body: { text: '', contentType: 'application/json', truncated: false, binary: false },
  request: { method: 'POST', url: `https://api.example.test/login?key=${TOKEN}`, headers: [['Authorization', 'Bearer x'], ['X-Pw', PASSWORD]] },
  requestBody: `{"password":"${PASSWORD}"}`,
  timeline: [{ atMs: 0, label: 'Request sent', detail: `POST https://api.example.test/login?key=${TOKEN}` }],
  environment: 'dev', scriptErrors: [], extractions: [{ variable: 'accessToken', expression: 'res.body.token', ok: true, target: 'secret' }],
  console: [{ stage: 'post-response', level: 'log', text: `got ${TOKEN}` }],
  tests: [{ name: 'status', kind: 'test', status: 'passed', source: 'request' }, { name: 'shape', kind: 'test', status: 'failed', message: 'nope', source: 'request' }],
  testsState: 'ran',
  ...over
});
const doc = { name: 'Login', method: 'POST', url: '{{baseUrl}}/login', body: { json: `{"password":"${PASSWORD}"}` } } as unknown as RequestDoc;
let seq = 0;
const input = (over: Partial<HistoryInput> = {}): HistoryInput => ({
  runId: `run-${++seq}`,
  requestId: 'req-1',
  collectionDir: 'C:/repo/api',
  requestName: 'Login',
  requestPath: 'api/Login.yml',
  startedAt: new Date(Date.UTC(2026, 9, 21, 10, 0, seq)).toISOString(),
  result: result(),
  doc,
  bodyBytes: Buffer.from(JSON.stringify({ token: TOKEN, user: 'ann' })),
  secrets: [{ name: 'accessToken', value: TOKEN }, { name: 'password', value: PASSWORD }],
  appVersion: '0.0.0-test',
  ...over
});

describe('HistoryStore', () => {
  it('stores a redacted run and returns it with its original test results', () => {
    const s = store.add(input());
    expect(s).toMatchObject({ requestId: 'req-1', status: 200, passed: 1, failed: 1, errors: 0, environment: 'dev', method: 'POST' });
    const e = store.get(s.runId)!;
    expect(e.result.body.text).toBe('{"token":"«secret:accessToken»","user":"ann"}');
    expect(e.result.request.url).toBe('https://api.example.test/login?key=«secret:accessToken»');
    expect(Object.fromEntries(e.result.request.headers)).toEqual({ Authorization: '«redacted»', 'X-Pw': '«secret:password»' });
    expect(Object.fromEntries(e.result.headers)['set-cookie']).toBe('«redacted»');
    expect(e.result.requestBody).toBe('{"password":"«secret:password»"}');
    expect(e.result.console[0].text).toBe('got «secret:accessToken»');
    expect(e.result.tests.map((t) => t.status)).toEqual(['passed', 'failed']);
    expect(JSON.stringify(e.doc)).not.toContain(PASSWORD);
  });

  it('never writes a secret value to the database file', () => {
    for (let i = 0; i < 3; i++) store.add(input());
    store.close();
    const bytes = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain(PASSWORD);
    expect(bytes).not.toContain('abc123456');
    store = open();
  });

  it('survives a restart', () => {
    const s = store.add(input());
    store.close();
    store = open();
    expect(store.list('req-1').map((x) => x.runId)).toEqual([s.runId]);
    expect(store.get(s.runId)!.result.tests).toHaveLength(2);
  });

  it('keeps cookie metadata through restart and export without persisting any value fields', () => {
    const cookie = { hop: 0, direction: 'received' as const, name: 'sid', domain: 'api.example.test', path: '/', httpOnly: true, value: 'never-store-cookie-value' };
    const s = store.add(input({ result: result({ cookieDetails: [cookie] }), doc: { ...doc, headers: [{ name: 'Cookie', value: 'manual=never-store-cookie-value', enabled: true }] } }));
    expect(store.get(s.runId)!.result.cookieDetails).toEqual([expect.objectContaining({ name: 'sid', httpOnly: true })]);
    expect(JSON.stringify(store.export([s.runId], false))).not.toContain('never-store-cookie-value');
    store.close();
    expect(readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('')).not.toContain('never-store-cookie-value');
    store = open();
    expect(store.get(s.runId)!.result.cookieDetails?.[0].name).toBe('sid');
    expect(store.get(s.runId)!.doc.headers[0].value).toBe('«redacted»');
  });

  it('keeps the newest N runs per request', () => {
    settings.historyRunsPerRequest = 3;
    const ids = Array.from({ length: 5 }, () => store.add(input()).runId);
    store.add(input({ requestId: 'req-2' }));
    expect(store.list('req-1').map((x) => x.runId)).toEqual(ids.slice(2).reverse());
    expect(store.list('req-2')).toHaveLength(1);
  });

  it('trims the oldest runs overall when over the size cap', () => {
    settings.historyCapMb = 0.002; // ~2 KB: only a couple of runs fit
    for (let i = 0; i < 6; i++) store.add(input({ requestId: `req-${i}` }));
    const { runs, bytes } = store.stats();
    expect(bytes).toBeLessThanOrEqual(0.002 * 1024 * 1024);
    expect(runs).toBeGreaterThan(0);
    expect(store.list('req-5')).toHaveLength(1); // the newest survives
    expect(store.list('req-0')).toHaveLength(0);
  });

  it('stores large bodies truncated and labelled, without splitting a character', () => {
    settings.historyBodyLimitMb = 10 / (1024 * 1024); // 10 bytes
    const s = store.add(input({ bodyBytes: Buffer.from('ééééééééé') })); // 18 bytes
    const e = store.get(s.runId)!;
    expect(s.bodyTruncated).toBe(true);
    expect(e.result.body.text).toBe('ééééé');
    expect(e.result.body.truncated).toBe(true);
  });

  it('can omit bodies entirely', () => {
    settings.historyBodyLimitMb = 0;
    const s = store.add(input());
    expect(s.bodyOmitted).toBe(true);
    expect(store.get(s.runId)!.result.body.text).toBe('');
  });

  it('lists orphaned history and can reattach or delete it', () => {
    store.add(input({ requestId: 'gone', requestName: 'Old login' }));
    store.add(input({ requestId: 'req-1' }));
    expect(store.orphans(['C:/repo/api'], new Set(['req-1']))).toEqual([expect.objectContaining({ requestId: 'gone', requestName: 'Old login', runs: 1 })]);
    store.reattach('gone', 'req-1');
    expect(store.list('req-1')).toHaveLength(2);
    expect(store.orphans(['C:/repo/api'], new Set(['req-1']))).toEqual([]);
    store.deleteRequestHistory('req-1');
    expect(store.stats().runs).toBe(0);
  });

  it('exports selected runs, already redacted, with bodies optional', () => {
    const s = store.add(input());
    const withBodies = JSON.stringify(store.export([s.runId], true));
    const without = store.export([s.runId], false) as { schema: string; entries: { response: { body?: string } }[] };
    expect(without.schema).toBe('yept.history/1');
    expect(without.entries[0].response.body).toBeUndefined();
    expect(withBodies).toContain('«secret:accessToken»');
    expect(withBodies).not.toContain(TOKEN);
  });
});
