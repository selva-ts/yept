import { describe, expect, it } from 'vitest';
import { DigestError, digestAuthorization, parseDigestChallenges, pickChallenge } from './digest';

describe('Digest auth', () => {
  it('matches the RFC 2617 example (MD5, qop=auth)', () => {
    const [c] = parseDigestChallenges('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    const h = digestAuthorization(c, { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: '0a4f113b' });
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain('qop=auth, nc=00000001, cnonce="0a4f113b"');
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('matches the RFC 7616 examples (SHA-256 and MD5)', () => {
    const header =
      'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS", ' +
      'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"';
    const all = parseDigestChallenges(header);
    expect(all.map((c) => c.algorithm)).toEqual(['SHA-256', 'MD5']);
    const input = { username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ' };
    expect(pickChallenge(all).algorithm).toBe('SHA-256');
    expect(digestAuthorization(all[0], input)).toContain('response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"');
    expect(digestAuthorization(all[1], input)).toContain('response="8ca523f5e9506fed4657c9700eebdbec"');
  });

  it('answers servers without qop, -sess algorithms and userhash', () => {
    const [legacy] = parseDigestChallenges('Digest realm="r", nonce="n"');
    expect(legacy.qop).toEqual([]);
    const h = digestAuthorization(legacy, { username: 'u', password: 'p', method: 'GET', uri: '/' });
    expect(h).not.toContain('qop=');
    expect(h).not.toContain('cnonce');
    const [sess] = parseDigestChallenges('Digest realm="r", nonce="n", qop="auth", algorithm=MD5-sess, userhash=true');
    const s = digestAuthorization(sess, { username: 'u', password: 'p', method: 'GET', uri: '/', cnonce: 'c' });
    expect(s).toContain('algorithm=MD5-SESS');
    expect(s).toContain('userhash=true');
    expect(s).not.toContain('username="u"');
  });

  it('finds the Digest challenge among other schemes and explains what it cannot answer', () => {
    expect(parseDigestChallenges('Basic realm="x", Digest realm="y", nonce="z", qop="auth"')).toMatchObject([{ realm: 'y', nonce: 'z', qop: ['auth'] }]);
    expect(parseDigestChallenges('Bearer realm="x"')).toEqual([]);
    expect(() => pickChallenge(parseDigestChallenges('Digest realm="r", nonce="n", qop="auth-int"'))).toThrow(DigestError);
    expect(() => pickChallenge(parseDigestChallenges('Digest realm="r", nonce="n", algorithm=SHA-1'))).toThrow(/SHA-1/);
  });
});
