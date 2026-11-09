import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createHost } from './host';
import { keyCipher } from './cipher';
import { createLocalStores, createRequestServices, type ServiceHooks } from './handlers';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import type { DevToolsRunEvent } from '@yept/core/shared/ipc';
import type { RunnerEvent, RunnerResult } from '@yept/core/shared/collection-run';

// The channels the runner panel and the Dev Tools view use, through the request services of one workspace folder.
let dir: string;
let base: string;
// Run last-in first-out after each test, before its folder is removed.
let cleanups: (() => unknown)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yept-runner-services-'));
  await cp(resolve('fixtures/collections/sample-travel'), join(dir, 'workspace'), { recursive: true });
  const { createFixtureServer } = await import('../../../fixtures/server/server.mjs');
  const server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = join(dir, 'workspace', 'environments', 'local.yml');
  await writeFile(env, (await readFile(env, 'utf8')).replace('http://localhost:4010', base));
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function open(hooks: ServiceHooks = {}) {
  const emitted: RunnerEvent[] = [];
  const host = await createHost(join(dir, 'storage'), dir, '0.9.0', {}, () => {}, (channel, event) => { if (channel === 'runner:event') emitted.push(event as RunnerEvent); }, { cipher: keyCipher(randomBytes(32)) });
  // The bundled worker isn't built for unit tests; the engine's own worker runs the scripts.
  host.sandboxWorkerPath = resolve('packages/core/src/engine/sandbox/worker.mjs');
  const identity = new IdentityStore(join(host.userDataPath(), 'identity.db'));
  const ws = new Workspace(join(dir, 'workspace'), identity, { trash: host.trash });
  const snapshot = await ws.load();
  const stores = createLocalStores(host);
  const services = createRequestServices(host, ws, stores, hooks);
  const collectionId = snapshot.collections[0].id;
  await services.handlers.invoke('env:set-secret', collectionId, 'local', 'clientSecret', 'sample-secret');
  cleanups.push(async () => {
    await services.close();
    stores.close();
    identity.close();
  });
  return { services, snapshot, ws, collectionId, emitted };
}

it('runs a collection through its channel, sends progress as runner events and tells the extension afterwards', async () => {
  const hooks = { onHistoryChange: vi.fn(), onEnvChange: vi.fn() };
  const { services, collectionId, emitted } = await open(hooks);
  const result = await services.handlers.invoke('runner:start', 'runner-1', collectionId, { environment: 'local', stopOnFailure: false }) as RunnerResult;
  expect(result.steps.map((s) => `${s.name} ${s.status}`)).toEqual(['Login passed', 'List bookings passed']);
  expect(emitted.map((e) => e.type)).toEqual(['step-start', 'step-end', 'step-start', 'step-end']);
  const end = emitted[1] as Extract<RunnerEvent, { type: 'step-end' }>;
  expect(end.result?.status).toBe(200);
  expect(hooks.onHistoryChange).toHaveBeenCalled();
  expect(hooks.onEnvChange).toHaveBeenCalled();
  // As on the desktop, options are coerced; ids are checked.
  await expect(services.handlers.invoke('runner:start', 7, collectionId, {})).rejects.toThrow('string');
  await expect(services.handlers.invoke('runner:start', 'r', 'missing', {})).rejects.toThrow('no longer exists');
  await expect(services.handlers.invoke('runner:cancel', 'r', 'extra')).rejects.toThrow('count');
});

