// Stable request identity. Bruno files carry no stable id, so Yept keeps one locally:
// requestId <-> (collection root, relative path) plus a content fingerprint for re-matching after
// renames made outside the app. Unmatched entries are kept (orphaned history), never guessed.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestDoc } from '../../shared/model';

/** Content fingerprint used to re-match a request after it was renamed outside the app. */
export function fingerprint(doc: Pick<RequestDoc, 'method' | 'url' | 'body'>): string {
  const b = doc.body;
  const body =
    b.mode === 'json' ? b.json
    : b.mode === 'text' ? b.text
    : b.mode === 'xml' ? b.xml
    : b.mode === 'formUrlEncoded' ? b.formUrlEncoded.map((f) => `${f.name}=${f.value}`).join('&')
    : b.mode === 'multipartForm' ? b.multipartForm.map((f) => `${f.name}=${f.type === 'file' ? f.files.join('|') : f.value}`).join('&')
    : '';
  return createHash('sha256').update(`${doc.method}\n${doc.url}\n${b.mode}\n${body}`).digest('hex').slice(0, 32);
}

export class IdentityStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS request_identity (
        id          TEXT PRIMARY KEY,
        collection  TEXT NOT NULL,
        path        TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        seen_at     TEXT NOT NULL,
        UNIQUE (collection, path)
      );
      -- Per-request settings Bruno's file format has no place for. Local to this computer, like secrets.
      CREATE TABLE IF NOT EXISTS request_local (
        id          TEXT PRIMARY KEY,
        no_cookies  INTEGER NOT NULL DEFAULT 0
      );
      -- Multipart files outside the collection, chosen on this computer: JSON { fieldKey: [absolute paths] }.
      -- The request file never holds these paths, so teammates choose their own copy.
      CREATE TABLE IF NOT EXISTS request_files (
        id          TEXT PRIMARY KEY,
        fields      TEXT NOT NULL
      );
    `);
  }

  /** True when "Don't send stored cookies" is on for this request. */
  noCookies(id: string): boolean {
    return !!(this.db.prepare('SELECT no_cookies FROM request_local WHERE id = ?').get(id) as { no_cookies: number } | undefined)?.no_cookies;
  }

  setNoCookies(id: string, on: boolean): void {
    if (on) this.db.prepare('INSERT INTO request_local (id, no_cookies) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET no_cookies = 1').run(id);
    else this.db.prepare('DELETE FROM request_local WHERE id = ?').run(id);
  }

  /** Local multipart files per field key (see multipartKey). */
  localFiles(id: string): Record<string, string[]> {
    const row = this.db.prepare('SELECT fields FROM request_files WHERE id = ?').get(id) as { fields: string } | undefined;
    try {
      return row ? JSON.parse(row.fields) : {};
    } catch {
      return {};
    }
  }

  setLocalFiles(id: string, fields: Record<string, string[]>): void {
    if (Object.keys(fields).length) this.db.prepare('INSERT INTO request_files (id, fields) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET fields = excluded.fields').run(id, JSON.stringify(fields));
    else this.db.prepare('DELETE FROM request_files WHERE id = ?').run(id);
  }

  /**
   * Returns the id for a request file, creating one if needed.
   * `livePaths` is the set of request paths currently on disk in this collection; an existing entry whose
   * path is no longer live and whose fingerprint matches exactly one such entry is treated as a rename.
   */
  resolve(collection: string, path: string, fp: string, livePaths: Set<string>): string {
    const now = new Date().toISOString();
    const byPath = this.db.prepare('SELECT id, fingerprint FROM request_identity WHERE collection = ? AND path = ?').get(collection, path) as
      | { id: string; fingerprint: string }
      | undefined;
    if (byPath) {
      if (byPath.fingerprint !== fp) this.db.prepare('UPDATE request_identity SET fingerprint = ?, seen_at = ? WHERE id = ?').run(fp, now, byPath.id);
      return byPath.id;
    }
    const candidates = (this.db.prepare('SELECT id, path FROM request_identity WHERE collection = ? AND fingerprint = ?').all(collection, fp) as {
      id: string;
      path: string;
    }[]).filter((c) => !livePaths.has(c.path));
    if (candidates.length === 1) {
      this.db.prepare('UPDATE request_identity SET path = ?, seen_at = ? WHERE id = ?').run(path, now, candidates[0].id);
      return candidates[0].id;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO request_identity (id, collection, path, fingerprint, seen_at) VALUES (?, ?, ?, ?, ?)').run(id, collection, path, fp, now);
    return id;
  }

  /** Renames and moves made inside the app update the mapping first, so history always follows. */
  move(collection: string, fromPath: string, toPath: string): void {
    this.db.prepare('UPDATE request_identity SET path = ? WHERE collection = ? AND path = ?').run(toPath, collection, fromPath);
  }

  /**
   * A rename Git detected across a pull or branch switch. The id moves only when the old path is known and the new
   * path has no id of its own; otherwise nothing changes and the usual matching applies. True when it moved.
   */
  followRename(collection: string, fromPath: string, toPath: string): boolean {
    const known = this.db.prepare('SELECT id FROM request_identity WHERE collection = ? AND path = ?').get(collection, fromPath) as { id: string } | undefined;
    if (!known) return false;
    const taken = this.db.prepare('SELECT 1 FROM request_identity WHERE collection = ? AND path = ?').get(collection, toPath);
    if (taken) return false;
    this.db.prepare('UPDATE request_identity SET path = ?, seen_at = ? WHERE id = ?').run(toPath, new Date().toISOString(), known.id);
    return true;
  }

  /** Moves every request under a folder prefix (folder rename or move). */
  movePrefix(collection: string, fromPrefix: string, toPrefix: string): void {
    const rows = this.db.prepare('SELECT id, path FROM request_identity WHERE collection = ? AND path LIKE ?').all(collection, `${fromPrefix}/%`) as {
      id: string;
      path: string;
    }[];
    const stmt = this.db.prepare('UPDATE request_identity SET path = ? WHERE id = ?');
    for (const r of rows) stmt.run(toPrefix + r.path.slice(fromPrefix.length), r.id);
  }

  pathOf(id: string): { collection: string; path: string } | undefined {
    return this.db.prepare('SELECT collection, path FROM request_identity WHERE id = ?').get(id) as { collection: string; path: string } | undefined;
  }

  close(): void {
    this.db.close();
  }
}
