import { expect, it } from 'vitest';
import { RecentCookies } from './recent-cookies';

it('reveals recorded values, including empty values, independently of later updates', () => {
  const cache = new RecentCookies(); const values = ['original', '']; cache.keep('run', values); values[0] = 'changed';
  expect(cache.reveal('run', 0)).toBe('original'); expect(cache.reveal('run', 1)).toBe('');
  for (const index of [-1, 1.5, 2, NaN]) expect(() => cache.reveal('run', index)).toThrow('not recorded');
});

it('evicts older sends and cannot recover values after clearing the session', () => {
  const cache = new RecentCookies(2); cache.keep('first', ['one']); cache.keep('second', ['two']); cache.keep('third', ['three']);
  expect(() => cache.reveal('first', 0)).toThrow('only kept');
  expect(cache.reveal('second', 0)).toBe('two'); cache.clear(); expect(() => cache.reveal('second', 0)).toThrow('only kept');
});
