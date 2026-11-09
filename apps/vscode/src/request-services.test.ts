import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from './host';
import { createLocalStores, createRequestServices } from './handlers';
import { requestChoices } from './request-choices';
import { requestDoc } from './validation';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yept-request-services-'));
  await cp(resolve('fixtures/collections/sample-travel'), join(dir, 'workspace'), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function open() {
  const host = await createHost(join(dir, 'storage'), dir, '0.6.0', {}, () => {}, () => {});
  const identity = new IdentityStore(join(host.userDataPath(), 'identity.db'));
  const ws = new Workspace(join(dir, 'workspace'), identity, { trash: host.trash });
  const snapshot = await ws.load();
  const stores = createLocalStores(host);
  const services = createRequestServices(host, ws, stores);
  const close = async () => {
    await services.close();
    stores.close();
    identity.close();
  };
  return { services, snapshot, ws, close };
}

it('keeps platform operations local and rejects unavailable capabilities', async () => {
  const clipboard = vi.fn();
  const emit = vi.fn();
  const host = await createHost(join(dir, 'storage'), dir, '0.6.0', { node: '24' }, clipboard, emit);
  expect(host.userDataPath()).toBe(join(dir, 'storage'));
  expect(host.appVersion()).toBe('0.6.0');
  expect(host.versions()).toEqual({ app: '0.6.0', node: '24' });
  expect(host.sandboxWorkerPath).toBe(join(dir, 'dist', 'worker.cjs'));
  host.writeClipboard('synthetic');
  expect(clipboard).toHaveBeenCalledWith('synthetic');
  host.emit('runner:event', {} as any);
  expect(emit).toHaveBeenCalled();
  expect(() => host.cipher.encrypt('x')).toThrow("Secrets can't be stored: no secret storage is connected");
  expect(() => host.cipher.decrypt('x')).toThrow("Secrets can't be stored: no secret storage is connected");
  const unavailable = [() => host.openDialog({}), () => host.saveDialog({}), () => host.trash('x'), () => host.openExternal('x'), () => host.notices(), () => host.selfTest()];
  for (const fn of unavailable) expect(fn).toThrow('not available');
  expect(host.metrics()).toEqual([]);
});

it('validates drafts, ids and arity before running shared services', async () => {
  const { services, ws, close } = await open();
  try {
    const id = [...ws.liveRequestIds()][0];
    const doc = ws.getRequest(id).doc;
    expect(() => requestDoc(doc)).not.toThrow();
    const invalid = [null, {}, { ...doc, params: {} }, { ...doc, settings: { ...doc.settings, timeoutMs: -1 } }, { ...doc, body: { ...doc.body, multipartForm: [{}] } }];
    for (const value of invalid) expect(() => requestDoc(value)).toThrow('Invalid request');
    await expect(services.handlers.invoke('requests:get', {})).rejects.toThrow('string');
    await expect(services.handlers.invoke('requests:get', 'missing')).rejects.toThrow();
    await expect(services.handlers.invoke('requests:get', id, 'extra')).rejects.toThrow('count');
    await expect(services.handlers.invoke('runs:start', 'invalid', id, doc)).rejects.toThrow('run id');
    await expect(services.handlers.invoke('env:set-active', ws.collectionIdOf(id), 'missing')).rejects.toThrow('Environment not found');
  } finally {
    await close();
  }
});

it('applies VS Code settings at each use, checked, without writing them to the settings file', async () => {
  const { keyCipher } = await import('./cipher');
  const { randomBytes } = await import('node:crypto');
  const file = join(dir, 'storage', 'settings.json');
  const host = await createHost(join(dir, 'storage'), dir, '0.9.0', {}, () => {}, () => {}, { cipher: keyCipher(randomBytes(32)) });
  await writeFile(file, JSON.stringify({ cookies: true, historyRunsPerRequest: 7 }));
  let configuration: ReturnType<Parameters<typeof createLocalStores>[1] & {}> = {};
  const identity = new IdentityStore(join(host.userDataPath(), 'identity.db'));
  const ws = new Workspace(join(dir, 'workspace'), identity, { trash: host.trash });
  await ws.load();
  const stores = createLocalStores(host, () => configuration);
  const services = createRequestServices(host, ws, stores);
  try {
    const collectionId = ws.collectionIdOf([...ws.liveRequestIds()][0]);
    expect(await services.handlers.invoke('cookies:list', collectionId)).toMatchObject({ enabled: true });
    expect(stores.settings.get().historyRunsPerRequest).toBe(7);
    configuration = { cookies: false, historyRunsPerRequest: 9999, historyBodyLimitMb: 5 };
    expect(await services.handlers.invoke('cookies:list', collectionId)).toMatchObject({ enabled: false });
    expect(stores.settings.get()).toMatchObject({ historyRunsPerRequest: 500, historyBodyLimitMb: 5 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ cookies: true, historyRunsPerRequest: 7 });
  } finally {
    await services.close();
    stores.close();
    identity.close();
  }
});

it('passes the scripts-blocked reason to each run', async () => {
  const host = await createHost(join(dir, 'storage'), dir, '0.9.0', {}, () => {}, () => {});
  // The bundled worker isn't built for unit tests; the engine's own worker runs the scripts once trust is given.
  host.sandboxWorkerPath = resolve('packages/core/src/engine/sandbox/worker.mjs');
  const identity = new IdentityStore(join(host.userDataPath(), 'identity.db'));
  const ws = new Workspace(join(dir, 'workspace'), identity, { trash: host.trash });
  await ws.load();
  const stores = createLocalStores(host);
  let reason: string | undefined = 'this folder is not trusted';
  const services = createRequestServices(host, ws, stores, { scriptsBlocked: () => reason });
  try {
    const id = [...ws.liveRequestIds()].find((r) => ws.getRequest(r).doc.name === 'Login')!;
    const { createFixtureServer } = await import('../../../fixtures/server/server.mjs');
    const server = createFixtureServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    onTestFinished(() => { server.closeAllConnections(); server.close(); });
    const login = ws.getRequest(id).doc;
    const doc = { ...login, auth: { ...login.auth, mode: 'none' as const }, url: `http://127.0.0.1:${(server.address() as any).port}/echo` };
    const first = await services.handlers.invoke('runs:start', '00000000-0000-4000-8000-000000000001', id, doc) as any;
    expect(first.result.status).toBe(200);
    expect(first.result.testsState).toBe('not-run');
    expect(first.result.scriptErrors.length).toBeGreaterThan(0);
    expect(first.result.scriptErrors.every((e: any) => e.message === 'Not run: this folder is not trusted')).toBe(true);
    reason = undefined;
    const second = await services.handlers.invoke('runs:start', '00000000-0000-4000-8000-000000000002', id, doc) as any;
    expect(second.result.scriptErrors).toEqual([]);
    expect(second.result.testsState).toBe('ran');
  } finally {
    await services.close();
    stores.close();
    identity.close();
  }
});

it('lists every request with its collection and path for the quick pick', async () => {
  const { snapshot, ws, close } = await open();
  try {
    const choices = requestChoices(snapshot);
    expect(choices.map(({ label, description, detail }) => ({ label, description, detail }))).toEqual([
      { label: 'Login', description: snapshot.collections[0].name, detail: expect.stringMatching(/Auth\/Login\.yml$/) },
      { label: 'List bookings', description: snapshot.collections[0].name, detail: expect.stringMatching(/Bookings\/List bookings\.yml$/) }
    ]);
    expect(new Set(choices.map((c) => c.id))).toEqual(ws.liveRequestIds());
  } finally {
    await close();
  }
});

it('shares the local stores across workspace folders and keeps them open when one folder closes', async () => {
  const first = join(dir, 'workspace');
  const second = join(dir, 'second');
  await cp(first, second, { recursive: true });
  const host = await createHost(join(dir, 'storage'), dir, '0.6.0', {}, () => {}, () => {});
  const identity = new IdentityStore(join(host.userDataPath(), 'identity.db'));
  const stores = createLocalStores(host);
  const roots = [first, second].map((root) => new Workspace(root, identity, { trash: host.trash }));
  for (const root of roots) await root.load();
  const services = roots.map((root) => createRequestServices(host, root, stores));
  try {
    for (let i = 0; i < roots.length; i++) {
      const id = roots[i].collectionIdOf([...roots[i].liveRequestIds()][0]);
      await services[i].handlers.invoke('env:set-active', id, 'local');
    }
    const firstId = roots[0].collectionIdOf([...roots[0].liveRequestIds()][0]);
    await services[0].handlers.invoke('env:set-active', firstId, null);
    await services[0].handlers.invoke('env:set-active', firstId, 'local');
    const saved = JSON.parse(await readFile(join(host.userDataPath(), 'local-environments.json'), 'utf8'));
    expect(Object.keys(saved.collections)).toHaveLength(2);
    expect(Object.values(saved.collections).map((c: any) => c.activeEnv)).toEqual(['local', 'local']);

    expect(services[0].runs.history).toBe(services[1].runs.history);
    await services[0].close();
    const secondId = [...roots[1].liveRequestIds()][0];
    expect(await services[1].handlers.invoke('history:list', secondId)).toEqual([]);
  } finally {
    await services[1].close();
    stores.close();
    identity.close();
  }
});

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const hits: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).includes(needle)) hits.push(path);
  }
  return hits;
}

