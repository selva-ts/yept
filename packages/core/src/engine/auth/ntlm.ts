// NTLM over HTTP (MS-NLMP), NTLMv2 responses only. The three messages:
//   NEGOTIATE (type 1) -> server answers 401 with CHALLENGE (type 2) -> AUTHENTICATE (type 3) on the same connection.
// No signing or sealing: HTTP auth only needs the client to prove it knows the password.
import { createHmac, randomBytes } from 'node:crypto';
import { md4 } from './md4';

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');

const FLAGS = {
  UNICODE: 0x00000001,
  OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  NTLM: 0x00000200,
  ALWAYS_SIGN: 0x00008000,
  EXTENDED_SESSION_SECURITY: 0x00080000,
  TARGET_INFO: 0x00800000,
  NEGOTIATE_128: 0x20000000,
  KEY_EXCH: 0x40000000,
  NEGOTIATE_56: 0x80000000
};

const NEGOTIATE_FLAGS =
  FLAGS.UNICODE | FLAGS.OEM | FLAGS.REQUEST_TARGET | FLAGS.NTLM | FLAGS.ALWAYS_SIGN | FLAGS.EXTENDED_SESSION_SECURITY | FLAGS.NEGOTIATE_128 | FLAGS.NEGOTIATE_56;

/** MsvAvTimestamp in the target info: when present, the server's time is used and the LMv2 response is left empty. */
const AV_TIMESTAMP = 7;

export class NtlmError extends Error {}

const hmacMd5 = (key: Buffer, ...data: Buffer[]): Buffer => {
  const h = createHmac('md5', key);
  for (const d of data) h.update(d);
  return h.digest();
};
const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le');

/** The NEGOTIATE message, base64, for `Authorization: NTLM <message>`. */
export function negotiateMessage(): string {
  const m = Buffer.alloc(32);
  SIGNATURE.copy(m, 0);
  m.writeUInt32LE(1, 8);
  m.writeUInt32LE(NEGOTIATE_FLAGS >>> 0, 12);
  // Domain and workstation fields (offset 16 and 24) stay empty.
  return m.toString('base64');
}

export interface Challenge {
  flags: number;
  serverChallenge: Buffer;
  targetInfo: Buffer;
}

export function parseChallenge(base64: string): Challenge {
  const m = Buffer.from(base64, 'base64');
  if (m.length < 32 || !m.subarray(0, 8).equals(SIGNATURE) || m.readUInt32LE(8) !== 2) throw new NtlmError('The server sent an NTLM challenge Yept could not read');
  const flags = m.readUInt32LE(20);
  let targetInfo = Buffer.alloc(0);
  if (flags & FLAGS.TARGET_INFO && m.length >= 48) {
    const len = m.readUInt16LE(40);
    const offset = m.readUInt32LE(44);
    if (offset + len > m.length) throw new NtlmError('The server sent an NTLM challenge Yept could not read');
    targetInfo = m.subarray(offset, offset + len);
  }
  return { flags, serverChallenge: m.subarray(24, 32), targetInfo };
}

/** NTOWFv2: the NTLMv2 key from the user name, domain and password. */
export function ntowfv2(username: string, password: string, domain: string): Buffer {
  return hmacMd5(md4(utf16(password)), utf16(username.toUpperCase() + domain));
}

function avTimestamp(targetInfo: Buffer): Buffer | undefined {
  for (let i = 0; i + 4 <= targetInfo.length; ) {
    const id = targetInfo.readUInt16LE(i);
    const len = targetInfo.readUInt16LE(i + 2);
    if (id === 0) return undefined;
    if (id === AV_TIMESTAMP && len === 8) return targetInfo.subarray(i + 4, i + 12);
    i += 4 + len;
  }
  return undefined;
}

/** Now as a Windows FILETIME (100 ns steps since 1601), little-endian. */
function fileTime(now: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE((BigInt(now) + 11644473600000n) * 10000n);
  return b;
}

/** The NTLMv2 and LMv2 responses (MS-NLMP 3.3.2). */
export function ntlmv2Responses(key: Buffer, serverChallenge: Buffer, clientChallenge: Buffer, time: Buffer, targetInfo: Buffer): { nt: Buffer; lm: Buffer; ntProof: Buffer } {
  const temp = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), time, clientChallenge, Buffer.alloc(4), targetInfo, Buffer.alloc(4)]);
  const ntProof = hmacMd5(key, serverChallenge, temp);
  const lm = Buffer.concat([hmacMd5(key, serverChallenge, clientChallenge), clientChallenge]);
  return { nt: Buffer.concat([ntProof, temp]), lm, ntProof };
}

export interface NtlmCredentials {
  username: string;
  password: string;
  domain: string;
  workstation?: string;
}

/** `DOMAIN\user` in the user name works too when the domain field is empty. */
export function splitDomain(c: NtlmCredentials): NtlmCredentials {
  const m = /^([^\\]+)\\(.+)$/.exec(c.username);
  return !c.domain && m ? { ...c, domain: m[1], username: m[2] } : c;
}

/** The AUTHENTICATE message, base64, answering the server's CHALLENGE message. */
export function authenticateMessage(challengeBase64: string, creds: NtlmCredentials, opts: { now?: number; clientChallenge?: Buffer } = {}): string {
  const ch = parseChallenge(challengeBase64);
  const c = splitDomain(creds);
  const serverTime = avTimestamp(ch.targetInfo);
  const clientChallenge = opts.clientChallenge ?? randomBytes(8);
  const r = ntlmv2Responses(ntowfv2(c.username, c.password, c.domain), ch.serverChallenge, clientChallenge, serverTime ?? fileTime(opts.now ?? Date.now()), ch.targetInfo);
  // With a server timestamp the LMv2 response must be zeros (MS-NLMP 3.1.5.1.2).
  const lm = serverTime ? Buffer.alloc(24) : r.lm;
  const unicode = !!(ch.flags & FLAGS.UNICODE);
  const text = (s: string): Buffer => (unicode ? utf16(s) : Buffer.from(s, 'latin1'));
  const fields = [lm, r.nt, text(c.domain), text(c.username), text(c.workstation ?? ''), Buffer.alloc(0)];
  const head = Buffer.alloc(64);
  SIGNATURE.copy(head, 0);
  head.writeUInt32LE(3, 8);
  let offset = head.length;
  fields.forEach((f, i) => {
    const at = 12 + i * 8;
    head.writeUInt16LE(f.length, at);
    head.writeUInt16LE(f.length, at + 2);
    head.writeUInt32LE(offset, at + 4);
    offset += f.length;
  });
  // The server's flags, without key exchange: no session key is sent.
  head.writeUInt32LE((ch.flags & ~FLAGS.KEY_EXCH) >>> 0, 60);
  return Buffer.concat([head, ...fields]).toString('base64');
}

/** The NTLM challenge in a 401's WWW-Authenticate header(s), or null when there is none. */
export function ntlmChallengeFrom(wwwAuthenticate: string): string | null {
  const m = /(?:^|,)\s*NTLM\s+([A-Za-z0-9+/]+=*)/i.exec(wwwAuthenticate);
  return m ? m[1] : null;
}
