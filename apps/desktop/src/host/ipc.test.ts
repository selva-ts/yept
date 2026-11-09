import { beforeEach, expect, it, vi } from 'vitest';
import { IPC_ERROR_PREFIX } from '@yept/core/shared/ipc';
import { HandlerRegistry } from '@yept/core/shared/handler-registry';
import { bindIpc } from './ipc';

const { bound } = vi.hoisted(() => ({ bound: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => { bound.set(channel, fn); },
  removeHandler: (channel: string) => { bound.delete(channel); }
} }));
beforeEach(() => bound.clear());

it('binds only registered channels and passes arguments without the Electron event', async () => {
  const registry = new HandlerRegistry();
  registry.register('example:result', (value: string) => ({ value }));
  bindIpc(registry);
  expect([...bound.keys()]).toEqual(['example:result']);
  expect(await bound.get('example:result')!({ sender: 'synthetic' }, 'expected')).toEqual({ value: 'expected' });
});

it.each([new Error('Synthetic failure'), 'Synthetic failure'])('retains the readable error prefix for %s', async (failure) => {
  const registry = new HandlerRegistry();
  registry.register('example:failure', () => { throw failure; });
  bindIpc(registry);
  await expect(bound.get('example:failure')!(null)).rejects.toThrow(IPC_ERROR_PREFIX + 'Synthetic failure');
});

it('removes its bindings when detached', () => {
  const registry = new HandlerRegistry();
  registry.register('example:result', () => null);
  const detach = bindIpc(registry);
  detach();
  expect(bound.size).toBe(0);
});
