import { expect, it } from 'vitest';
import { IPC_ERROR_PREFIX } from './ipc';
import { checkRequest, requestMessage } from './webview-protocol';

const known = (channel: string): boolean => channel === 'example:known';

it.each([
  ['a string id', { id: 'a1', channel: 'example:known', args: [] }],
  ['a number id', { id: 7, channel: 'example:known', args: ['value', null, { nested: true }] }],
  ['a null-prototype object', Object.assign(Object.create(null), { id: 0, channel: 'example:known', args: [] })]
])('accepts a request with %s', (_name, message) => {
  expect(checkRequest(message, known)).toEqual({ request: { id: message.id, channel: 'example:known', args: message.args } });
});

it('keeps only the request fields', () => {
  expect(checkRequest({ id: 1, channel: 'example:known', args: [], extra: 'ignored' }, known)).toEqual({ request: { id: 1, channel: 'example:known', args: [] } });
});

it.each([
  ['undefined', undefined],
  ['null', null],
  ['a string', '{"id":1,"channel":"example:known","args":[]}'],
  ['a number', 1],
  ['an array', [1, 'example:known', []]],
  ['a class instance', new (class { id = 1; channel = 'example:known'; args = []; })()],
  ['a date', new Date(0)],
  ['a missing id', { channel: 'example:known', args: [] }],
  ['a null id', { id: null, channel: 'example:known', args: [] }],
  ['an object id', { id: {}, channel: 'example:known', args: [] }],
  ['a NaN id', { id: Number.NaN, channel: 'example:known', args: [] }],
  ['an infinite id', { id: Number.POSITIVE_INFINITY, channel: 'example:known', args: [] }],
  ['a missing channel', { id: 1, args: [] }],
  ['a number channel', { id: 1, channel: 3, args: [] }],
  ['missing args', { id: 1, channel: 'example:known' }],
  ['object args', { id: 1, channel: 'example:known', args: { 0: 'value', length: 1 } }],
  ['string args', { id: 1, channel: 'example:known', args: 'value' }],
  ['a response', { id: 1, result: 'value' }],
  ['an event', { event: 'runner:event', payload: {} }]
])('ignores a malformed message: %s', (_name, message) => {
  expect(checkRequest(message, known)).toBeNull();
});

it.each(['example:unknown', 'constructor', '__proto__', ''])('answers unknown channel "%s" with an error reply', (channel) => {
  expect(checkRequest({ id: 'a1', channel, args: [] }, known)).toEqual({ reply: { id: 'a1', error: `${IPC_ERROR_PREFIX}Unknown channel: ${channel}` } });
});

it('leaves trailing undefined arguments out so they arrive omitted', () => {
  expect(requestMessage(1, 'cookies:clear', ['c1', undefined])).toEqual({ id: 1, channel: 'cookies:clear', args: ['c1'] });
  expect(requestMessage(2, 'git:commit', ['root', [], 'message', undefined, undefined]).args).toEqual(['root', [], 'message']);
  expect(requestMessage(3, 'app:versions', [undefined]).args).toEqual([]);
  expect(JSON.parse(JSON.stringify(requestMessage(4, 'cookies:clear', ['c1', undefined]))).args).toEqual(['c1']);
});

it('keeps present arguments, null and earlier undefined ones in place', () => {
  expect(requestMessage(1, 'cookies:clear', ['c1', 'api.example.test']).args).toEqual(['c1', 'api.example.test']);
  expect(requestMessage(2, 'env:set-secret', ['c1', 'dev', 'token', null]).args).toEqual(['c1', 'dev', 'token', null]);
  expect(requestMessage(3, 'example:known', [undefined, 'last']).args).toEqual([undefined, 'last']);
});
