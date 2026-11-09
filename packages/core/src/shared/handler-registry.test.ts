import { expect, it } from 'vitest';
import { HandlerRegistry } from './handler-registry';

it('dispatches synchronous and asynchronous operations with their arguments and results', async () => {
  const registry = new HandlerRegistry();
  registry.register('example:add', (a: number, b: number) => a + b);
  registry.register('example:cancelled', async () => null);
  expect(await registry.invoke('example:add', 2, 3)).toBe(5);
  expect(await registry.invoke('example:cancelled')).toBeNull();
});

it.each(['missing', 'constructor', 'toString'])('rejects unregistered operation %s', async (channel) => {
  await expect(new HandlerRegistry().invoke(channel)).rejects.toThrow(`Unknown channel: ${channel}`);
});

it('refuses duplicate registration without replacing the existing operation', async () => {
  const registry = new HandlerRegistry();
  registry.register('example:value', () => 'original');
  expect(() => registry.register('example:value', () => 'replacement')).toThrow('Handler already registered');
  expect(await registry.invoke('example:value')).toBe('original');
});

it('preserves domain errors for the transport to format', async () => {
  const registry = new HandlerRegistry();
  const error = new Error('Synthetic operation failed');
  registry.register('example:failure', async () => { throw error; });
  await expect(registry.invoke('example:failure')).rejects.toBe(error);
});
