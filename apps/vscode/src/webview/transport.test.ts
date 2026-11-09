import { afterEach, expect, it, vi } from 'vitest';
import { createApi } from '@yept/core/shared/create-api';
import { IPC_ERROR_PREFIX } from '@yept/core/shared/ipc';
import type { RequestMessage } from '@yept/core/shared/webview-protocol';
import { createWebviewTransport } from './transport';

afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
  const sent: RequestMessage[] = [];
  let deliver: (event: MessageEvent) => void = () => undefined;
  // Each message goes through JSON, as VS Code sends it.
  const host = { postMessage: (message: unknown) => { sent.push(JSON.parse(JSON.stringify(message))); } };
  const source = { addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => { deliver = listener; } };
  const { invoke, subscribe } = createWebviewTransport(host, source);
  const receive = (data: unknown): void => deliver({ data: JSON.parse(JSON.stringify(data)) } as MessageEvent);
  return { api: createApi(invoke, subscribe), invoke, sent, receive };
}

it('sends requests with distinct ids and settles each by its own reply', async () => {
  const { api, sent, receive } = setup();
  const versions = api.versions();
  const list = api.cookies.list('c1');
  expect(sent).toEqual([{ id: 1, channel: 'app:versions', args: [] }, { id: 2, channel: 'cookies:list', args: ['c1'] }]);
  receive({ id: 2, result: { collectionId: 'c1' } });
  receive({ id: 1, result: { app: '0.0.0-test' } });
  await expect(list).resolves.toEqual({ collectionId: 'c1' });
  await expect(versions).resolves.toEqual({ app: '0.0.0-test' });
});

it('resolves undefined when JSON dropped a void result', async () => {
  const { api, receive } = setup();
  const write = api.clipboard.write('text');
  receive({ id: 1, result: undefined });
  await expect(write).resolves.toBeUndefined();
});

it('ignores replies to unknown or settled ids and messages that are not replies', async () => {
  const { api, receive } = setup();
  const versions = api.versions();
  for (const data of [null, 'text', 3, [], { id: 99, result: 'other' }, { result: 'no id' }, { id: '1', result: 'string id' }]) receive(data);
  receive({ id: 1, result: { app: 'first' } });
  receive({ id: 1, error: `${IPC_ERROR_PREFIX}late` });
  await expect(versions).resolves.toEqual({ app: 'first' });
});

it('rejects with the host message, which the UI helper turns into the desktop text', async () => {
  vi.stubGlobal('window', {});
  const { errorMessage } = await import('@yept/ui/api');
  const { api, receive } = setup();
  const failed = api.requests.get('missing');
  receive({ id: 1, error: `${IPC_ERROR_PREFIX}Request not found` });
  const error = await failed.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(`${IPC_ERROR_PREFIX}Request not found`);
  const desktop = new Error(`Error invoking remote method 'requests:get': Error: ${IPC_ERROR_PREFIX}Request not found`);
  expect(errorMessage(error)).toBe('Request not found');
  expect(errorMessage(error)).toBe(errorMessage(desktop));
});

it('rejects without leaving the call pending when the message cannot be posted', async () => {
  const { invoke } = createWebviewTransport({ postMessage: () => { throw new Error('could not be cloned'); } }, { addEventListener: () => undefined });
  await expect(invoke('app:versions')).rejects.toThrow('could not be cloned');
});

it.each([
  ['cookies.clear', (api: ReturnType<typeof setup>['api']) => api.cookies.clear('c1'), ['c1']],
  ['git.commit', (api: ReturnType<typeof setup>['api']) => api.git.commit('root', [], 'message'), ['root', [], 'message']],
  ['cookies.upsert', (api: ReturnType<typeof setup>['api']) => api.cookies.upsert('c1', { name: 'a' } as never), ['c1', { name: 'a' }]]
])('keeps an omitted optional argument omitted for %s', (_name, call, args) => {
  const { api, sent } = setup();
  void call(api);
  expect(sent[0].args).toEqual(args);
  expect(sent[0].args).not.toContain(null);
});

it('sends a given optional argument', () => {
  const { api, sent } = setup();
  void api.cookies.clear('c1', 'api.example.test');
  void api.git.commit('root', [], 'message', 'collection.yml');
  expect(sent.map((m) => m.args)).toEqual([['c1', 'api.example.test'], ['root', [], 'message', 'collection.yml']]);
});

it('delivers events to subscribers of that channel only, until they unsubscribe', () => {
  const { api, receive } = setup();
  const runner = vi.fn();
  const runnerTwice = vi.fn();
  const external = vi.fn();
  const stop = api.runner.onEvent(runner);
  api.runner.onEvent(runnerTwice);
  api.workspace.onExternalChange(external);
  receive({ event: 'runner:event', payload: { runnerId: 'r1', type: 'done' } });
  expect(runner).toHaveBeenCalledExactlyOnceWith({ runnerId: 'r1', type: 'done' });
  expect(runnerTwice).toHaveBeenCalledOnce();
  expect(external).not.toHaveBeenCalled();
  stop();
  receive({ event: 'runner:event', payload: { runnerId: 'r1', type: 'done' } });
  receive({ event: 'app:unlisted', payload: {} });
  receive({ event: 'workspace:external-change', payload: { changedRequestIds: [] } });
  expect(runner).toHaveBeenCalledOnce();
  expect(runnerTwice).toHaveBeenCalledTimes(2);
  expect(external).toHaveBeenCalledExactlyOnceWith({ changedRequestIds: [] });
});