it('manages environments, overrides, secrets and TLS through validated channels', async () => {
  const { keyCipher } = await import('./cipher');
  const { randomBytes } = await import('node:crypto');
  const { rm: remove } = await import('node:fs/promises');
  const trashed: string[] = [];
  const dialogs = [{ canceled: false, filePaths: [join(dir, 'ca.pem')] }, { canceled: true, filePaths: [] }];
  const host = await createHost(join(dir, 'storage'), dir, '0.9.0', {}, () => {}, () => {}, {
    cipher: keyCipher(randomBytes(32)),
    trash: async (path) => { trashed.push(path); await remove(path); },
    openDialog: async () => dialogs.shift()!
  });
  const identity = new IdentityStore(join(host.userDataPath(), 'identity.db'));
  const ws = new Workspace(join(dir, 'workspace'), identity, { trash: host.trash });
  await ws.load();
  const stores = createLocalStores(host);
  const hooks = { onSave: vi.fn(), onEnvChange: vi.fn() };
  const services = createRequestServices(host, ws, stores, hooks);
  const invoke = (channel: string, ...args: unknown[]) => services.handlers.invoke(channel, ...args) as Promise<any>;
  try {
    const collectionId = ws.collectionIdOf([...ws.liveRequestIds()][0]);
    const secret = 'synthetic-secret-value-7f3a';

    let list = await invoke('env:save', collectionId, null, { name: 'staging', variables: [
      { name: 'baseUrl', value: 'https://api.example.test', secret: false, enabled: true },
      { name: 'apiKey', value: '', secret: true, enabled: true }
    ] });
    expect(list.environments.map((e: any) => e.name).sort()).toEqual(['local', 'staging']);
    expect(hooks.onSave).toHaveBeenCalled();
    expect(hooks.onEnvChange).toHaveBeenCalled();

    list = await invoke('env:set-secret', collectionId, 'staging', 'apiKey', secret);
    expect(list.environments.find((e: any) => e.name === 'staging').variables.find((v: any) => v.name === 'apiKey').hasSecret).toBe(true);
    expect(await invoke('env:reveal-secret', collectionId, 'staging', 'apiKey')).toBe(secret);
    list = await invoke('env:set-override', collectionId, 'staging', 'baseUrl', 'http://127.0.0.1:4010');
    expect(list.environments.find((e: any) => e.name === 'staging').variables.find((v: any) => v.name === 'baseUrl').override).toBe('http://127.0.0.1:4010');
    list = await invoke('env:set-tls', collectionId, 'staging', { skipVerify: true, caFile: '' });
    expect(list.environments.find((e: any) => e.name === 'staging').tls).toEqual({ skipVerify: true, caFile: '' });
    list = await invoke('env:store-as-secret', collectionId, 'local', 'clientId', 'synthetic-client-id-9c1d');
    expect(list.environments.find((e: any) => e.name === 'local').variables.find((v: any) => v.name === 'clientId')).toMatchObject({ secret: true, value: '', hasSecret: true });
    await invoke('env:clear-runtime', collectionId, 'staging');

    // Secret values never reach the workspace, and the local store holds them only encrypted.
    for (const value of [secret, 'synthetic-client-id-9c1d']) {
      expect(await filesContaining(join(dir, 'workspace'), value)).toEqual([]);
      expect(await filesContaining(join(dir, 'storage'), value)).toEqual([]);
    }

    expect(await invoke('env:pick-ca-file')).toBe(join(dir, 'ca.pem'));
    expect(await invoke('env:pick-ca-file')).toBeNull();

    list = await invoke('env:save', collectionId, 'staging', { name: 'production', variables: [] });
    expect(list.environments.map((e: any) => e.name).sort()).toEqual(['local', 'production']);
    list = await invoke('env:remove', collectionId, 'production');
    expect(list.environments.map((e: any) => e.name)).toEqual(['local']);
    expect(trashed).toHaveLength(1);

    await expect(invoke('env:set-secret', collectionId, 'missing', 'apiKey', 'x')).rejects.toThrow('Environment not found');
    await expect(invoke('env:save', collectionId, 'missing', { name: 'x', variables: [] })).rejects.toThrow('Environment not found');
    await expect(invoke('env:save', collectionId, null, { name: 'x', variables: [{ name: 'a' }] })).rejects.toThrow('Invalid environment');
    await expect(invoke('env:set-tls', collectionId, 'local', { skipVerify: 'yes', caFile: '' })).rejects.toThrow('Invalid TLS settings');
    await expect(invoke('env:set-override', collectionId, 'local', 'baseUrl', 1)).rejects.toThrow('Expected a string');
    await expect(invoke('env:remove', collectionId)).rejects.toThrow('Invalid argument count');
  } finally {
    await services.close();
    stores.close();
    identity.close();
  }
});
