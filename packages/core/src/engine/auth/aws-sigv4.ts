// AWS Signature Version 4, header-based. Signs the final request (method, path, query, headers, body hash)
// right before it is sent. Checked against the published AWS SigV4 test suite (aws-sigv4.test.ts).
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

export interface SigV4Request {
  method: string;
  /** Path as it goes on the wire, percent-encoded, e.g. '/a%20b'. */
  path: string;
  /** Query as it goes on the wire, without the '?'. */
  query: string;
  /** The headers that will be sent, Host included. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body. */
  bodyHash: string;
}

export interface SigV4Result {
  /** Headers to add: X-Amz-Date, X-Amz-Security-Token and X-Amz-Content-Sha256 when they apply, and Authorization. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** Headers that change on the way or are set by the client stack; signing them would break the signature. */
const UNSIGNED = new Set(['authorization', 'connection', 'user-agent', 'expect', 'range', 'x-amzn-trace-id', 'presigned-expires']);

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding: everything but A-Z a-z 0-9 - _ . ~ */
const encode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** S3 signs the path once; other services sign the encoded path, so each segment is encoded again. */
function canonicalPath(path: string, service: string): string {
  const p = path || '/';
  const segments = p.split('/');
  return service === 's3' ? segments.map((s) => encode(decode(s))).join('/') : segments.map(encode).join('/');
}

function canonicalQuery(query: string): string {
  const pairs = query
    .split('&')
    .filter(Boolean)
    .map((part): [string, string] => {
      const i = part.indexOf('=');
      const [k, v] = i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)];
      return [encode(decode(k.replace(/\+/g, ' '))), encode(decode(v.replace(/\+/g, ' ')))];
    });
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** 20150830T123600Z */
const amzDate = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function signV4(req: SigV4Request, creds: SigV4Credentials, opts: { now?: Date; signBody?: boolean } = {}): SigV4Result {
  const date = amzDate(opts.now ?? new Date());
  const day = date.slice(0, 8);
  const added: Record<string, string> = { 'X-Amz-Date': date };
  if (creds.sessionToken) added['X-Amz-Security-Token'] = creds.sessionToken;
  if (opts.signBody) added['X-Amz-Content-Sha256'] = req.bodyHash;

  const byName = new Map<string, string[]>();
  for (const [k, v] of Object.entries({ ...req.headers, ...added })) {
    const name = k.toLowerCase();
    if (UNSIGNED.has(name)) continue;
    byName.set(name, [...(byName.get(name) ?? []), v.trim().replace(/\s+/g, ' ')]);
  }
  const names = [...byName.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalPath(req.path, creds.service),
    canonicalQuery(req.query),
    names.map((n) => `${n}:${byName.get(n)!.join(',')}\n`).join(''),
    signedHeaders,
    req.bodyHash
  ].join('\n');
  const scope = `${day}/${creds.region}/${creds.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), creds.region), creds.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  added.Authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: added, canonicalRequest, stringToSign, signature };
}

/** Signs a request about to be sent to `url`; returns the headers to add. S3 also gets X-Amz-Content-Sha256. */
export function signRequest(r: { method: string; url: string; headers: Record<string, string>; bodyHash: string }, creds: SigV4Credentials, now?: Date): Record<string, string> {
  const u = new URL(r.url);
  // Node sends Host as the URL's host (with the port when it isn't the default), like URL.host.
  const headers = Object.keys(r.headers).some((k) => k.toLowerCase() === 'host') ? r.headers : { Host: u.host, ...r.headers };
  return signV4({ method: r.method, path: u.pathname, query: u.search.slice(1), headers, bodyHash: r.bodyHash }, creds, { now, signBody: creds.service === 's3' }).headers;
}
