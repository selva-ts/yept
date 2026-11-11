import { expect, it, vi } from 'vitest';
import { createApi, type Subscribe } from './create-api';
import type { YeptApi } from './ipc';

// Method path, channel and number of arguments, as the desktop preload has always sent them.
const CHANNELS: [string, string, number][] = [
  ['versions', 'app:versions', 0],
  ['notices', 'app:notices', 0],
  ['selfTest', 'app:self-test', 0],
  ['workspace.pick', 'workspace:pick', 0],
  ['workspace.restore', 'workspace:restore', 0],
  ['workspace.createCollection', 'workspace:create-collection', 1],
  ['workspace.deleteCollection', 'workspace:delete-collection', 1],
  ['workspace.getViewMode', 'workspace:get-view-mode', 0],
  ['workspace.setViewMode', 'workspace:set-view-mode', 1],
  ['requests.get', 'requests:get', 1],
  ['requests.save', 'requests:save', 2],
  ['requests.create', 'requests:create', 2],
  ['requests.createFromCurl', 'requests:create-from-curl', 3],
  ['requests.createFolder', 'requests:create-folder', 2],
  ['requests.rename', 'requests:rename', 2],
  ['requests.move', 'requests:move', 2],
  ['requests.duplicate', 'requests:duplicate', 1],
  ['requests.remove', 'requests:remove', 1],
  ['requests.pickFiles', 'requests:pick-files', 1],
  ['settings.get', 'settings:get', 1],
  ['settings.save', 'settings:save', 2],
  ['env.list', 'env:list', 1],
  ['env.setActive', 'env:set-active', 2],
  ['env.save', 'env:save', 3],
  ['env.remove', 'env:remove', 2],
  ['env.setOverride', 'env:set-override', 4],
  ['env.setSecret', 'env:set-secret', 4],
  ['env.revealSecret', 'env:reveal-secret', 3],
  ['env.setTls', 'env:set-tls', 3],
  ['env.storeAsSecret', 'env:store-as-secret', 4],
  ['env.setRuntime', 'env:set-runtime', 4],
  ['env.clearRuntime', 'env:clear-runtime', 2],
  ['env.preview', 'env:preview', 2],
  ['env.pickCaFile', 'env:pick-ca-file', 0],
  ['env.setCertPassphrase', 'env:set-cert-passphrase', 4],
  ['env.pickCertFile', 'env:pick-cert-file', 1],
  ['history.list', 'history:list', 1],
  ['history.get', 'history:get', 1],
  ['history.remove', 'history:remove', 1],
  ['history.clear', 'history:clear', 1],
  ['history.orphans', 'history:orphans', 0],
  ['history.reattach', 'history:reattach', 2],
  ['history.export', 'history:export', 3],
  ['git.status', 'git:status', 0],
  ['git.diff', 'git:diff', 2],
  ['git.commit', 'git:commit', 4],
  ['git.push', 'git:push', 2],
  ['git.fetch', 'git:fetch', 1],
  ['git.pull', 'git:pull', 1],
  ['git.sync', 'git:sync', 1],
  ['git.switchBranch', 'git:switch', 2],
  ['git.createBranch', 'git:create-branch', 2],
  ['git.stage', 'git:stage', 2],
  ['git.unstage', 'git:unstage', 2],
  ['git.discard', 'git:discard', 2],
  ['importer.pick', 'import:pick', 0],
  ['importer.fromBru', 'import:from-bru', 1],
  ['importer.check', 'import:check', 2],
  ['importer.apply', 'import:apply', 4],
  ['importer.export', 'import:export', 2],
  ['appSettings.get', 'app-settings:get', 0],
  ['appSettings.set', 'app-settings:set', 1],
  ['appSettings.setAppearance', 'app-settings:set-appearance', 1],
  ['appSettings.setProxyPassword', 'app-settings:set-proxy-password', 1],
  ['runs.start', 'runs:start', 3],
  ['runs.cancel', 'runs:cancel', 1],
  ['runs.saveBody', 'runs:save-body', 2],
  ['runs.bodyBytes', 'runs:body-bytes', 1],
  ['runs.curlWithSecrets', 'runs:curl-with-secrets', 2],
  ['runs.rawWithSecrets', 'runs:raw-with-secrets', 1],
  ['runs.cookieValue', 'runs:cookie-value', 2],
  ['runner.start', 'runner:start', 3],
  ['runner.cancel', 'runner:cancel', 1],
  ['runner.pickDataFile', 'runner:pick-data-file', 0],
  ['runner.exportReport', 'runner:export-report', 2],
  ['oauth2.token', 'oauth2:token', 3],
  ['cookies.list', 'cookies:list', 1],
  ['cookies.upsert', 'cookies:upsert', 3],
  ['cookies.remove', 'cookies:remove', 2],
  ['cookies.clear', 'cookies:clear', 2],
  ['metrics', 'app:metrics', 0],
  ['clipboard.write', 'clipboard:write', 1]
];
const EVENTS: [string, string][] = [
  ['workspace.onExternalChange', 'workspace:external-change'],
  ['runner.onEvent', 'runner:event']
];

function setup() {
  const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => 'result');
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);
  const api = createApi(invoke, subscribe as unknown as Subscribe);
  return { api, invoke, subscribe, unsubscribe };
}

function methodAt(api: YeptApi, path: string): (...args: unknown[]) => unknown {
  return path.split('.').reduce<any>((value, key) => value[key], api);
}

function methodPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => typeof child === 'function' ? [prefix + key] : methodPaths(child, `${prefix}${key}.`));
}

it('covers every method of the API', () => {
  expect(methodPaths(setup().api).sort()).toEqual([...CHANNELS.map(([path]) => path), ...EVENTS.map(([path]) => path)].sort());
});

it.each(CHANNELS)('%s invokes %s with its arguments in order', async (path, channel, arity) => {
  const { api, invoke } = setup();
  const method = methodAt(api, path);
  expect(method.length).toBe(arity);
  const args = Array.from({ length: arity }, (_, i) => ({ argument: i }));
  await expect(method(...args)).resolves.toBe('result');
  expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, ...args);
});

it('passes an omitted optional argument through as undefined, as the desktop preload did', () => {
  const { api, invoke } = setup();
  void api.cookies.clear('c1');
  void api.git.commit('root', [], 'message');
  void api.cookies.upsert('c1', { name: 'a', value: 'b', domain: 'api.example.test', path: '/', secure: false, httpOnly: false, hostOnly: true } as never);
  void api.runs.curlWithSecrets('run-1');
  expect(invoke.mock.calls).toEqual([
    ['cookies:clear', 'c1', undefined],
    ['git:commit', 'root', [], 'message', undefined],
    ['cookies:upsert', 'c1', expect.objectContaining({ name: 'a' }), undefined],
    ['runs:curl-with-secrets', 'run-1', undefined]
  ]);
});

it.each(EVENTS)('%s subscribes to %s and returns its unsubscribe function', (path, channel) => {
  const { api, subscribe, unsubscribe } = setup();
  const cb = vi.fn();
  const stop = methodAt(api, path)(cb) as () => void;
  expect(subscribe).toHaveBeenCalledExactlyOnceWith(channel, cb);
  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
