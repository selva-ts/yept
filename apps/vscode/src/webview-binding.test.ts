import { expect, it, vi } from 'vitest';
import { HandlerRegistry } from '@yept/core/shared/handler-registry';
import { IPC_ERROR_PREFIX, type HostEvents } from '@yept/core/shared/ipc';
import { bindWebview } from './webview-binding';

function setup(registry = new HandlerRegistry(), postMessage = async (message: unknown) => { posted.push(JSON.parse(JSON.stringify(message))); return true; }) {
  let listener: ((message: unknown) => unknown) | undefined;
  const subscription = { dispose: vi.fn(() => { listener = undefined; }) };
  const webview = { onDidReceiveMessage: (fn: (message: unknown) => unknown) => { listener = fn; return subscription; }, postMessage: vi.fn(postMessage) };
  const binding = bindWebview(webview, registry);
  const receive = async (message: unknown): Promise<void> => { await listener?.(message); };
  return { binding, webview, subscription, receive };
}
let posted: unknown[] = [];

function registry(): HandlerRegistry {
  const handlers = new HandlerRegistry();
  handlers.register('example:add', (a: number, b: number) => a + b);
  handlers.register('example:void', async () => undefined);
  handlers.register('example:args', (...args: unknown[]) => ({ count: args.length, args }));
  handlers.register('example:failure', () => { throw new Error('Synthetic failure'); });
  handlers.register('example:string-failure', () => { throw 'Synthetic failure'; });
  handlers.register('example:path-failure', () => { const e = new Error('Not found'); e.stack = 'Error: Not found\n    at handler (C:\\example\\file.ts:1:1)'; throw e; });
  return handlers;
}

it('answers a request with its result, by id', async () => {
  posted = [];
  const { receive } = setup(registry());
  await receive({ id: 'a1', channel: 'example:add', args: [2, 3] });
  await receive({ id: 7, channel: 'example:void', args: [] });
  expect(posted).toEqual([{ id: 'a1', result: 5 }, { id: 7 }]);
});

it('passes arguments as received, so an omitted one stays omitted', async () => {
  posted = [];
  const { receive } = setup(registry());
  await receive({ id: 1, channel: 'example:args', args: ['c1'] });
  expect(posted).toEqual([{ id: 1, result: { count: 1, args: ['c1'] } }]);
});

it.each([['example:failure'], ['example:string-failure']])('maps a thrown error from %s to the prefixed message', async (channel) => {
  posted = [];
  const { receive } = setup(registry());
  await receive({ id: 1, channel, args: [] });
  expect(posted).toEqual([{ id: 1, error: `${IPC_ERROR_PREFIX}Synthetic failure` }]);
});

it('sends the error message without its stack or paths', async () => {
  posted = [];
  const { receive } = setup(registry());
  await receive({ id: 1, channel: 'example:path-failure', args: [] });
  expect(posted).toEqual([{ id: 1, error: `${IPC_ERROR_PREFIX}Not found` }]);
});

it.each(['example:unknown', 'constructor', 'toString'])('answers unknown channel %s with an error and runs nothing', async (channel) => {
  posted = [];
  const handlers = registry();
  const invoke = vi.spyOn(handlers, 'invoke');
  const { receive } = setup(handlers);
  await receive({ id: 'u1', channel, args: [] });
  expect(posted).toEqual([{ id: 'u1', error: `${IPC_ERROR_PREFIX}Unknown channel: ${channel}` }]);
  expect(invoke).not.toHaveBeenCalled();
});

it('only answers channels registered when it was bound', async () => {
  posted = [];
  const handlers = registry();
  const { receive } = setup(handlers);
  handlers.register('example:late', () => 'late');
  await receive({ id: 1, channel: 'example:late', args: [] });
  expect(posted).toEqual([{ id: 1, error: `${IPC_ERROR_PREFIX}Unknown channel: example:late` }]);
});

it('ignores malformed messages without replying', async () => {
  posted = [];
  const handlers = registry();
  const invoke = vi.spyOn(handlers, 'invoke');
  const { receive } = setup(handlers);
  for (const message of [null, 'example:add', [], { id: 1, channel: 'example:add' }, { id: null, channel: 'example:add', args: [] }, { channel: 'example:add', args: [1, 2] }, { observed: 'status' }]) await receive(message);
  expect(posted).toEqual([]);
  expect(invoke).not.toHaveBeenCalled();
});

it('settles the call with an error when the result cannot be serialised', async () => {
  posted = [];
  const handlers = new HandlerRegistry();
  handlers.register('example:bigint', () => 1n);
  const { receive, webview } = setup(handlers);
  await receive({ id: 1, channel: 'example:bigint', args: [] });
  expect(webview.postMessage).toHaveBeenCalledTimes(2);
  expect(posted).toEqual([{ id: 1, error: expect.stringMatching(new RegExp(`^${IPC_ERROR_PREFIX}.*BigInt`)) }]);
});

it('pushes events in the host event map only', async () => {
  posted = [];
  const { binding } = setup(registry());
  const event = { runnerId: 'r1', type: 'done' } as unknown as HostEvents['runner:event'];
  binding.emit('runner:event', event);
  (binding.emit as (channel: string, event: unknown) => void)('app:unlisted', { secret: 'value' });
  await Promise.resolve();
  expect(posted).toEqual([{ event: 'runner:event', payload: event }]);
});

it('stops listening and sending when disposed', async () => {
  posted = [];
  let finish: (value: number) => void = () => undefined;
  const handlers = new HandlerRegistry();
  handlers.register('example:slow', () => new Promise<number>((resolve) => { finish = resolve; }));
  const { binding, subscription, receive } = setup(handlers);
  const pending = receive({ id: 1, channel: 'example:slow', args: [] });
  binding.dispose();
  finish(1);
  await pending;
  binding.emit('runner:event', {} as HostEvents['runner:event']);
  expect(subscription.dispose).toHaveBeenCalledOnce();
  expect(posted).toEqual([]);
});
