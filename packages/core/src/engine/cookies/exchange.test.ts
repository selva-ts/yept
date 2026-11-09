import { expect, it } from 'vitest';
import { captureCookies } from './exchange';
import { cookieMetadata } from '../../shared/run-cookies';

it('keeps cookie values separate from metadata, with duplicates and equals preserved', () => {
  const cookies = captureCookies([{ url: 'https://api.example.test/folder/endpoint',
    requestHeaders: [['cOoKiE', 'sid=abc==; empty=; sid=second; invalid']],
    responseHeaders: [['Set-Cookie', 'session=value==; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Wed, 21 Oct 2026 07:28:00 GMT'],
      ['Set-Cookie', 'other=two; Domain=example.test; Path=/custom']] }], 'request');
  expect(cookies.map((c) => c.value)).toEqual(['abc==', '', 'second', 'value==', 'two']);
  expect(cookies[0].metadata).toMatchObject({ hop: 0, direction: 'sent', source: 'request', name: 'sid' });
  expect(cookies[3].metadata).toMatchObject({ domain: 'api.example.test', path: '/folder', secure: true, httpOnly: true, sameSite: 'lax', maxAge: '0', expires: '2026-10-21T07:28:00.000Z' });
  expect(cookies[4].metadata).toMatchObject({ domain: 'example.test', path: '/custom' });
  expect(cookies[4].metadata.maxAge).toBeUndefined();
  expect(JSON.stringify(cookies.map((c) => c.metadata))).not.toContain('value==');
});

it('attributes cookies to each recorded hop, even when the first hop sent none', () => {
  const cookies = captureCookies([
    { url: 'https://api.example.test/redirect', requestHeaders: [], responseHeaders: [['set-cookie', 'hop=one; Path=/']] },
    { url: 'https://api.example.test/final', requestHeaders: [['Cookie', 'hop=one']], responseHeaders: [] }
  ], 'jar');
  expect(cookies.map((c) => c.metadata)).toMatchObject([{ hop: 0, direction: 'received', name: 'hop' }, { hop: 1, direction: 'sent', name: 'hop', source: 'jar' }]);
  expect(captureCookies([{ url: 'bad-url', requestHeaders: [], responseHeaders: [['set-cookie', 'invalid']] }], 'jar')).toEqual([]);
});

it('copies supported metadata only, dropping unexpected value fields and masking known secrets', () => {
  const captured = { hop: 0, direction: 'received' as const, name: 'secret-token', domain: 'api.example.test', value: 'must-not-escape' };
  const publicCookie = cookieMetadata(captured, (s) => s.replaceAll('secret-token', 'masked'));
  expect(publicCookie.name).toBe('masked');
  expect(JSON.stringify(publicCookie)).not.toContain('must-not-escape');
});
