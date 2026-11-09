import type { RunCookie } from './model';

/** Explicitly copy supported metadata, so raw values can never ride along into IPC or history. */
export function cookieMetadata(c: RunCookie, mask: (text: string) => string): RunCookie {
  const optional = (s: string | undefined): string | undefined => s === undefined ? undefined : mask(s);
  return { hop: c.hop, direction: c.direction, name: mask(c.name), source: c.source,
    domain: optional(c.domain), path: optional(c.path), expires: optional(c.expires), maxAge: optional(c.maxAge),
    secure: c.secure, httpOnly: c.httpOnly, sameSite: optional(c.sameSite) };
}
