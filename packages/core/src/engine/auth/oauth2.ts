// OAuth2 client credentials: fetches access tokens and keeps them in memory, per collection, environment and
// configuration. A changed token URL, client, secret, scope or credentials placement never reuses an old token, and
// tokens are never written to disk (a restart gets a fresh one). Concurrent sends share one token request.
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import axios from 'axios';
import type { OAuth2Config, OAuth2TokenStatus } from '../../shared/model';

/** The config with {{variables}} resolved: what is actually sent to the token endpoint. */
export interface ResolvedOAuth2 {
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  credentialsPlacement: OAuth2Config['credentialsPlacement'];
}

export interface TokenEntry {
  accessToken: string;
  tokenType: string;
  /** Granted scope, when the server says. */
  scope?: string;
  obtainedAt: number;
  /** Epoch ms; absent when the server gave no expires_in. */
  expiresAt?: number;
}

export type TokenFetcher = (cfg: ResolvedOAuth2) => Promise<TokenEntry>;

/** Treat a token as expired a little early, so it doesn't expire on the way to the server. */
const EXPIRY_SKEW_MS = 30_000;

export const isExpired = (t: TokenEntry, now = Date.now()): boolean => t.expiresAt !== undefined && t.expiresAt - EXPIRY_SKEW_MS <= now;

export function resolveOAuth2(o: OAuth2Config, interpolate: (s: string) => string): ResolvedOAuth2 {
  return {
    accessTokenUrl: interpolate(o.accessTokenUrl).trim(),
    clientId: interpolate(o.clientId),
    clientSecret: interpolate(o.clientSecret),
    scope: interpolate(o.scope).trim(),
    credentialsPlacement: o.credentialsPlacement
  };
}

/** Tokens are kept per collection and environment, like runtime variables. Windows paths compare case-insensitively. */
export function tokenScope(collectionDir: string, environment: string): string {
  return `${process.platform === 'win32' ? collectionDir.toLowerCase() : collectionDir}\u0000${environment}`;
}

/** The {{variable}}-bearing fields, for unresolved-variable checks. */
export const oauth2Fields = (o: OAuth2Config): string[] => [o.accessTokenUrl, o.clientId, o.clientSecret, o.scope];

/** Error from the token endpoint itself (it answered, but not with a token). */
export class TokenError extends Error {}

/** Waits for `p`, but lets one caller cancel without cancelling a token request other sends are sharing. */
function unlessAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Cancelled'), { code: 'ERR_CANCELED' }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(Object.assign(new Error('Cancelled'), { code: 'ERR_CANCELED' }));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class TokenCache {
  private tokens = new Map<string, TokenEntry>();
  private inflight = new Map<string, Promise<TokenEntry>>();

  /** `scope` is the collection and environment; the config hash keeps different clients and scopes apart. */
  private key(scope: string, cfg: ResolvedOAuth2): string {
    return `${scope}\u0000${createHash('sha256').update(JSON.stringify(cfg)).digest('hex')}`;
  }

  peek(scope: string, cfg: ResolvedOAuth2): TokenEntry | undefined {
    return this.tokens.get(this.key(scope, cfg));
  }

  /** A new token for this config, shared by every caller asking at the same time. */
  async fetch(scope: string, cfg: ResolvedOAuth2, fetcher: TokenFetcher, signal?: AbortSignal): Promise<TokenEntry> {
    const k = this.key(scope, cfg);
    let p = this.inflight.get(k);
    if (!p) {
      p = fetcher(cfg).then((t) => {
        this.tokens.set(k, t);
        return t;
      });
      const shared = p;
      this.inflight.set(k, shared);
      void shared.catch(() => undefined).finally(() => {
        if (this.inflight.get(k) === shared) this.inflight.delete(k);
      });
    }
    return unlessAborted(p, signal);
  }

  forget(scope: string, cfg: ResolvedOAuth2): void {
    this.tokens.delete(this.key(scope, cfg));
  }

  status(scope: string, cfg: ResolvedOAuth2): OAuth2TokenStatus {
    const t = this.peek(scope, cfg);
    if (!t) return { state: 'none' };
    return {
      state: isExpired(t) ? 'expired' : 'valid',
      expiresAt: t.expiresAt === undefined ? undefined : new Date(t.expiresAt).toISOString(),
      obtainedAt: new Date(t.obtainedAt).toISOString(),
      tokenType: t.tokenType,
      scope: t.scope
    };
  }
}

export interface FetchTokenOptions {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  timeoutMs: number;
  userAgent: string;
}

/**
 * Requests a token with the client credentials grant (RFC 6749, section 4.4). Network failures are thrown as-is for the
 * caller to classify; an answer without a token throws TokenError with the server's error, never the secret.
 */
export async function fetchClientCredentialsToken(cfg: ResolvedOAuth2, o: FetchTokenOptions): Promise<TokenEntry> {
  if (!cfg.accessTokenUrl) throw new TokenError('The OAuth2 token URL is empty');
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (cfg.scope) form.set('scope', cfg.scope);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': o.userAgent };
  if (cfg.credentialsPlacement === 'basic_auth_header') headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  else {
    form.set('client_id', cfg.clientId);
    if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  }
  const r = await axios.request<string>({
    method: 'POST',
    url: cfg.accessTokenUrl,
    headers,
    data: form.toString(),
    responseType: 'text',
    transformResponse: (d: string) => d,
    validateStatus: () => true,
    timeout: o.timeoutMs,
    maxRedirects: 0,
    httpAgent: o.httpAgent,
    httpsAgent: o.httpsAgent
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(r.data || '{}');
  } catch {
    /* not JSON: reported below */
  }
  if (r.status < 200 || r.status >= 300) {
    const reason = [body.error, body.error_description].filter((x) => typeof x === 'string' && x).join(': ');
    throw new TokenError(`The token endpoint answered ${r.status}${reason ? ` (${reason})` : ''}`);
  }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new TokenError('The token endpoint answered without an access_token');
  const expiresIn = Number(body.expires_in);
  const now = Date.now();
  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    obtainedAt: now,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined
  };
}
