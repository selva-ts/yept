/**
 * The only URLs Yept hands to the operating system: web pages for the default browser. Anything else could run
 * or open something locally (file:, javascript:, data:, UNC paths, ms-* and other registered protocol handlers),
 * and response HTML is untrusted, so mailto: and every other scheme are refused too.
 * Returns the URL as parsed, so the OS opens exactly what was checked, or null when it isn't allowed.
 */
export function externalUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname ? parsed.href : null;
}

/** Opens an allowed URL with `open` (shell.openExternal in the app) and silently ignores the rest. */
export function openExternalUrl(url: string, open: (url: string) => Promise<void>): boolean {
  const safe = externalUrl(url);
  if (safe === null) return false;
  // A failure (no browser registered, say) has nothing useful to show and must not crash main.
  open(safe).catch(() => {});
  return true;
}