it('cuts large bodies in runner events to what Dev Tools shows', async () => {
  const { services, ws, collectionId, emitted } = await open();
  const login = [...ws.liveRequestIds()].find((r) => ws.getRequest(r).doc.name === 'Login')!;
  const doc = ws.getRequest(login).doc;
  await ws.saveRequest(login, { ...doc, url: `${base}/big?mb=1`, auth: { ...doc.auth, mode: 'none' } });
  await services.handlers.invoke('runner:start', 'runner-2', ws.snapshot().collections[0].children!.find((c) => c.name === 'Auth')!.id, { environment: 'local', stopOnFailure: false });
  const end = emitted.find((e) => e.type === 'step-end') as Extract<RunnerEvent, { type: 'step-end' }>;
  expect(end.result!.sizeBytes).toBeGreaterThan(200_000);
  expect(end.result!.body.text.length).toBe(64 * 1024 + 1);
  expect(end.result!.body.preview).toBe(true);
  expect(collectionId).toBeTruthy();
});

it('tells Dev Tools when a panel send starts and ends, with the active environment', async () => {
  const runs: DevToolsRunEvent[] = [];
  const { services, ws, collectionId } = await open({ onRun: (e) => runs.push(e) });
  await services.handlers.invoke('env:set-active', collectionId, 'local');
  const id = [...ws.liveRequestIds()].find((r) => ws.getRequest(r).doc.name === 'Login')!;
  const doc = ws.getRequest(id).doc;
  const runId = '00000000-0000-4000-8000-000000000011';
  await services.handlers.invoke('runs:start', runId, id, doc);
  expect(runs[0]).toEqual({ type: 'start', runId, requestId: id, requestName: 'Login', collectionId, environment: 'local', method: 'POST', url: '{{baseUrl}}/auth/token' });
  expect(runs[1]).toMatchObject({ type: 'end', runId, collectionId, result: { status: 200 } });
  // Copies with secrets are kept for runs of this session.
  expect(await services.handlers.invoke('runs:curl-with-secrets', runId)).toContain(Buffer.from('sample-client:sample-secret').toString('base64'));
  expect(await services.handlers.invoke('runs:raw-with-secrets', runId)).toMatch(/^POST \/auth\/token/);
  await expect(services.handlers.invoke('runs:curl-with-secrets', 'unknown')).rejects.toThrow('last 50 requests');
});

it('adds, edits, removes and clears cookies through validated channels', async () => {
  const { services, collectionId } = await open();
  const cookie = { name: 'sid', value: 'synthetic', domain: 'api.example.test', path: '/', expires: null, secure: false, httpOnly: true, sameSite: '', hostOnly: true };
  // The last argument is left out when undefined, as the page's calls arrive.
  let jar = await services.handlers.invoke('cookies:upsert', collectionId, cookie) as any;
  expect(jar.cookies).toMatchObject([{ name: 'sid', value: 'synthetic' }]);
  jar = await services.handlers.invoke('cookies:upsert', collectionId, { ...cookie, name: 'session' }, { domain: cookie.domain, path: '/', name: 'sid' });
  expect(jar.cookies.map((c: any) => c.name)).toEqual(['session']);
  await services.handlers.invoke('cookies:upsert', collectionId, { ...cookie, domain: 'other.example.test' });
  jar = await services.handlers.invoke('cookies:clear', collectionId, 'other.example.test');
  expect(jar.cookies.map((c: any) => c.domain)).toEqual(['api.example.test']);
  jar = await services.handlers.invoke('cookies:remove', collectionId, { domain: cookie.domain, path: '/', name: 'session' });
  expect(jar.cookies).toEqual([]);
  await services.handlers.invoke('cookies:upsert', collectionId, cookie);
  jar = await services.handlers.invoke('cookies:clear', collectionId);
  expect(jar.cookies).toEqual([]);
  await expect(services.handlers.invoke('cookies:upsert', collectionId, { ...cookie, secure: 'yes' })).rejects.toThrow('Invalid cookie');
  await expect(services.handlers.invoke('cookies:remove', collectionId, { name: 'x' })).rejects.toThrow('Invalid cookie');
  await expect(services.handlers.invoke('cookies:clear', collectionId, 5)).rejects.toThrow('string');
  await expect(services.handlers.invoke('cookies:clear', 'missing')).rejects.toThrow();
});
