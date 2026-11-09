// The raw HTTP view in Network: request and response heads as HTTP/1.x text, rebuilt from the recorded method, URL,
// status and headers. It is a reconstruction, not a capture: header case, order and line endings may differ from
// the bytes on the wire, and bodies are left out.

const MASK = '••••••';

/** "HTTP/1.1", from the recorded version ("1.1"); 1.1 when the connection didn't record one. */
const protocol = (httpVersion?: string): string => `HTTP/${httpVersion || '1.1'}`;

/** The request target as an HTTP/1.1 request line has it: path and query (origin form). */
function target(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname || '/'}${u.search}`;
  } catch {
    return url;
  }
}

export function rawRequestHead(r: { method: string; url: string; headers: [string, string][]; httpVersion?: string }): string {
  const hasHost = r.headers.some(([k]) => k.toLowerCase() === 'host');
  let host = '';
  try {
    host = new URL(r.url).host;
  } catch {
    /* not a full URL (a request that was never sent) */
  }
  const headers: [string, string][] = hasHost || !host ? r.headers : [['Host', host], ...r.headers];
  return [`${r.method} ${target(r.url)} ${protocol(r.httpVersion)}`, ...headers.map(([k, v]) => `${k}: ${v}`)].join('\n');
}

/** Hides a Set-Cookie value but keeps the cookie name and attributes: "sid=••••••; Path=/; HttpOnly". */
export function maskSetCookie(value: string): string {
  const semi = value.indexOf(';');
  const pair = semi < 0 ? value : value.slice(0, semi);
  const eq = pair.indexOf('=');
  return `${eq < 0 ? pair : `${pair.slice(0, eq)}=${MASK}`}${semi < 0 ? '' : value.slice(semi)}`;
}

export function rawResponseHead(r: { status?: number; statusText?: string; headers: [string, string][]; httpVersion?: string }, opts: { showCookies?: boolean } = {}): string {
  const status = [protocol(r.httpVersion), r.status ?? '', r.statusText ?? ''].filter((s) => s !== '').join(' ');
  return [status, ...r.headers.map(([k, v]) => `${k}: ${!opts.showCookies && k.toLowerCase() === 'set-cookie' ? maskSetCookie(v) : v}`)].join('\n');
}
