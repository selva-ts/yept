// HTTP Digest auth (RFC 7616, and RFC 2617 servers that send no qop). The server answers the first send with
// 401 and a challenge; the request is sent again with an Authorization header computed from it.
// Supported: qop "auth" (or none), MD5, SHA-256 and SHA-512-256, each with or without "-sess", and userhash.
import { createHash, randomBytes } from 'node:crypto';

export class DigestError extends Error {}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  /** Upper case, as sent; 'MD5' when the server names none. */
  algorithm: string;
  /** Offered qop values; empty for an RFC 2069 style challenge. */
  qop: string[];
  userhash: boolean;
}

const HASHES: Record<string, string> = { MD5: 'md5', 'SHA-256': 'sha256', 'SHA-512-256': 'sha512-256' };
/** The strongest first, when the server offers several challenges. */
const PREFERENCE = ['SHA-512-256', 'SHA-256', 'MD5'];

/** name=value or name="quoted value", one at a time, until something that isn't a parameter (the next scheme). */
const PARAM = /\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]*))\s*(?:,|$)/y;

/** Every Digest challenge in a WWW-Authenticate value (several headers arrive joined with ", "). */
export function parseDigestChallenges(header: string): DigestChallenge[] {
  const out: DigestChallenge[] = [];
  const start = /(?:^|,)\s*Digest\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = start.exec(header))) {
    const params: Record<string, string> = {};
    PARAM.lastIndex = m.index + m[0].length;
    let p: RegExpExecArray | null;
    while ((p = PARAM.exec(header))) {
      params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
      if (PARAM.lastIndex >= header.length) break;
    }
    if (params.nonce === undefined) continue;
    out.push({
      realm: params.realm ?? '',
      nonce: params.nonce,
      opaque: params.opaque,
      algorithm: (params.algorithm ?? 'MD5').toUpperCase(),
      qop: (params.qop ?? '').split(',').map((q) => q.trim().toLowerCase()).filter(Boolean),
      userhash: (params.userhash ?? '').toLowerCase() === 'true'
    });
  }
  return out;
}

/** The challenge Yept answers: the strongest one it supports. Throws a DigestError explaining why none works. */
export function pickChallenge(challenges: DigestChallenge[]): DigestChallenge {
  const usable = challenges.filter((c) => HASHES[c.algorithm.replace(/-SESS$/, '')] && (!c.qop.length || c.qop.includes('auth')));
  usable.sort((a, b) => PREFERENCE.indexOf(a.algorithm.replace(/-SESS$/, '')) - PREFERENCE.indexOf(b.algorithm.replace(/-SESS$/, '')));
  if (usable[0]) return usable[0];
  const c = challenges[0];
  if (!c) throw new DigestError('The server sent no Digest challenge');
  if (c.qop.length && !c.qop.includes('auth')) throw new DigestError(`The server asks for Digest qop "${c.qop.join(', ')}"; Yept supports "auth" only`);
  throw new DigestError(`The server asks for Digest algorithm ${c.algorithm}; Yept supports MD5, SHA-256 and SHA-512-256`);
}

const quote = (s: string): string => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;

export interface DigestInput {
  username: string;
  password: string;
  method: string;
  /** Path and query, as on the request line. */
  uri: string;
  /** Request count for this nonce: 1 for the first answer. */
  nc?: number;
  /** Fixed in tests; random otherwise. */
  cnonce?: string;
}

/** The Authorization header value answering `c`. */
export function digestAuthorization(c: DigestChallenge, input: DigestInput): string {
  const base = c.algorithm.replace(/-SESS$/, '');
  const sess = c.algorithm.endsWith('-SESS');
  const algo = HASHES[base];
  if (!algo) throw new DigestError(`Digest algorithm ${c.algorithm} isn't supported`);
  const H = (s: string): string => createHash(algo).update(s, 'utf8').digest('hex');
  const qop = c.qop.length ? 'auth' : undefined;
  const nc = (input.nc ?? 1).toString(16).padStart(8, '0');
  const cnonce = input.cnonce ?? randomBytes(16).toString('hex');
  let ha1 = H(`${input.username}:${c.realm}:${input.password}`);
  if (sess) ha1 = H(`${ha1}:${c.nonce}:${cnonce}`);
  const ha2 = H(`${input.method}:${input.uri}`);
  const response = qop ? H(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${c.nonce}:${ha2}`);
  const username = c.userhash ? H(`${input.username}:${c.realm}`) : input.username;
  const parts = [`username=${quote(username)}`, `realm=${quote(c.realm)}`, `nonce=${quote(c.nonce)}`, `uri=${quote(input.uri)}`, `algorithm=${c.algorithm}`, `response=${quote(response)}`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  if (c.opaque !== undefined) parts.push(`opaque=${quote(c.opaque)}`);
  if (c.userhash) parts.push('userhash=true');
  return `Digest ${parts.join(', ')}`;
}
