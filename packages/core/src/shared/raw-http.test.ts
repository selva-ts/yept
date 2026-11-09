import { describe, expect, it } from 'vitest';
import { maskSetCookie, rawRequestHead, rawResponseHead } from './raw-http';

describe('raw HTTP view', () => {
  it('writes the request line in origin form, with the recorded headers in order', () => {
    const raw = rawRequestHead({
      method: 'POST',
      url: 'https://api.example.test:8443/v1/bookings?page=2&q=a%20b',
      headers: [['Host', 'api.example.test:8443'], ['Content-Type', 'application/json'], ['Authorization', '••••••']],
      httpVersion: '1.1'
    });
    expect(raw).toBe(['POST /v1/bookings?page=2&q=a%20b HTTP/1.1', 'Host: api.example.test:8443', 'Content-Type: application/json', 'Authorization: ••••••'].join('\n'));
  });

  it('adds Host from the URL when the recorded headers lack it, and defaults to HTTP/1.1', () => {
    expect(rawRequestHead({ method: 'GET', url: 'http://api.example.test/', headers: [['Accept', '*/*']] })).toBe('GET / HTTP/1.1\nHost: api.example.test\nAccept: */*');
  });

  it('keeps an unparseable URL (a request that was never sent) as it is', () => {
    expect(rawRequestHead({ method: 'GET', url: '{{baseUrl}}/x', headers: [] })).toBe('GET {{baseUrl}}/x HTTP/1.1');
  });

  it('writes the status line and masks Set-Cookie values unless asked', () => {
    const r = { status: 302, statusText: 'Found', headers: [['Location', '/next'], ['Set-Cookie', 'sid=abc123; Path=/; HttpOnly'], ['set-cookie', 'flag']] as [string, string][], httpVersion: '1.1' };
    expect(rawResponseHead(r)).toBe(['HTTP/1.1 302 Found', 'Location: /next', 'Set-Cookie: sid=••••••; Path=/; HttpOnly', 'set-cookie: flag'].join('\n'));
    expect(rawResponseHead(r, { showCookies: true })).toContain('Set-Cookie: sid=abc123; Path=/; HttpOnly');
  });

  it('masks only the cookie value', () => {
    expect(maskSetCookie('a=b=c; Secure')).toBe('a=••••••; Secure');
    expect(maskSetCookie('token=xyz')).toBe('token=••••••');
    expect(maskSetCookie('empty=; Max-Age=0')).toBe('empty=••••••; Max-Age=0');
  });
});
