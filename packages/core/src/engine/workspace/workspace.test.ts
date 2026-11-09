import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IdentityStore } from '../identity/identity-store';
import { Workspace } from './workspace';
import type { TreeNode } from '../../shared/model';
import { parseCurl, requestFromCurl } from '../../shared/curl';

const FIXTURES = resolve(__dirname, '../../../../../fixtures/collections');

let dir: string;
let trashDir: string;
let identity: IdentityStore;
let ws: Workspace;

const trash = async (p: string): Promise<void> => {
  await fs.rename(p, join(trashDir, `${Date.now()}-${Math.random()}`));
};

async function open(): Promise<Workspace> {
  ws = new Workspace(join(dir, 'ws'), identity, { trash });
  await ws.load();
  return ws;
}

function findPath(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    const c = n.children && findPath(n.children, path);
    if (c) return c;
  }
  return undefined;
}

function find(nodes: TreeNode[], name: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.name === name) return n;
    const c = n.children && find(n.children, name);
    if (c) return c;
  }
  return undefined;
}
const node = (name: string): TreeNode => {
  const n = name.includes('/') ? findPath(ws.snapshot().collections, name) : find(ws.snapshot().collections, name);
  if (!n) throw new Error(`no node ${name}`);
  return n;
};

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'yept-ws-'));
  trashDir = join(dir, 'trash');
  await fs.mkdir(trashDir);
  await fs.cp(FIXTURES, join(dir, 'ws'), { recursive: true });
  identity = new IdentityStore(join(dir, 'identity.db'));
});
afterEach(async () => {
  identity.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Workspace', () => {
  it('finds collections and builds the tree in seq order', async () => {
    await open();
    const snap = ws.snapshot();
    expect(snap.collections.map((c) => c.name)).toEqual(['DummyJSON', 'Sample ASP.NET API', 'Sample Travel']);
    expect(node('Sample Travel').children!.map((c) => c.name)).toEqual(['Auth', 'Bookings']);
    expect(node('sample-travel/Auth/Login.yml').method).toBe('POST');
    expect(snap.problems).toEqual([]);
  });

  it('creates a collection without overwriting or escaping the workspace', async () => {
    await open();
    const id = await ws.createCollection('Fresh API');
    expect(id).toBe('collection:Fresh API');
    expect(node('Fresh API').children).toEqual([]);
    expect(readFileSync(join(dir, 'ws', 'Fresh API', 'opencollection.yml'), 'utf8')).toContain('name: Fresh API');
    await expect(ws.createCollection('fresh api')).rejects.toThrow('already exists');
    await expect(ws.createCollection('../outside')).rejects.toThrow('collection name');
    expect(existsSync(join(dir, 'outside'))).toBe(false);
  });

  it('moves a whole collection to the trash and drops it from the workspace', async () => {
    await open();
    const id = await ws.createCollection('Scratch');
    await ws.deleteCollection(id);
    expect(existsSync(join(dir, 'ws', 'Scratch'))).toBe(false);
    expect(ws.collectionDirs().some((d) => d.endsWith('Scratch'))).toBe(false);
    await expect(ws.deleteCollection(id)).rejects.toThrow('not found');
  });

  it('saving an unedited request rewrites the exact same bytes', async () => {
    await open();
    const n = node('List bookings');
    const file = join(dir, 'ws', n.path);
    const before = readFileSync(file, 'utf8');
    await ws.saveRequest(n.id, ws.getRequest(n.id).doc);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('saves edits and keeps fields Yept does not edit (scripts, vars, assertions)', async () => {
    await open();
    const n = node('sample-travel/Auth/Login.yml');
    const { doc } = ws.getRequest(n.id);
    await ws.saveRequest(n.id, { ...doc, url: '{{baseUrl}}/auth/v2/token' });
    const text = readFileSync(join(dir, 'ws', n.path), 'utf8');
    expect(text).toContain('url: "{{baseUrl}}/auth/v2/token"');
    expect(text).toContain('bru.setVar("scriptToken"');
    expect(text).toContain('type: set-variable');
    expect(text).toContain('operator: eq');
  });

  it("keeps 'Don't send stored cookies' locally, out of the request file, and across a rename", async () => {
    await open();
    const n = node('List bookings');
    const file = join(dir, 'ws', n.path);
    const before = readFileSync(file, 'utf8');
    const { doc } = ws.getRequest(n.id);
    expect(doc.settings.sendCookies).toBe(true);
    await ws.saveRequest(n.id, { ...doc, settings: { ...doc.settings, sendCookies: false } });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(ws.getRequest(n.id).doc.settings.sendCookies).toBe(false);
    await ws.saveRequest(n.id, { ...doc, name: 'All bookings', settings: { ...doc.settings, sendCookies: false } });
    expect(ws.getRequest(n.id).doc.settings.sendCookies).toBe(false);
    await ws.saveRequest(n.id, { ...doc, name: 'All bookings', settings: { ...doc.settings, sendCookies: true } });
    expect(ws.getRequest(n.id).doc.settings.sendCookies).toBe(true);
  });

  it('renaming a request renames the file and keeps its id', async () => {
    await open();
    const id = node('List bookings').id;
    await ws.rename(id, 'All bookings');
    expect(existsSync(join(dir, 'ws/sample-travel/Bookings/All bookings.yml'))).toBe(true);
    expect(existsSync(join(dir, 'ws/sample-travel/Bookings/List bookings.yml'))).toBe(false);
    expect(node('All bookings').id).toBe(id);
    await open(); // reload from disk: same id
    expect(node('All bookings').id).toBe(id);
  });

  it('keeps the id when a file is renamed outside the app', async () => {
    await open();
    const id = node('List bookings').id;
    await fs.rename(join(dir, 'ws/sample-travel/Bookings/List bookings.yml'), join(dir, 'ws/sample-travel/Bookings/renamed.yml'));
    await open();
    expect(node('List bookings').id).toBe(id);
    expect(node('List bookings').path).toBe('sample-travel/Bookings/renamed.yml');
  });

  it('follows renames Git reports, and skips the ones that would attach history to the wrong place', async () => {
    await open();
    const list = node('List bookings').id;
    const login = node('Login').id;
    const me = node('sample-aspnet/Me.yml').id;
    const followed = ws.followRenames(join(dir, 'ws'), [
      { from: 'sample-travel/Bookings/List bookings.yml', to: 'sample-travel/Bookings/Edited.yml' },
      // Onto a path that already has an id; out of its collection; into a non-request file or skipped folder.
      { from: 'sample-travel/Auth/Login.yml', to: 'sample-travel/Bookings/Edited.yml' },
      { from: 'sample-aspnet/Me.yml', to: 'sample-travel/Me.yml' },
      { from: 'sample-aspnet/Login.yml', to: 'sample-aspnet/folder.yml' },
      { from: 'sample-aspnet/Login.yml', to: 'sample-aspnet/environments/Login.yml' },
      { from: 'sample-travel/Unknown.yml', to: 'sample-travel/Known.yml' }
    ]);
    expect(followed).toEqual([{ from: 'sample-travel/Bookings/List bookings.yml', to: 'sample-travel/Bookings/Edited.yml' }]);
    // The file Git renamed now has different content: only the followed rename keeps the id.
    const file = join(dir, 'ws/sample-travel/Bookings/List bookings.yml');
    await fs.writeFile(join(dir, 'ws/sample-travel/Bookings/Edited.yml'), readFileSync(file, 'utf8').replace('status=all', 'status=open'));
    await fs.rm(file);
    await ws.load();
    expect(ws.requestIdForFile(join(dir, 'ws/sample-travel/Bookings/Edited.yml'))).toBe(list);
    expect(node('Login').id).toBe(login);
    expect(node('sample-aspnet/Me.yml').id).toBe(me);
  });

  it('creates, duplicates, moves and deletes', async () => {
    await open();
    const folderId = await ws.createFolder(node('Sample Travel').id, 'Admin');
    const reqId = await ws.createRequest(folderId, 'Health check');
    expect(node('Health check').method).toBe('GET');
    const created = readFileSync(join(dir, 'ws/sample-travel/Admin/Health check.yml'), 'utf8');
    expect(created).toContain('forwardAuthorizationHeader: false');

    const copyId = await ws.duplicate(reqId);
    expect(copyId).not.toBe(reqId);
    expect(node('Health check copy').id).toBe(copyId);
    expect(node('Health check').id).toBe(reqId);

    await ws.move(copyId, node('Bookings').id);
    expect(existsSync(join(dir, 'ws/sample-travel/Bookings/Health check copy.yml'))).toBe(true);
    expect(node('Health check copy').id).toBe(copyId);

    await ws.delete(reqId);
    expect(find(ws.snapshot().collections, 'Health check')).toBeUndefined();
    expect((await fs.readdir(trashDir)).length).toBe(1); // went to the bin, not hard-deleted
  });

  it('creates a request with its contents in one write, keeping pasted file paths local', async () => {
    await open();
    const command = `curl -X POST 'https://api.example.test/upload?v=2' -H 'Accept: application/json' -F 'title=Report' -F 'file=@/home/alex/report.pdf'`;
    const id = await ws.createRequest(node('Bookings').id, 'POST upload', (doc) => requestFromCurl(doc, parseCurl(command)));
    const saved = readFileSync(join(dir, 'ws/sample-travel/Bookings/POST upload.yml'), 'utf8');
    expect(saved).toContain('https://api.example.test/upload?v=2');
    expect(saved).not.toContain('/home/alex/report.pdf');
    const { doc } = ws.getRequest(id);
    expect(doc).toMatchObject({ name: 'POST upload', method: 'POST', params: [{ name: 'v', value: '2' }], headers: [{ name: 'Accept', value: 'application/json' }], auth: { mode: 'inherit' } });
    expect(doc.body.mode).toBe('multipartForm');
    expect(doc.body.multipartForm.map((f) => [f.name, f.type, f.value, f.localFiles])).toEqual([['title', 'text', 'Report', []], ['file', 'file', '', ['/home/alex/report.pdf']]]);
  });

  it('renames and moves folders without losing request ids', async () => {
    await open();
    const id = node('List bookings').id;
    const newFolderId = await ws.rename(node('Bookings').id, 'Trips');
    expect(node('Trips').id).toBe(newFolderId);
    expect(node('List bookings').id).toBe(id);
    await ws.move(newFolderId, node('Auth').id);
    expect(node('List bookings').path).toBe('sample-travel/Auth/Trips/List bookings.yml');
    await open();
    expect(node('List bookings').id).toBe(id);
  });

  it('refuses to move a folder into itself', async () => {
    await open();
    const sub = await ws.createFolder(node('Bookings').id, 'Sub');
    await expect(ws.move(node('Bookings').id, sub)).rejects.toThrow(/into itself/);
  });

  it('avoids name clashes', async () => {
    await open();
    await ws.createRequest(node('Bookings').id, 'List bookings');
    expect(existsSync(join(dir, 'ws/sample-travel/Bookings/List bookings (2).yml'))).toBe(true);
  });

  it('opens .bru collections read-only', async () => {
    const bru = join(dir, 'ws/legacy');
    await fs.mkdir(bru);
    await fs.writeFile(join(bru, 'bruno.json'), JSON.stringify({ version: '1', name: 'Legacy', type: 'collection' }));
    await fs.writeFile(join(bru, 'Ping.bru'), 'meta {\n  name: Ping\n  type: http\n  seq: 1\n}\n\nget {\n  url: http://localhost/ping\n  body: none\n  auth: none\n}\n');
    await open();
    const ping = node('Ping');
    expect(ping.readOnly).toBe(true);
    expect(ws.getRequest(ping.id).doc.url).toBe('http://localhost/ping');
    await expect(ws.saveRequest(ping.id, ws.getRequest(ping.id).doc)).rejects.toThrow(/read-only/);
  });

  it('reports unreadable files instead of dropping them silently', async () => {
    await fs.writeFile(join(dir, 'ws/sample-travel/Broken.yml'), 'info: [unclosed');
    await open();
    expect(ws.snapshot().problems.map((p) => p.path)).toEqual(['sample-travel/Broken.yml']);
  });

  it('marks its own writes so the watcher can ignore them', async () => {
    await open();
    const n = node('List bookings');
    await ws.saveRequest(n.id, ws.getRequest(n.id).doc);
    expect(ws.isOwnWrite(join(dir, 'ws', n.path))).toBe(true);
  });

  it('still detects an external edit made right after its own save', async () => {
    await open();
    const n = node('List bookings');
    const file = join(dir, 'ws', n.path);
    await ws.saveRequest(n.id, ws.getRequest(n.id).doc);
    await fs.writeFile(file, readFileSync(file, 'utf8').replace('status=all', 'status=open'));
    expect(ws.isOwnWrite(file)).toBe(false);
  });
});
