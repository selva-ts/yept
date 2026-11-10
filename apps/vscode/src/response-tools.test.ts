import { afterEach, beforeEach, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHost } from './host';
import { keyCipher } from './cipher';
import { createLocalStores, createRequestServices } from './handlers';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import type { RequestDoc } from '@yept/core/shared/model';
import { createFixtureServer, fixturePng } from '../../../fixtures/server/server.mjs';

let dir: string;
let base: string;
const closers: (() => unknown)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yept-response-tools-'));
  await cp(resolve('fixtures/collections/sample-travel'), join(dir, 'workspace'), { recursive: true });
  const server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => { server.closeAllConnections(); server.close(); });
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await rm(dir, { recursive: true, force: true });
});

async function open(savePath?: string) {
  const host = await createHost(join(dir, 'storage'), dir, '0.9.0', {}, () => {}, () => {}, {
    cipher: keyCipher(randomBytes(32)),
    saveDialog: async () => (savePath ? { canceled: false, filePath: savePath } : { canceled: true })
  });
  host.sandboxWorkerPath = resolve('packages/core/src/engine/sandbox/worker.mjs');
  const identity = new IdentityStore(join(host.userDataPath(), 'identity.db'));
  const ws = new Workspace(join(dir, 'workspace'), identity, { trash: host.trash });
  await ws.load();
  const stores = createLocalStores(host);
  const services = createRequestServices(host, ws, stores);
  closers.push(async () => { await services.close(); stores.close(); identity.close(); });
  const id = [...ws.liveRequestIds()].find((r) => ws.getRequest(r).doc.name === 'Login')!;
  const login = ws.getRequest(id).doc;
  // The Login request without its auth, scripts and actions: a plain GET to the fixture server.
  const plain = (path: string, headers: RequestDoc['headers'] = []): RequestDoc => ({
    ...structuredClone(login), method: 'GET', url: `${base}${path}`, headers, auth: { ...login.auth, mode: 'none' }, body: { ...login.body, mode: 'none' },
    script: { req: '', res: '' }, tests: '', assertions: [], vars: { req: [], res: [] }
  });
  const invoke = (channel: string, ...args: unknown[]) => services.handlers.invoke(channel, ...args) as Promise<any>;
  return { invoke, id, collectionId: ws.collectionIdOf(id), plain };
}

async function filesContaining(root: string, value: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).toString('latin1').includes(value)) out.push(path);
  }
  return out;
}

it('sets a runtime variable that the next request uses, kept in memory only', async () => {
  const { invoke, id, collectionId, plain } = await open();
  await invoke('env:set-active', collectionId, 'local');
  const value = 'synthetic-runtime-value-5b1e';
  await invoke('env:set-runtime', collectionId, 'local', 'bookingRef', value);
  const preview = await invoke('env:preview', id, plain('/echo'));
  expect(preview.vars.find((v: any) => v.name === 'bookingRef')).toMatchObject({ value, source: 'runtime' });
  const sent = await invoke('runs:start', randomUUID(), id, plain('/echo', [{ name: 'X-Booking', value: '{{bookingRef}}', enabled: true }]));
  expect(JSON.parse(sent.result.body.text).headers['x-booking']).toBe(value);
  // Runtime variables are for this session: nothing on disk has them (history stores the run, so check only the local stores).
  expect(await filesContaining(join(dir, 'workspace'), value)).toEqual([]);
  expect((await filesContaining(join(dir, 'storage'), value)).filter((f) => !/history\.db/.test(f))).toEqual([]);

  await expect(invoke('env:set-runtime', collectionId, 'missing', 'a', 'b')).rejects.toThrow('Environment not found');
  await expect(invoke('env:set-runtime', collectionId, 'local', 'not a name', 'b')).rejects.toThrow('variable name');
  await expect(invoke('env:set-runtime', collectionId, 'local', 'a', 1)).rejects.toThrow('Expected a string');
});

it('stores a token as a local secret: declared in the environment file, the value only in the encrypted store', async () => {
  const { invoke, collectionId } = await open();
  const token = 'synthetic-token-value-0c4d';
  const list = await invoke('env:store-as-secret', collectionId, 'local', 'apiToken', token);
  expect(list.environments.find((e: any) => e.name === 'local').variables.find((v: any) => v.name === 'apiToken')).toMatchObject({ secret: true, value: '', hasSecret: true });
  expect(await invoke('env:reveal-secret', collectionId, 'local', 'apiToken')).toBe(token);
  expect(await readFile(join(dir, 'workspace', 'environments', 'local.yml'), 'utf8')).toContain('name: apiToken');
  expect(await filesContaining(join(dir, 'workspace'), token)).toEqual([]);
  expect(await filesContaining(join(dir, 'storage'), token)).toEqual([]);
});

it('saves the body byte for byte and hands the preview the same bytes', async () => {
  const target = join(dir, 'saved.bin');
  const { invoke, id, plain } = await open(target);
  const runId = randomUUID();
  const run = await invoke('runs:start', runId, id, plain('/binary'));
  expect(run.result.body.binary).toBe(true);
  expect(await invoke('runs:save-body', runId, 'sub/dir\\name.bin')).toBe(target);
  const expected = Buffer.from(await (await fetch(`${base}/binary`)).arrayBuffer());
  expect((await readFile(target)).equals(expected)).toBe(true);

  const imageRun = randomUUID();
  await invoke('runs:start', imageRun, id, plain('/media/image.png'));
  expect(Buffer.from(await invoke('runs:body-bytes', imageRun), 'base64').equals(fixturePng())).toBe(true);

  // Only runs the page was shown, or stored runs of a request in this folder.
  await expect(invoke('runs:body-bytes', randomUUID())).rejects.toThrow('History entry not found');
  await expect(invoke('runs:save-body', randomUUID(), 'x.bin')).rejects.toThrow('History entry not found');
});
