// Response history: one SQLite row per run in the user's app-data folder, never in the repository.
// Rows are redacted before they're written; bodies are capped; old runs are pruned per request and by total size.
import { DatabaseSync } from 'node:sqlite';
import type { AppSettings, HistoryEntry, HistorySummary, OrphanedHistory, RequestDoc, RunResult } from '../../shared/model';
import { redactDoc, redactResult, redactText, type NamedSecret } from './redact';

const SCHEMA_VERSION = 1;

export interface HistoryInput {
  runId: string;
  requestId: string;
  collectionDir: string;
  requestName: string;
  requestPath: string;
  startedAt: string;
  result: RunResult;
  doc: RequestDoc;
  bodyBytes: Buffer;
  secrets: NamedSecret[];
  appVersion: string;
}

interface Row {
  run_id: string;
  request_id: string;
  request_name: string;
  request_path: string;
  started_at: string;
  environment: string;
  method: string;
  url: string;
  outcome: string;
  status: number | null;
  duration_ms: number;
  size_bytes: number;
  passed: number;
  failed: number;
  errors: number;
  tests_state: string;
  body_truncated: number;
  body_omitted: number;
}

const SUMMARY_COLUMNS =
  'run_id, request_id, request_name, request_path, started_at, environment, method, url, outcome, status, duration_ms, size_bytes, passed, failed, errors, tests_state, body_truncated, body_omitted';

function toSummary(r: Row): HistorySummary {
  return {
    runId: r.run_id,
    requestId: r.request_id,
    requestName: r.request_name,
    requestPath: r.request_path,
    startedAt: r.started_at,
    environment: r.environment,
    method: r.method as HistorySummary['method'],
    url: r.url,
    outcome: r.outcome as HistorySummary['outcome'],
    status: r.status ?? undefined,
    durationMs: r.duration_ms,
    sizeBytes: r.size_bytes,
    passed: r.passed,
    failed: r.failed,
    errors: r.errors,
    testsState: r.tests_state as HistorySummary['testsState'],
    bodyTruncated: !!r.body_truncated,
    bodyOmitted: !!r.body_omitted
  };
}

