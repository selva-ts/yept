// MD4 against RFC 1320's test suite, NTLMv2 against the example values in MS-NLMP section 4.2.4.
import { describe, expect, it } from 'vitest';
import { md4 } from './md4';
import { authenticateMessage, negotiateMessage, ntlmChallengeFrom, ntlmv2Responses, ntowfv2, parseChallenge, splitDomain } from './ntlm';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('MD4 (RFC 1320)', () => {
  it.each([
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '043f8582f241db351ce627e153e7f0e4'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', 'e33b4ddc9c38f2199c3e7b164fcc0536']
  ])('md4(%j)', (input, digest) => {
    expect(md4(Buffer.from(input, 'latin1')).toString('hex')).toBe(digest);
  });
});

describe('NTLMv2 (MS-NLMP 4.2.4)', () => {
  // User "User", domain "Domain", password "Password"; the challenge's target info names domain "Domain" and server "Server".
  const serverChallenge = hex('0123456789abcdef');
  const clientChallenge = hex('aaaaaaaaaaaaaaaa');
  const time = Buffer.alloc(8);
  const targetInfo = hex('02000c0044006f006d00610069006e0001000c005300650072007600650072000000 0000');

  it('NTOWFv2', () => {
    expect(md4(Buffer.from('Password', 'utf16le')).toString('hex')).toBe('a4f49c406510bdcab6824ee7c30fd852');
    expect(ntowfv2('User', 'Password', 'Domain').toString('hex')).toBe('0c868a403bfd7a93a3001ef22ef02e3f');
  });

  it('NTLMv2 and LMv2 responses', () => {
    const r = ntlmv2Responses(ntowfv2('User', 'Password', 'Domain'), serverChallenge, clientChallenge, time, targetInfo);
    expect(r.ntProof.toString('hex')).toBe('68cd0ab851e51c96aabc927bebef6a1c');
    expect(r.lm.toString('hex')).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');
  });

  it('builds an AUTHENTICATE message that answers a CHALLENGE message', () => {
    const neg = Buffer.from(negotiateMessage(), 'base64');
    expect(neg.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0');
    expect(neg.readUInt32LE(8)).toBe(1);

    // A CHALLENGE message: unicode, target info, the server challenge above.
    const head = Buffer.alloc(48);
    head.write('NTLMSSP\0', 0, 'latin1');
    head.writeUInt32LE(2, 8);
    head.writeUInt32LE(0x40000000 | 0x00800000 | 0x00080000 | 0x00000201, 20);
    serverChallenge.copy(head, 24);
    head.writeUInt16LE(targetInfo.length, 40);
    head.writeUInt16LE(targetInfo.length, 42);
    head.writeUInt32LE(48, 44);
    const challenge = Buffer.concat([head, targetInfo]).toString('base64');
    expect(parseChallenge(challenge).targetInfo.equals(targetInfo)).toBe(true);

    const msg = Buffer.from(authenticateMessage(challenge, { username: 'User', password: 'Password', domain: 'Domain' }, { clientChallenge, now: Date.UTC(2015, 7, 30) }), 'base64');
    expect(msg.readUInt32LE(8)).toBe(3);
    const field = (at: number): Buffer => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at));
    expect(field(28).toString('utf16le')).toBe('Domain');
    expect(field(36).toString('utf16le')).toBe('User');
    const nt = field(20);
    // The proof covers the rest of the NT response; check it the way a server would.
    const expected = ntlmv2Responses(ntowfv2('User', 'Password', 'Domain'), serverChallenge, clientChallenge, nt.subarray(24, 32), targetInfo);
    expect(nt.equals(expected.nt)).toBe(true);
    expect(msg.readUInt32LE(60) & 0x40000000).toBe(0);
  });

  it('reads the challenge out of WWW-Authenticate and DOMAIN\\user names', () => {
    expect(ntlmChallengeFrom('Negotiate, NTLM TlRMTVNTUAACAAAA==')).toBe('TlRMTVNTUAACAAAA==');
    expect(ntlmChallengeFrom('NTLM')).toBeNull();
    expect(splitDomain({ username: 'CORP\\alex', password: 'p', domain: '' })).toMatchObject({ username: 'alex', domain: 'CORP' });
    expect(splitDomain({ username: 'CORP\\alex', password: 'p', domain: 'OTHER' })).toMatchObject({ username: 'CORP\\alex', domain: 'OTHER' });
  });
});
