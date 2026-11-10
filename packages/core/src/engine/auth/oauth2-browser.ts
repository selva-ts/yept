import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cancelled, oauth2Url, TokenError, type AuthorizationCode, type ResolvedOAuth2 } from './oauth2';

const LOOPBACK = '127.0.0.1';
const DEFAULT_CALLBACK = `http://${LOOPBACK}/oauth/callback`;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** Listen before opening the system browser, and accept only the callback for this attempt. */
export async function authorizeInBrowser(
  cfg: ResolvedOAuth2,
  open: (url: string) => Promise<void>,
  signal: AbortSignal,
  timeoutMs = CALLBACK_TIMEOUT_MS
): Promise<AuthorizationCode> {
  if (signal.aborted) throw cancelled();
  const url = oauth2Url(cfg.authorizationUrl ?? '', 'OAuth2 authorization URL');
  const redirect = oauth2Url(cfg.callbackUrl || DEFAULT_CALLBACK, 'OAuth2 callback URL');
  if (redirect.protocol !== 'http:' || ![LOOPBACK, 'localhost'].includes(redirect.hostname)) {
    throw new TokenError('The OAuth2 callback must be an HTTP URL on 127.0.0.1 or localhost. Leave it blank to use a random local port.');
  }
  const port = cfg.callbackUrl ? Number(redirect.port || '80') : 0;
  const state = randomBytes(32).toString('base64url');
  const verifier = cfg.pkce === false ? undefined : randomBytes(32).toString('base64url');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('state', state);
  if (cfg.scope) url.searchParams.set('scope', cfg.scope);
  url.searchParams.delete('code_challenge');
  url.searchParams.delete('code_challenge_method');
  if (verifier) {
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }

  const listener = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const servers: ReturnType<typeof createServer>[] = [];
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<AuthorizationCode>((resolve, reject) => {
      cancel = () => reject(cancelled());
      signal.addEventListener('abort', cancel, { once: true });
      timeout = setTimeout(() => reject(new TokenError('OAuth2 sign-in timed out. Use Get token to try again.')), timeoutMs);
      const handle = (req: IncomingMessage, res: ServerResponse): void => {
        const incoming = new URL(req.url?.startsWith('/') ? `${redirect.origin}${req.url}` : redirect.origin);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Connection', 'close');
        if (req.method !== 'GET' || incoming.pathname !== redirect.pathname || req.headers.host !== redirect.host ||
          [...redirect.searchParams].some(([key, value]) => !incoming.searchParams.getAll(key).includes(value))) {
          res.statusCode = 404;
          res.end('No OAuth2 callback at this address.');
          return;
        }
        const codes = incoming.searchParams.getAll('code');
        const states = incoming.searchParams.getAll('state');
        // A callback for another attempt (an old tab reloaded, or a page probing local ports) is refused, but this
        // sign-in keeps waiting for its own callback.
        if (states.length !== 1 || states[0] !== state) {
          res.statusCode = 400;
          res.end('This sign-in link has expired. Return to Yept.');
          return;
        }
        const problem = incoming.searchParams.has('error') ? 'The authorization server declined the OAuth2 sign-in.'
          : codes.length !== 1 || !codes[0] ? 'The OAuth2 callback did not contain an authorization code.' : undefined;
        if (problem) {
          res.statusCode = 400;
          res.end('OAuth2 sign-in failed. Return to Yept.', () => reject(new TokenError(problem)));
        } else {
          res.end('Sign-in received. You can close this tab and return to Yept.', () => resolve({ code: codes[0], redirectUri: redirect.href, verifier }));
        }
      };
      const server = createServer(handle);
      servers.push(server);
      server.on('error', () => reject(new TokenError('Yept could not listen on the OAuth2 callback port. Check whether it is in use.')));
      server.listen({ host: LOOPBACK, port, signal: listener.signal }, () => {
        if (signal.aborted) return;
        if (!port) redirect.port = String((server.address() as AddressInfo).port);
        // A fixed localhost callback may be tried over IPv6 first: listen there too, so no other local program can take
        // it. Skipped quietly where IPv6 is not available.
        if (port && redirect.hostname === 'localhost') {
          const v6 = createServer(handle);
          servers.push(v6);
          v6.on('error', () => {});
          v6.listen({ host: '::1', port, signal: listener.signal });
        }
        url.searchParams.set('redirect_uri', redirect.href);
        void Promise.resolve().then(() => open(url.href)).catch(() => reject(new TokenError('Yept could not open the system browser for OAuth2 sign-in.')));
      });
    });
  } finally {
    clearTimeout(timeout);
    if (cancel) signal.removeEventListener('abort', cancel);
    listener.abort();
    for (const s of servers) s.closeAllConnections();
  }
}
