// A workspace is a folder holding one or more Bruno collections.
// YAML collections are read/write; .bru collections are read-only.
import { promises as fs, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname, basename, extname, isAbsolute, sep } from 'node:path';
import { utils as brunoUtils } from '@usebruno/common';
import type { Environment, RequestDoc, SettingsDoc, TreeNode, WorkspaceSnapshot } from '../../shared/model';
import { atomicWrite, TEMP_PREFIX } from '../fs/atomic-write';
import { IdentityStore, fingerprint } from '../identity/identity-store';
import { localFileMap, withLocalFiles } from '../../shared/multipart';
import { parseDotEnv } from '@usebruno/filestore';
import {
  applyRequestDoc, applySettingsDoc, collectionNameFromBrunoJson, isHttpItem, newRequestItem, parseCollectionFile,
  parseEnvironmentFile, parseFolderFile, parseRequestFile, stringifyCollectionFile, stringifyEnvironmentFile, stringifyFolderFile,
  stringifyRequestFile, toRequestDoc, toSettingsDoc, type BrunoItem, type CollectionFile, type Format
} from './bruno-adapter';

interface CollectionEntry {
  id: string;
  /** Absolute folder. */
  dir: string;
  name: string;
  format: Format;
  file: CollectionFile | null;
  environments: Map<string, { file: string; env: Environment }>;
}

/** Why a collection folder name is unusable, or undefined when it is fine. Callers may check before asking the engine. */
export function collectionNameError(name: string): string | undefined {
  const clean = name.trim();
  if (!clean || clean.length > 80 || clean === '.' || clean === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(clean) || /[. ]$/.test(clean) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) {
    return 'Enter a collection name without path or reserved characters';
  }
  return undefined;
}

/** Everything a run needs from disk besides the request itself. */
export interface RequestContext {
  collectionId: string;
  collectionDir: string;
  collectionName: string;
  collection: SettingsDoc;
  /** Folder settings from the outermost folder to the innermost. */
  folders: SettingsDoc[];
  /** Variables from the collection's local .env file (never committed). */
  processEnv: Record<string, string>;
}

interface FolderEntry {
  id: string;
  collection: CollectionEntry;
  dir: string;
  name: string;
  seq: number;
  raw: BrunoItem | null;
}

interface RequestEntry {
  id: string;
  collection: CollectionEntry;
  file: string;
  raw: BrunoItem;
  seq: number;
}

export class WorkspaceError extends Error {}

const SKIP_DIRS = new Set(['node_modules', '.git', 'environments', '.yept']);
const OWN_WRITE_WINDOW_MS = 2000;