/** Cuts a UTF-8 buffer to at most `max` bytes without splitting a character. */
function cutUtf8(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

export class HistoryStore {
  private db: DatabaseSync;

  constructor(path: string, private settings: () => AppSettings) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: v } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (v >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id         TEXT PRIMARY KEY,
        request_id     TEXT NOT NULL,
        collection_dir TEXT NOT NULL,
        request_name   TEXT NOT NULL,
        request_path   TEXT NOT NULL,
        started_at     TEXT NOT NULL,
        environment    TEXT NOT NULL,
        method         TEXT NOT NULL,
        url            TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        status         INTEGER,
        duration_ms    INTEGER NOT NULL,
        size_bytes     INTEGER NOT NULL,
        passed         INTEGER NOT NULL,
        failed         INTEGER NOT NULL,
        errors         INTEGER NOT NULL,
        tests_state    TEXT NOT NULL,
        body_truncated INTEGER NOT NULL,
        body_omitted   INTEGER NOT NULL,
        result_json    TEXT NOT NULL,
        doc_json       TEXT NOT NULL,
        body           BLOB,
        row_bytes      INTEGER NOT NULL,
        app_version    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_by_request ON runs (request_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_by_time ON runs (started_at);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  /** Redacts and stores a run, then prunes. Returns the stored summary. */
  add(input: HistoryInput): HistorySummary {
    const s = this.settings();
    const limit = Math.max(0, Math.round(s.historyBodyLimitMb * 1024 * 1024));
    const result = redactResult(input.result, input.secrets);
    const doc = redactDoc(input.doc, input.secrets);
    let body: Buffer | null = null;
    let truncated = input.result.body.truncated;
    let omitted = false;
    if (input.bodyBytes.length) {
      // Text bodies are redacted (an extracted token in a login response becomes «secret:accessToken»). Binary bodies are stored as-is.
      const bytes = input.result.body.binary ? input.bodyBytes : Buffer.from(redactText(input.bodyBytes.toString('utf8'), input.secrets), 'utf8');
      if (limit === 0) omitted = true;
      else {
        body = input.result.body.binary ? bytes.subarray(0, limit) : cutUtf8(bytes, limit);
        if (body.length < bytes.length) truncated = true;
      }
    }
    const counts = { passed: 0, failed: 0, errors: 0 };
    for (const t of result.tests) counts[t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'errors']++;
    const resultJson = JSON.stringify(result);
    const docJson = JSON.stringify(doc);
    const rowBytes = resultJson.length + docJson.length + (body?.length ?? 0) + 512;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs (run_id, request_id, collection_dir, request_name, request_path, started_at, environment, method, url, outcome, status,
           duration_ms, size_bytes, passed, failed, errors, tests_state, body_truncated, body_omitted, result_json, doc_json, body, row_bytes, app_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId, input.requestId, input.collectionDir, input.requestName, input.requestPath, input.startedAt, result.environment, result.request.method,
        result.request.url, result.outcome, result.status ?? null, result.durationMs, result.sizeBytes, counts.passed, counts.failed, counts.errors,
        result.testsState, truncated ? 1 : 0, omitted ? 1 : 0, resultJson, docJson, body, rowBytes, input.appVersion
      );
    this.prune(input.requestId);
    return this.summary(input.runId)!;
  }

  /** Keeps the newest N runs per request, then trims the oldest runs overall until under the size cap. */
  prune(requestId?: string): void {
    const s = this.settings();
    const keep = Math.max(1, Math.round(s.historyRunsPerRequest));
    const ids = requestId ? [requestId] : (this.db.prepare('SELECT DISTINCT request_id AS id FROM runs').all() as { id: string }[]).map((r) => r.id);
    const del = this.db.prepare(
      'DELETE FROM runs WHERE request_id = ? AND run_id NOT IN (SELECT run_id FROM runs WHERE request_id = ? ORDER BY started_at DESC LIMIT ?)'
    );
    for (const id of ids) del.run(id, id, keep);
    const cap = Math.max(0.001, s.historyCapMb) * 1024 * 1024;
    let { total } = this.db.prepare('SELECT COALESCE(SUM(row_bytes), 0) AS total FROM runs').get() as { total: number };
    if (total <= cap) return;
    const oldest = this.db.prepare('SELECT run_id, row_bytes FROM runs ORDER BY started_at ASC').iterate() as Iterable<{ run_id: string; row_bytes: number }>;
    const doomed: string[] = [];
    for (const r of oldest) {
      if (total <= cap) break;
      doomed.push(r.run_id);
      total -= r.row_bytes;
    }
    const d = this.db.prepare('DELETE FROM runs WHERE run_id = ?');
    for (const id of doomed) d.run(id);
  }

  list(requestId: string): HistorySummary[] {
    return (this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM runs WHERE request_id = ? ORDER BY started_at DESC`).all(requestId) as unknown as Row[]).map(toSummary);
  }

  summary(runId: string): HistorySummary | undefined {
    const r = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM runs WHERE run_id = ?`).get(runId) as unknown as Row | undefined;
    return r ? toSummary(r) : undefined;
  }

  get(runId: string): HistoryEntry | undefined {
    const r = this.db.prepare(`SELECT ${SUMMARY_COLUMNS}, result_json, doc_json, body FROM runs WHERE run_id = ?`).get(runId) as unknown as
      | (Row & { result_json: string; doc_json: string; body: Uint8Array | null })
      | undefined;
    if (!r) return undefined;
    const result = JSON.parse(r.result_json) as RunResult;
    const bytes = r.body ? Buffer.from(r.body) : Buffer.alloc(0);
    result.body = { ...result.body, text: result.body.binary ? '' : bytes.toString('utf8'), truncated: !!r.body_truncated };
    const doc = JSON.parse(r.doc_json) as RequestDoc;
    // Runs recorded before multipart bodies existed have no multipart fields.
    if (doc.body) doc.body.multipartForm ??= [];
    return { summary: toSummary(r), result, doc };
  }

  /** Stored body bytes of a run (for "Save to file" on an old entry). */
  body(runId: string): Buffer | undefined {
    const r = this.db.prepare('SELECT body FROM runs WHERE run_id = ?').get(runId) as { body: Uint8Array | null } | undefined;
    return r?.body ? Buffer.from(r.body) : undefined;
  }

  /** History whose request no longer exists in the workspace (deleted, or renamed outside the app and not matched). */
  orphans(collectionDirs: string[], liveRequestIds: Set<string>): OrphanedHistory[] {
    if (!collectionDirs.length) return [];
    const rows = this.db
      .prepare(
        `SELECT request_id, MAX(request_name) AS request_name, MAX(request_path) AS request_path, COUNT(*) AS runs, MAX(started_at) AS last_run
         FROM runs WHERE collection_dir IN (${collectionDirs.map(() => '?').join(',')}) GROUP BY request_id`
      )
      .all(...collectionDirs) as { request_id: string; request_name: string; request_path: string; runs: number; last_run: string }[];
    return rows
      .filter((r) => !liveRequestIds.has(r.request_id))
      .map((r) => ({ requestId: r.request_id, requestName: r.request_name, requestPath: r.request_path, runs: r.runs, lastRun: r.last_run }));
  }

  reattach(fromRequestId: string, toRequestId: string): void {
    this.db.prepare('UPDATE runs SET request_id = ? WHERE request_id = ?').run(toRequestId, fromRequestId);
    this.prune(toRequestId);
  }

  deleteRequestHistory(requestId: string): void {
    this.db.prepare('DELETE FROM runs WHERE request_id = ?').run(requestId);
  }

  deleteRun(runId: string): void {
    this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
  }

  stats(): { runs: number; bytes: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS runs, COALESCE(SUM(row_bytes), 0) AS bytes FROM runs').get() as { runs: number; bytes: number };
    return { runs: r.runs, bytes: r.bytes };
  }

  /** Versioned export of selected runs. Already redacted; bodies optional. */
  export(runIds: string[], includeBodies: boolean): object {
    const entries = runIds.map((id) => this.get(id)).filter((e): e is HistoryEntry => !!e);
    return {
      schema: 'yept.history/1',
      exportedAt: new Date().toISOString(),
      entries: entries.map((e) => ({
        ...e.summary,
        request: { ...e.result.request, body: e.result.requestBody },
        response: { status: e.result.status, statusText: e.result.statusText, headers: e.result.headers, body: includeBodies ? e.result.body.text : undefined },
        tests: e.result.tests,
        extractions: e.result.extractions
      }))
    };
  }

  close(): void {
    this.db.close();
  }
}
