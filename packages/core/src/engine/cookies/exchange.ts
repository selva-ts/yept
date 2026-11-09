import { Cookie, defaultPath } from 'tough-cookie';
import type { NetworkHop, RunCookie } from '../../shared/model';

export interface CapturedCookie { metadata: RunCookie; value: string }

/** Parse recorded wire headers, preserving duplicate names, redirects, '=' in values and Expires commas. */
export function captureCookies(hops: Pick<NetworkHop, 'url' | 'requestHeaders' | 'responseHeaders'>[], source: 'jar' | 'request'): CapturedCookie[] {
  const out: CapturedCookie[] = [];
  hops.forEach((hop, index) => {
    for (const [name, header] of hop.requestHeaders) {
      if (name.toLowerCase() !== 'cookie') continue;
      for (const pair of header.split(';')) {
        const equals = pair.indexOf('=');
        if (equals < 1 || !pair.slice(0, equals).trim()) continue;
        out.push({ metadata: { hop: index, direction: 'sent', name: pair.slice(0, equals).trim(), source }, value: pair.slice(equals + 1).trim() });
      }
    }
    for (const [name, header] of hop.responseHeaders) {
      if (name.toLowerCase() !== 'set-cookie') continue;
      const cookie = Cookie.parse(header);
      if (!cookie?.key) continue;
      let url: URL;
      try { url = new URL(hop.url); } catch { continue; }
      out.push({ metadata: { hop: index, direction: 'received', name: cookie.key,
        domain: cookie.domain ?? url.hostname, path: cookie.path ?? defaultPath(url.pathname),
        expires: cookie.expires instanceof Date ? cookie.expires.toISOString() : undefined,
        maxAge: cookie.maxAge === null ? undefined : String(cookie.maxAge), secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly, sameSite: cookie.sameSite ?? '' }, value: cookie.value });
    }
  });
  return out;
}