const toPosix = (p: string): string => p.split(sep).join('/');
const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex');
const sanitize = (name: string): string => {
  const s = (brunoUtils?.sanitizeName ? brunoUtils.sanitizeName(name) : name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')).trim();
  return s.replace(/[. ]+$/, '') || 'untitled';
};

export interface WorkspaceOptions {
  /** Moves a file or folder to the Recycle Bin. Injected so the engine stays free of Electron. */
  trash: (absPath: string) => Promise<void>;
}

export class Workspace {
  readonly root: string;
  private collections = new Map<string, CollectionEntry>();
  private folders = new Map<string, FolderEntry>();
  private requests = new Map<string, RequestEntry>();
  private problems: { path: string; message: string }[] = [];
  /** Paths Yept just wrote, with the content hash for files, so the watcher can tell its own writes apart. */
  private ownWrites = new Map<string, { at: number; hash?: string }>();

  constructor(root: string, private identity: IdentityStore, private options: WorkspaceOptions) {
    this.root = root;
  }

  // ---------- loading ----------

  async load(): Promise<WorkspaceSnapshot> {
    // The watcher reloads asynchronously. Keep the previous tree available to readers until the new one is ready.
    const next = new Workspace(this.root, this.identity, this.options);
    for (const dir of await this.findCollectionDirs(this.root, 0)) await next.loadCollection(dir);
    this.collections = next.collections;
    this.folders = next.folders;
    this.requests = next.requests;
    this.problems = next.problems;
    return this.snapshot();
  }

  private async findCollectionDirs(dir: string, depth: number): Promise<string[]> {
    if (existsSync(join(dir, 'opencollection.yml')) || existsSync(join(dir, 'bruno.json'))) return [dir];
    if (depth >= 4) return [];
    const out: string[] = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) out.push(...(await this.findCollectionDirs(join(dir, e.name), depth + 1)));
    }
    return out;
  }

  private async loadCollection(dir: string): Promise<void> {
    const isYml = existsSync(join(dir, 'opencollection.yml'));
    const format: Format = isYml ? 'yml' : 'bru';
    let file: CollectionFile | null = null;
    let name = basename(dir);
    try {
      if (isYml) {
        file = parseCollectionFile(await fs.readFile(join(dir, 'opencollection.yml'), 'utf8'), 'yml');
        name = file.name || name;
      } else {
        name = collectionNameFromBrunoJson(await fs.readFile(join(dir, 'bruno.json'), 'utf8')) ?? name;
        const rootFile = join(dir, 'collection.bru');
        if (existsSync(rootFile)) file = parseCollectionFile(await fs.readFile(rootFile, 'utf8'), 'bru');
      }
    } catch (e) {
      this.problems.push({ path: this.rel(join(dir, isYml ? 'opencollection.yml' : 'collection.bru')), message: (e as Error).message.split('\n')[0] });
    }
    const collection: CollectionEntry = { id: `collection:${this.rel(dir)}`, dir, name, format, file, environments: new Map() };
    this.collections.set(collection.id, collection);
    await this.loadEnvironments(collection);

    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          await this.loadFolder(collection, p);
          await walk(p);
        } else if (this.isRequestFile(collection, e.name)) files.push(p);
      }
    };
    await walk(dir);

    const live = new Set(files.map((f) => toPosix(relative(dir, f))));
    for (const file of files) await this.loadRequest(collection, file, live);
  }

  private isRequestFile(collection: CollectionEntry, fileName: string): boolean {
    if (fileName.startsWith(TEMP_PREFIX)) return false;
    if (collection.format === 'yml') return fileName.endsWith('.yml') && fileName !== 'opencollection.yml' && fileName !== 'folder.yml';
    return fileName.endsWith('.bru') && fileName !== 'collection.bru' && fileName !== 'folder.bru';
  }

  private async loadFolder(collection: CollectionEntry, dir: string): Promise<void> {
    let name = basename(dir);
    let seq = 0;
    let raw: BrunoItem | null = null;
    const meta = join(dir, collection.format === 'yml' ? 'folder.yml' : 'folder.bru');
    if (existsSync(meta)) {
      try {
        const f = parseFolderFile(await fs.readFile(meta, 'utf8'), collection.format);
        name = f.name || name;
        seq = f.seq;
        raw = f.raw;
      } catch (e) {
        this.problems.push({ path: this.rel(meta), message: (e as Error).message });
      }
    }
    const id = `folder:${this.rel(dir)}`;
    this.folders.set(id, { id, collection, dir, name, seq, raw });
  }

  private async loadRequest(collection: CollectionEntry, file: string, live: Set<string>): Promise<RequestEntry | undefined> {
    try {
      const raw = parseRequestFile(await fs.readFile(file, 'utf8'), collection.format);
      if (!isHttpItem(raw)) {
        this.problems.push({ path: this.rel(file), message: `Unsupported request type "${raw?.type}" (HTTP only in v1)` });
        return undefined;
      }
      const relPath = toPosix(relative(collection.dir, file));
      const doc = toRequestDoc(raw);
      const id = this.identity.resolve(collection.dir, relPath, fingerprint(doc), live);
      const entry: RequestEntry = { id, collection, file, raw, seq: Number(raw.seq ?? 0) };
      this.requests.set(id, entry);
      return entry;
    } catch (e) {
      this.problems.push({ path: this.rel(file), message: (e as Error).message.split('\n')[0] });
      return undefined;
    }
  }

  // ---------- tree ----------

  snapshot(): WorkspaceSnapshot {
    const nodeFor = (c: CollectionEntry, dir: string): TreeNode[] => {
      const folders = [...this.folders.values()]
        .filter((f) => f.collection === c && dirname(f.dir) === dir)
        .sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name))
        .map((f): TreeNode => ({ id: f.id, kind: 'folder', name: f.name, path: this.rel(f.dir), readOnly: c.format === 'bru', children: nodeFor(c, f.dir) }));
      const reqs = [...this.requests.values()]
        .filter((r) => r.collection === c && dirname(r.file) === dir)
        .sort((a, b) => a.seq - b.seq || String(a.raw.name).localeCompare(String(b.raw.name)))
        .map((r): TreeNode => ({ id: r.id, kind: 'request', name: String(r.raw.name), path: this.rel(r.file), method: toRequestDoc(r.raw).method, readOnly: c.format === 'bru' }));
      return [...folders, ...reqs];
    };
    const collections = [...this.collections.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c): TreeNode => ({ id: c.id, kind: 'collection', name: c.name, path: this.rel(c.dir), readOnly: c.format === 'bru', children: nodeFor(c, c.dir) }));
    return { root: this.root, collections, problems: [...this.problems] };
  }

  getRequest(id: string): { doc: RequestDoc; readOnly: boolean; path: string } {
    const r = this.mustRequest(id);
    const doc = toRequestDoc(r.raw);
    doc.settings.sendCookies = !this.identity.noCookies(id);
    doc.body.multipartForm = withLocalFiles(doc.body.multipartForm, this.identity.localFiles(id));
    return { doc, readOnly: r.collection.format === 'bru', path: this.rel(r.file) };
  }

  // ---------- edits ----------

  async createCollection(name: string): Promise<string> {
    const clean = name.trim();
    const invalid = collectionNameError(clean);
    if (invalid) throw new WorkspaceError(invalid);
    if (existsSync(join(this.root, 'opencollection.yml')) || existsSync(join(this.root, 'bruno.json'))) {
      throw new WorkspaceError('Open a parent workspace folder to create another collection');
    }
    const entries = await fs.readdir(this.root);
    if (entries.some((entry) => entry.toLowerCase() === clean.toLowerCase()) ||
        [...this.collections.values()].some((collection) => collection.name.toLowerCase() === clean.toLowerCase())) {
      throw new WorkspaceError('A collection with this name already exists');
    }
    const dir = join(this.root, clean);
    await fs.mkdir(dir);
    try {
      await this.write(join(dir, 'opencollection.yml'), stringifyCollectionFile({
        name: clean, root: null, config: { name: clean, opencollection: '1.0.0' }, hadProxy: false
      }));
    } catch (e) {
      await fs.rmdir(dir).catch(() => undefined);
      throw e;
    }
    await this.load();
    return `collection:${this.rel(dir)}`;
  }

  async saveRequest(id: string, doc: RequestDoc): Promise<{ path: string }> {
    const r = this.mustWritable(this.mustRequest(id));
    const updated = applyRequestDoc(r.raw, doc);
    let target = r.file;
    if (doc.name !== r.raw.name) target = this.uniquePath(dirname(r.file), sanitize(doc.name), '.yml', r.file);
    await this.write(target, stringifyRequestFile(updated));
    if (target !== r.file) {
      await this.removeOwn(r.file);
      this.identity.move(r.collection.dir, toPosix(relative(r.collection.dir, r.file)), toPosix(relative(r.collection.dir, target)));
      r.file = target;
    }
    r.raw = updated;
    this.identity.setNoCookies(id, !doc.settings.sendCookies);
    this.identity.setLocalFiles(id, localFileMap(doc.body.multipartForm ?? []));
    return { path: this.rel(target) };
  }

  /** `fill` sets up the new request's contents (e.g. from a pasted cURL command), so the file is written once. */
  async createRequest(parentId: string, name: string, fill?: (doc: RequestDoc) => RequestDoc): Promise<string> {
    const { collection, dir } = this.parentOf(parentId);
    this.mustWritable({ collection });
    const file = this.uniquePath(dir, sanitize(name), '.yml');
    const blank = newRequestItem(name, this.nextSeq(collection, dir));
    const doc = fill?.(toRequestDoc(blank));
    const raw = doc ? applyRequestDoc(blank, { ...doc, name }) : blank;
    await this.write(file, stringifyRequestFile(raw));
    const entry = await this.loadRequest(collection, file, this.livePaths(collection, file));
    if (!entry) throw new WorkspaceError('Created request could not be read back');
    if (doc) this.identity.setLocalFiles(entry.id, localFileMap(doc.body.multipartForm ?? []));
    return entry.id;
  }

  async createFolder(parentId: string, name: string): Promise<string> {
    const { collection, dir } = this.parentOf(parentId);
    this.mustWritable({ collection });
    const folderDir = this.uniquePath(dir, sanitize(name), '');
    await fs.mkdir(folderDir);
    await this.write(join(folderDir, 'folder.yml'), stringifyFolderFile({ name, seq: this.nextSeq(collection, dir) }, null));
    await this.loadFolder(collection, folderDir);
    return `folder:${this.rel(folderDir)}`;
  }

  async rename(id: string, name: string): Promise<string> {
    if (this.requests.has(id)) {
      const r = this.mustRequest(id);
      await this.saveRequest(id, { ...toRequestDoc(r.raw), name });
      return id;
    }
    const f = this.mustFolder(id);
    this.mustWritable(f);
    const target = this.uniquePath(dirname(f.dir), sanitize(name), '', f.dir);
    if (target !== f.dir) await this.moveDir(f, target);
    const newF = this.mustFolder(`folder:${this.rel(target)}`);
    await this.write(join(newF.dir, 'folder.yml'), stringifyFolderFile({ name, seq: newF.seq }, newF.raw));
    newF.name = name;
    return newF.id;
  }

  /** Moves a request or folder into another folder or collection root of the same collection. */
  async move(id: string, targetParentId: string): Promise<string> {
    const { collection, dir } = this.parentOf(targetParentId);
    if (this.requests.has(id)) {
      const r = this.mustWritable(this.mustRequest(id));
      if (r.collection !== collection) throw new WorkspaceError('Moving between collections is not supported yet');
      if (dirname(r.file) === dir) return id;
      const target = this.uniquePath(dir, basename(r.file, extname(r.file)), '.yml');
      this.markOwn(r.file);
      this.markOwn(target);
      await fs.rename(r.file, target);
      this.identity.move(collection.dir, toPosix(relative(collection.dir, r.file)), toPosix(relative(collection.dir, target)));
      r.file = target;
      return id;
    }
    const f = this.mustWritable(this.mustFolder(id));
    if (f.collection !== collection) throw new WorkspaceError('Moving between collections is not supported yet');
    if (dir === f.dir || dir.startsWith(f.dir + sep)) throw new WorkspaceError('A folder cannot be moved into itself');
    const target = this.uniquePath(dir, basename(f.dir), '');
    await this.moveDir(f, target);
    return `folder:${this.rel(target)}`;
  }

  async duplicate(id: string): Promise<string> {
    const r = this.mustWritable(this.mustRequest(id));
    const doc = toRequestDoc(r.raw);
    const name = `${doc.name} copy`;
    const file = this.uniquePath(dirname(r.file), sanitize(name), '.yml');
    const raw = applyRequestDoc(r.raw, { ...doc, name });
    raw.seq = this.nextSeq(r.collection, dirname(r.file));
    await this.write(file, stringifyRequestFile(raw));
    const entry = await this.loadRequest(r.collection, file, this.livePaths(r.collection, file));
    if (!entry) throw new WorkspaceError('Duplicated request could not be read back');
    // The copy keeps the files chosen on this computer.
    this.identity.setLocalFiles(entry.id, this.identity.localFiles(id));
    return entry.id;
  }

  /** Moves a whole collection folder to the Recycle Bin. A collection that is the workspace folder itself is refused. */
  async deleteCollection(id: string): Promise<void> {
    const c = this.mustCollection(id);
    if (this.rel(c.dir) === '.') throw new WorkspaceError('This collection is the workspace folder itself. Open its parent folder to delete it.');
    this.markOwn(c.dir);
    await this.options.trash(c.dir);
    await this.load();
  }

  /** Deletes to the Recycle Bin (never a hard delete). */
  async delete(id: string): Promise<void> {
    if (this.requests.has(id)) {
      const r = this.mustWritable(this.mustRequest(id));
      this.markOwn(r.file);
      await this.options.trash(r.file);
      this.requests.delete(id);
      return;
    }
    const f = this.mustWritable(this.mustFolder(id));
    this.markOwn(f.dir);
    await this.options.trash(f.dir);
    for (const [k, v] of this.folders) if (v.dir === f.dir || v.dir.startsWith(f.dir + sep)) this.folders.delete(k);
    for (const [k, v] of this.requests) if (v.file.startsWith(f.dir + sep)) this.requests.delete(k);
  }

  // ---------- environments ----------

  private async loadEnvironments(collection: CollectionEntry): Promise<void> {
    const dir = join(collection.dir, 'environments');
    if (!existsSync(dir)) return;
    const ext = collection.format === 'yml' ? '.yml' : '.bru';
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(ext) || f.startsWith(TEMP_PREFIX)) continue;
      const file = join(dir, f);
      try {
        const env = parseEnvironmentFile(await fs.readFile(file, 'utf8'), collection.format, basename(f, ext));
        collection.environments.set(env.name, { file, env });
      } catch (e) {
        this.problems.push({ path: this.rel(file), message: (e as Error).message.split('\n')[0] });
      }
    }
  }

  listEnvironments(collectionId: string): { env: Environment; path: string }[] {
    const c = this.mustCollection(collectionId);
    return [...c.environments.values()]
      .sort((a, b) => a.env.name.localeCompare(b.env.name))
      .map((e) => ({ env: structuredClone(e.env), path: this.rel(e.file) }));
  }

  getEnvironment(collectionId: string, name: string): Environment | undefined {
    const e = this.mustCollection(collectionId).environments.get(name);
    return e ? structuredClone(e.env) : undefined;
  }

  /** Creates (previousName null), updates or renames an environment file. Secret values are never written. */
  async saveEnvironment(collectionId: string, previousName: string | null, env: Environment): Promise<void> {
    const c = this.mustWritable({ collection: this.mustCollection(collectionId) }).collection;
    const name = env.name.trim();
    if (!name) throw new WorkspaceError('An environment needs a name');
    if (name !== previousName && c.environments.has(name)) throw new WorkspaceError(`An environment called "${name}" already exists`);
    const names = new Set<string>();
    for (const v of env.variables) {
      if (!v.name.trim()) throw new WorkspaceError('Every variable needs a name');
      if (names.has(v.name)) throw new WorkspaceError(`Variable "${v.name}" appears twice`);
      names.add(v.name);
    }
    const dir = join(c.dir, 'environments');
    await fs.mkdir(dir, { recursive: true });
    const existing = previousName ? c.environments.get(previousName) : undefined;
    if (previousName && !existing) throw new WorkspaceError(`Environment not found: ${previousName}`);
    const target = existing && previousName === name ? existing.file : this.uniquePath(dir, sanitize(name), '.yml', existing?.file);
    const clean: Environment = { name, variables: env.variables.map((v) => ({ ...v, value: v.secret ? '' : v.value })) };
    await this.write(target, stringifyEnvironmentFile(clean));
    if (existing && existing.file !== target) await this.removeOwn(existing.file);
    if (previousName) c.environments.delete(previousName);
    c.environments.set(name, { file: target, env: clean });
  }

  async deleteEnvironment(collectionId: string, name: string): Promise<void> {
    const c = this.mustWritable({ collection: this.mustCollection(collectionId) }).collection;
    const e = c.environments.get(name);
    if (!e) throw new WorkspaceError(`Environment not found: ${name}`);
    this.markOwn(e.file);
    await this.options.trash(e.file);
    c.environments.delete(name);
  }

  // ---------- collection and folder settings ----------

  getSettings(id: string): { doc: SettingsDoc; readOnly: boolean } {
    const c = this.collections.get(id);
    if (c) return { doc: toSettingsDoc(c.name, c.file?.root ?? null, 'none'), readOnly: c.format === 'bru' };
    const f = this.mustFolder(id);
    return { doc: toSettingsDoc(f.name, f.raw, 'inherit'), readOnly: f.collection.format === 'bru' };
  }

  async saveSettings(id: string, doc: SettingsDoc): Promise<void> {
    const c = this.collections.get(id);
    if (c) {
      this.mustWritable({ collection: c });
      const file: CollectionFile = c.file ?? { name: c.name, root: null, config: { name: c.name, opencollection: '1.0.0' }, hadProxy: false };
      const updated: CollectionFile = { ...file, root: applySettingsDoc(file.root, doc) };
      await this.write(join(c.dir, 'opencollection.yml'), stringifyCollectionFile(updated));
      c.file = updated;
      return;
    }
    const f = this.mustWritable(this.mustFolder(id));
    const raw = applySettingsDoc(f.raw, doc);
    await this.write(join(f.dir, 'folder.yml'), stringifyFolderFile({ name: f.name, seq: f.seq }, raw));
    f.raw = raw;
  }

  /** The collection and folder chain above a request, for inheritance (auth, headers, variables, scripts). */
  async requestContext(id: string): Promise<RequestContext> {
    const r = this.mustRequest(id);
    const c = r.collection;
    const folders: SettingsDoc[] = [];
    for (let d = dirname(r.file); d !== c.dir && d.startsWith(c.dir); d = dirname(d)) {
      const f = this.folders.get(`folder:${this.rel(d)}`);
      if (f) folders.unshift(toSettingsDoc(f.name, f.raw, 'inherit'));
    }
    let processEnv: Record<string, string> = {};
    const dotEnv = join(c.dir, '.env');
    if (existsSync(dotEnv)) {
      try {
        processEnv = parseDotEnv(await fs.readFile(dotEnv, 'utf8'));
      } catch (e) {
        this.problems.push({ path: this.rel(dotEnv), message: (e as Error).message });
      }
    }
    return {
      collectionId: c.id,
      collectionDir: c.dir,
      collectionName: c.name,
      collection: toSettingsDoc(c.name, c.file?.root ?? null, 'none'),
      folders,
      processEnv
    };
  }

  collectionIdOf(id: string): string {
    if (this.collections.has(id)) return id;
    if (this.requests.has(id)) return this.mustRequest(id).collection.id;
    return this.mustFolder(id).collection.id;
  }

  collectionDir(collectionId: string): string {
    return this.mustCollection(collectionId).dir;
  }

  /**
   * The collection as Bruno's in-memory model (folders, requests, root, environments), for export and .bru conversion.
   * Environment secret values are never part of it: files never contain them.
   */
  collectionModel(collectionId: string): { name: string; format: Format; dir: string; root: BrunoItem | null; brunoConfig: BrunoItem; items: BrunoItem[]; environments: BrunoItem[] } {
    const c = this.mustCollection(collectionId);
    const build = (dir: string): BrunoItem[] => {
      const folders = [...this.folders.values()]
        .filter((f) => f.collection === c && dirname(f.dir) === dir)
        .map((f) => ({ type: 'folder', name: f.name, seq: f.seq, root: f.raw ?? { meta: { name: f.name, seq: f.seq } }, items: build(f.dir) }));
      const reqs = [...this.requests.values()].filter((r) => r.collection === c && dirname(r.file) === dir).map((r) => structuredClone(r.raw));
      return [...folders, ...reqs].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0) || String(a.name).localeCompare(String(b.name)));
    };
    return {
      name: c.name,
      format: c.format,
      dir: c.dir,
      root: c.file?.root ?? null,
      brunoConfig: { ...(c.file?.config ?? {}), name: c.name },
      items: build(c.dir),
      environments: [...c.environments.values()].map(({ env }) => ({
        name: env.name,
        variables: env.variables.map((v) => ({ name: v.name, value: v.secret ? '' : v.value, enabled: v.enabled, secret: v.secret, type: 'text' }))
      }))
    };
  }

  /**
   * Renames Git detected across a pull, Sync or branch switch (paths relative to the repository root). Call before
   * load(): each renamed request keeps its id, so its history and open tab follow it to the new path. Renames that
   * leave their collection, land outside the request files, or onto a path that already has an id are skipped.
   * Returns the renames that were followed.
   */
  followRenames<R extends { from: string; to: string }>(repoRoot: string, renames: R[]): R[] {
    const real = (p: string): string => {
      try { return realpathSync.native(p); } catch { return p; }
    };
    const within = (rel: string): boolean => !!rel && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
    const base = real(repoRoot);
    const followed: R[] = [];
    for (const rename of renames) {
      const { from, to } = rename;
      const fromAbs = join(base, ...from.split('/'));
      const toAbs = join(base, ...to.split('/'));
      for (const c of this.collections.values()) {
        const dir = real(c.dir);
        const fromRel = relative(dir, fromAbs);
        const toRel = relative(dir, toAbs);
        if (!within(fromRel) || !within(toRel)) continue;
        const folders = toRel.split(sep).slice(0, -1);
        if (folders.some((f) => SKIP_DIRS.has(f) || f.startsWith('.')) || !this.isRequestFile(c, basename(toAbs))) break;
        if (this.identity.followRename(c.dir, toPosix(fromRel), toPosix(toRel))) followed.push(rename);
        break;
      }
    }
    return followed;
  }

  /** Every request id currently on disk (for finding orphaned history). */
  liveRequestIds(): Set<string> {
    return new Set(this.requests.keys());
  }

  collectionDirs(): string[] {
    return [...this.collections.values()].map((c) => c.dir);
  }

  // ---------- external changes ----------

  /**
   * True if the current state of the path is what this workspace wrote (the watcher ignores these).
   * Files compare by content, so someone else's edit right after a Yept save is still detected;
   * renames and deletes (no content) fall back to a short time window.
   */
  isOwnWrite(absPath: string): boolean {
    const w = this.ownWrites.get(absPath);
    if (!w) return false;
    if (w.hash === undefined) return Date.now() - w.at < OWN_WRITE_WINDOW_MS;
    try {
      return hashOf(readFileSync(absPath, 'utf8')) === w.hash;
    } catch {
      return false;
    }
  }

  /** Finds the request id for an absolute file path, if loaded. */
  requestIdForFile(absPath: string): string | undefined {
    for (const r of this.requests.values()) if (r.file === absPath) return r.id;
    return undefined;
  }

  // ---------- helpers ----------

  private rel(abs: string): string {
    return toPosix(relative(this.root, abs)) || '.';
  }

  private livePaths(collection: CollectionEntry, added: string): Set<string> {
    return new Set([added, ...[...this.requests.values()].filter((request) => request.collection === collection).map((request) => request.file)]
      .map((file) => toPosix(relative(collection.dir, file))));
  }

  private markOwn(absPath: string, content?: string): void {
    this.ownWrites.set(absPath, { at: Date.now(), hash: content === undefined ? undefined : hashOf(content) });
  }

  private async write(absPath: string, content: string): Promise<void> {
    this.markOwn(absPath, content);
    await atomicWrite(absPath, content);
  }

  private async removeOwn(absPath: string): Promise<void> {
    this.markOwn(absPath);
    await fs.rm(absPath, { force: true });
  }

  private async moveDir(f: FolderEntry, target: string): Promise<void> {
    const from = f.dir;
    this.markOwn(from);
    this.markOwn(target);
    await fs.rename(from, target);
    this.identity.movePrefix(f.collection.dir, toPosix(relative(f.collection.dir, from)), toPosix(relative(f.collection.dir, target)));
    for (const folder of [...this.folders.values()]) {
      if (folder.dir === from || folder.dir.startsWith(from + sep)) {
        this.folders.delete(folder.id);
        folder.dir = target + folder.dir.slice(from.length);
        folder.id = `folder:${this.rel(folder.dir)}`;
        this.folders.set(folder.id, folder);
      }
    }
    for (const r of this.requests.values()) if (r.file.startsWith(from + sep)) r.file = target + r.file.slice(from.length);
  }

  private uniquePath(dir: string, base: string, ext: string, current?: string): string {
    let candidate = join(dir, base + ext);
    for (let i = 2; existsSync(candidate) && candidate.toLowerCase() !== current?.toLowerCase(); i++) candidate = join(dir, `${base} (${i})${ext}`);
    return candidate;
  }

  private nextSeq(collection: CollectionEntry, dir: string): number {
    const seqs = [
      ...[...this.requests.values()].filter((r) => r.collection === collection && dirname(r.file) === dir).map((r) => r.seq),
      ...[...this.folders.values()].filter((f) => f.collection === collection && dirname(f.dir) === dir).map((f) => f.seq)
    ];
    return (seqs.length ? Math.max(...seqs) : 0) + 1;
  }

  private parentOf(parentId: string): { collection: CollectionEntry; dir: string } {
    const c = this.collections.get(parentId);
    if (c) return { collection: c, dir: c.dir };
    const f = this.mustFolder(parentId);
    return { collection: f.collection, dir: f.dir };
  }

  private mustCollection(id: string): CollectionEntry {
    const c = this.collections.get(id);
    if (!c) throw new WorkspaceError(`Collection not found: ${id}`);
    return c;
  }

  private mustRequest(id: string): RequestEntry {
    const r = this.requests.get(id);
    if (!r) throw new WorkspaceError(`Request not found: ${id}`);
    return r;
  }

  private mustFolder(id: string): FolderEntry {
    const f = this.folders.get(id);
    if (!f) throw new WorkspaceError(`Folder not found: ${id}`);
    return f;
  }

  private mustWritable<T extends { collection: CollectionEntry }>(x: T): T {
    if (x.collection.format === 'bru') throw new WorkspaceError('This is a .bru collection and opens read-only. Use Convert to YAML to get an editable copy.');
    return x;
  }
}
