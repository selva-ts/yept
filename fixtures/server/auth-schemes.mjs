// Fixture endpoints for Digest, NTLM and AWS Signature v4. Each checks the credentials on its own, with code that
// shares nothing with the app, so a test passing here means the app spoke the scheme correctly.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const DIGEST_USER = 'sample-user';
export const DIGEST_PASSWORD = 'sample-digest-pass';
export const NTLM_USER = 'sample-user';
export const NTLM_DOMAIN = 'SAMPLE';
export const NTLM_PASSWORD = 'sample-ntlm-pass';
/** MD4 of the UTF-16LE password: Node's OpenSSL has no MD4, so it's worked out once and kept here. */
const NTLM_PASSWORD_HASH = Buffer.from('ea5e6f6e2bde9fa2d8416c75b5958c7c', 'hex');
export const AWS_ACCESS_KEY_ID = 'AKIDSAMPLEFIXTURE';
export const AWS_SECRET_ACCESS_KEY = 'sample/aws/secret/key/for/fixture/only';

const json = (status, body, headers = {}) => ({ status, body, headers });

// ---------- Digest: /auth/digest?algorithm=MD5|SHA-256, qop=auth ----------

const digestNonces = new Set();

function parseDigest(header) {
  const out = {};
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/([a-z]+)=(?:"([^"]*)"|([^,\s]*))/gi)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

function digest(req, url) {
  const algorithm = url.searchParams.get('algorithm') === 'SHA-256' ? 'SHA-256' : 'MD5';
  const H = (s) => createHash(algorithm === 'MD5' ? 'md5' : 'sha256').update(s).digest('hex');
  const challenge = () => {
    const nonce = randomBytes(12).toString('hex');
    digestNonces.add(nonce);
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Digest realm="fixture", qop="auth", algorithm=${algorithm}, nonce="${nonce}", opaque="fixture-opaque"` });
  };
  const auth = req.headers.authorization ?? '';
  if (!/^Digest /i.test(auth)) return challenge();
  const p = parseDigest(auth);
  if (!digestNonces.has(p.nonce) || p.username !== DIGEST_USER || p.qop !== 'auth' || p.opaque !== 'fixture-opaque' || p.uri !== req.url) return challenge();
  const ha1 = H(`${DIGEST_USER}:fixture:${DIGEST_PASSWORD}`);
  const ha2 = H(`${req.method}:${p.uri}`);
  if (p.response !== H(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`)) return challenge();
  return json(200, { authenticated: true, scheme: 'Digest', algorithm, user: p.username });
}

// ---------- NTLM: /auth/ntlm, the three messages on one connection ----------

const utf16 = (s) => Buffer.from(s, 'utf16le');

function ntlmChallenge(socket) {
  const serverChallenge = randomBytes(8);
  socket.ntlmChallenge = serverChallenge;
  const avPair = (id, value) => {
    const b = Buffer.alloc(4);
    b.writeUInt16LE(id, 0);
    b.writeUInt16LE(value.length, 2);
    return Buffer.concat([b, value]);
  };
  const targetInfo = Buffer.concat([avPair(2, utf16(NTLM_DOMAIN)), avPair(1, utf16('FIXTURE')), Buffer.alloc(4)]);
  const head = Buffer.alloc(48);
  head.write('NTLMSSP\0', 0, 'latin1');
  head.writeUInt32LE(2, 8);
  head.writeUInt32LE((0x00000001 | 0x00000200 | 0x00080000 | 0x00800000 | 0x20000000) >>> 0, 20);
  serverChallenge.copy(head, 24);
  head.writeUInt16LE(targetInfo.length, 40);
  head.writeUInt16LE(targetInfo.length, 42);
  head.writeUInt32LE(48, 44);
  return Buffer.concat([head, targetInfo]).toString('base64');
}

function ntlm(req) {
  const ask = (headerValue) => json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': headerValue, Connection: 'keep-alive' });
  const m = /^NTLM (.+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return ask('NTLM');
  const msg = Buffer.from(m[1], 'base64');
  if (msg.subarray(0, 8).toString('latin1') !== 'NTLMSSP\0') return ask('NTLM');
  const type = msg.readUInt32LE(8);
  if (type === 1) return ask(`NTLM ${ntlmChallenge(req.socket)}`);
  // An AUTHENTICATE message only counts on the connection that got the challenge.
  const serverChallenge = req.socket.ntlmChallenge;
  if (type !== 3 || !serverChallenge) return json(401, { error: 'no NTLM challenge on this connection' }, { 'WWW-Authenticate': 'NTLM' });
  const field = (at) => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at));
  const nt = field(20);
  const domain = field(28).toString('utf16le');
  const user = field(36).toString('utf16le');
  const key = createHmac('md5', NTLM_PASSWORD_HASH).update(utf16(user.toUpperCase() + domain)).digest();
  const proof = createHmac('md5', key).update(Buffer.concat([serverChallenge, nt.subarray(16)])).digest();
  if (user !== NTLM_USER || domain !== NTLM_DOMAIN || nt.length <= 16 || !proof.equals(nt.subarray(0, 16))) return json(401, { error: 'wrong NTLM credentials' }, { 'WWW-Authenticate': 'NTLM' });
  return json(200, { authenticated: true, scheme: 'NTLM', user: `${domain}\\${user}` });
}

// ---------- AWS Signature v4: /auth/aws/... with any method, query and body ----------

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function aws(req, raw) {
  const deny = (message) => json(403, { error: 'SignatureDoesNotMatch', message });
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? '');
  if (!m) return deny('No AWS Signature v4 Authorization header');
  const [, keyId, day, region, service, signed, signature] = m;
  if (keyId !== AWS_ACCESS_KEY_ID) return deny('Unknown access key');
  const date = req.headers['x-amz-date'] ?? '';
  if (!date.startsWith(day)) return deny('X-Amz-Date does not match the credential scope');
  const names = signed.split(';');
  if (!names.includes('host') || !names.includes('x-amz-date')) return deny('Host and X-Amz-Date must be signed');
  const [path, query = ''] = req.url.split('?');
  const canonicalQuery = query.split('&').filter(Boolean).map((p) => p.split('=')).map(([k, v = '']) => [rfc3986(decodeURIComponent(k.replace(/\+/g, ' '))), rfc3986(decodeURIComponent(v.replace(/\+/g, ' ')))]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalPath = path.split('/').map(rfc3986).join('/');
  const bodyHash = createHash('sha256').update(raw).digest('hex');
  const canonical = [req.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join(''), signed, bodyHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, `${day}/${region}/${service}/aws4_request`, createHash('sha256').update(canonical).digest('hex')].join('\n');
  let k = createHmac('sha256', `AWS4${AWS_SECRET_ACCESS_KEY}`).update(day).digest();
  for (const part of [region, service, 'aws4_request']) k = createHmac('sha256', k).update(part).digest();
  if (createHmac('sha256', k).update(toSign).digest('hex') !== signature) return deny('The request signature does not match');
  return json(200, { authenticated: true, scheme: 'AWS4-HMAC-SHA256', service, region, sessionToken: !!req.headers['x-amz-security-token'], bodyBytes: raw.length });
}

/** The response for an auth-scheme route, or null when the path isn't one of them. */
export function authSchemeRoute(req, url, raw) {
  if (url.pathname === '/auth/digest') return digest(req, url);
  if (url.pathname === '/auth/ntlm') return ntlm(req);
  if (url.pathname.startsWith('/auth/aws/')) return aws(req, raw);
  return null;
}
