// OAuth2 tokens stay in memory, scoped to the collection, environment and resolved configuration.
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { OAUTH2_AUTHORIZATION_CODE, OAUTH2_CLIENT_CREDENTIALS, OAUTH2_PASSWORD, type OAuth2Config, type OAuth2TokenStatus } from '../../shared/model';

/** The config with {{variables}} resolved: what is actually sent to the token endpoint. */
export interface ResolvedOAuth2 {
  grantType?: string;
  accessTokenUrl: string;
  refreshTokenUrl?: string;
  authorizationUrl?: string;
  callbackUrl?: string;
  pkce?: boolean;
  username?: string;
  password?: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  credentialsPlacement: OAuth2Config['credentialsPlacement'];
}

export interface TokenEntry {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** Granted scope, when the server says. */
  scope?: string;
  obtainedAt: number;
  /** Epoch ms; absent when the server gave no expires_in. */
  expiresAt?: number;
}

export type TokenFetcher = (cfg: ResolvedOAuth2, previous: TokenEntry | undefined, signal: AbortSignal) => Promise<TokenEntry>;

/** Treat a token as expired a little early, so it doesn't expire on the way to the server. */
const EXPIRY_SKEW_MS = 30_000;

export const isExpired = (t: TokenEntry, now = Date.now()): boolean => t.expiresAt !== undefined && t.expiresAt - EXPIRY_SKEW_MS <= now;

export function resolveOAuth2(o: OAuth2Config, interpolate: (s: string) => string): ResolvedOAuth2 {
  return {
    accessTokenUrl: interpolate(o.accessTokenUrl).trim(),
    clientId: interpolate(o.clientId),
    clientSecret: interpolate(o.clientSecret),
    scope: interpolate(o.scope).trim(),
    credentialsPlacement: o.credentialsPlacement,
    grantType: o.grantType === OAUTH2_CLIENT_CREDENTIALS ? undefined : o.grantType,
    refreshTokenUrl: o.refreshTokenUrl ? interpolate(o.refreshTokenUrl).trim() || undefined : undefined,
    ...(o.grantType === OAUTH2_AUTHORIZATION_CODE ? {
      authorizationUrl: interpolate(o.authorizationUrl ?? '').trim(),
      callbackUrl: interpolate(o.callbackUrl ?? '').trim(),
      pkce: o.pkce !== false
    } : {}),
    ...(o.grantType === OAUTH2_PASSWORD ? { username: interpolate(o.username ?? ''), password: interpolate(o.password ?? '') } : {})
  };
}

/** Tokens are kept per collection and environment, like runtime variables. Windows paths compare case-insensitively. */
export function tokenScope(collectionDir: string, environment: string): string {
  return `${process.platform === 'win32' ? collectionDir.toLowerCase() : collectionDir}\u0000${environment}`;
}

/** The {{variable}}-bearing fields, for unresolved-variable checks. */
export const oauth2Fields = (o: OAuth2Config): string[] => [
  o.accessTokenUrl, o.refreshTokenUrl ?? '', o.clientId, o.clientSecret, o.scope,
  ...(o.grantType === OAUTH2_AUTHORIZATION_CODE ? [o.authorizationUrl ?? '', o.callbackUrl ?? ''] : []),
  ...(o.grantType === OAUTH2_PASSWORD ? [o.username ?? '', o.password ?? ''] : [])
];

/** Error from the token endpoint itself (it answered, but not with a token). */
export class TokenError extends Error {}

/** Waits for `p`, but lets one caller cancel without cancelling a token request other sends are sharing. */
function unlessAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class TokenCache {
  private tokens = new Map<string, TokenEntry>();
  private inflight = new Map<string, { promise: Promise<TokenEntry>; controller: AbortController }>();

  /** `scope` is the collection and environment; the config hash keeps different clients and scopes apart. */
  private key(scope: string, cfg: ResolvedOAuth2): string {
    return `${scope}\u0000${createHash('sha256').update(JSON.stringify(cfg)).digest('hex')}`;
  }

  peek(scope: string, cfg: ResolvedOAuth2): TokenEntry | undefined {
    return this.tokens.get(this.key(scope, cfg));
  }

  /** A new token for this config, shared by every caller asking at the same time. */
  async fetch(scope: string, cfg: ResolvedOAuth2, fetcher: TokenFetcher, signal?: AbortSignal): Promise<TokenEntry> {
    if (signal?.aborted) throw cancelled();
    const k = this.key(scope, cfg);
    let flight = this.inflight.get(k);
    if (!flight) {
      const controller = new AbortController();
      const previous = this.tokens.get(k);
      const promise = Promise.resolve().then(() => fetcher(cfg, previous, controller.signal)).then((t) => {
        if (controller.signal.aborted) throw cancelled();
        this.tokens.set(k, t);
        return t;
      }).finally(() => {
        if (this.inflight.get(k)?.controller === controller) this.inflight.delete(k);
      });
      flight = { promise, controller };
      this.inflight.set(k, flight);
    }
    return unlessAborted(flight.promise, signal);
  }

  forget(scope: string, cfg: ResolvedOAuth2): void {
    const k = this.key(scope, cfg);
    this.cancel(scope, cfg);
    this.tokens.delete(k);
  }

  cancel(scope: string, cfg: ResolvedOAuth2): void {
    const k = this.key(scope, cfg);
    this.inflight.get(k)?.controller.abort();
    this.inflight.delete(k);
  }

  /** Invalidate the rejected access token while keeping its refresh token for the next send. */
  invalidate(scope: string, cfg: ResolvedOAuth2, rejected: TokenEntry): void {
    const k = this.key(scope, cfg);
    if (this.tokens.get(k) !== rejected) return;
    if (rejected.refreshToken) this.tokens.set(k, { ...rejected, expiresAt: 0 });
    else this.tokens.delete(k);
  }

  close(): void {
    for (const flight of this.inflight.values()) flight.controller.abort();
    this.inflight.clear();
    this.tokens.clear();
  }

  status(scope: string, cfg: ResolvedOAuth2): OAuth2TokenStatus {
    const t = this.peek(scope, cfg);
    if (!t) return { state: 'none' };
    return {
      state: isExpired(t) ? 'expired' : 'valid',
      expiresAt: t.expiresAt === undefined ? undefined : new Date(t.expiresAt).toISOString(),
      obtainedAt: new Date(t.obtainedAt).toISOString(),
      tokenType: maskOAuth2Text(t.tokenType, [t.accessToken, t.refreshToken, cfg.clientSecret, cfg.password]),
      scope: t.scope === undefined ? undefined : maskOAuth2Text(t.scope, [t.accessToken, t.refreshToken, cfg.clientSecret, cfg.password])
    };
  }
}

export interface FetchTokenOptions {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  timeoutMs: number;
  userAgent: string;
  signal?: AbortSignal;
  authorize?: (cfg: ResolvedOAuth2) => Promise<AuthorizationCode>;
}

export interface AuthorizationCode {
  code: string;
  redirectUri: string;
  verifier?: string;
}

export const cancelled = (): Error => Object.assign(new Error('Cancelled'), { code: 'ERR_CANCELED' });

export function maskOAuth2Text(text: string, secrets: (string | undefined)[]): string {
  const values = secrets.filter((s): s is string => !!s);
  const encoded = values.flatMap((s) => [s, encodeURIComponent(s), new URLSearchParams({ s }).toString().slice(2)]);
  return [...new Set(encoded)].sort((a, b) => b.length - a.length).reduce((s, secret) => s.split(secret).join('••••••'), text);
}

export function oauth2Url(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new TokenError(`Enter a valid ${name}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new TokenError(`Enter an HTTP or HTTPS ${name} without credentials or a fragment`);
  return url;
}

/** Try the refresh grant first. A fresh authorization code requires an explicit browser action. */
export async function fetchOAuth2Token(cfg: ResolvedOAuth2, previous: TokenEntry | undefined, o: FetchTokenOptions): Promise<TokenEntry> {
  const grant = cfg.grantType ?? OAUTH2_CLIENT_CREDENTIALS;
  if (previous?.refreshToken) {
    try {
      const next = await exchange(cfg, cfg.refreshTokenUrl || cfg.accessTokenUrl, { grant_type: 'refresh_token', refresh_token: previous.refreshToken }, o);
      return { ...next, refreshToken: next.refreshToken ?? previous.refreshToken };
    } catch (e) {
      if (o.signal?.aborted) throw cancelled();
      if (!(e instanceof TokenError)) throw e;
    }
  }
  const fields: Record<string, string> = { grant_type: grant };
  if (grant === OAUTH2_AUTHORIZATION_CODE) {
    if (!o.authorize) throw new TokenError('Use Get token in the Auth tab to sign in before sending this request.');
    // Check both endpoints before opening a browser.
    oauth2Url(cfg.accessTokenUrl, 'OAuth2 token URL');
    const { code, redirectUri, verifier } = await o.authorize(cfg);
    fields.code = code;
    fields.redirect_uri = redirectUri;
    if (verifier) fields.code_verifier = verifier;
  } else {
    if (cfg.scope) fields.scope = cfg.scope;
    if (grant === OAUTH2_PASSWORD) {
      fields.username = cfg.username ?? '';
      fields.password = cfg.password ?? '';
    }
  }
  return exchange(cfg, cfg.accessTokenUrl, fields, o);
}

async function exchange(cfg: ResolvedOAuth2, endpoint: string, fields: Record<string, string>, o: FetchTokenOptions): Promise<TokenEntry> {
  if (!endpoint) throw new TokenError('The OAuth2 token URL is empty');
  const url = oauth2Url(endpoint, 'OAuth2 token URL').href;
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': o.userAgent };
  if (cfg.credentialsPlacement === 'basic_auth_header' && (cfg.clientSecret || cfg.grantType !== OAUTH2_AUTHORIZATION_CODE)) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  else {
    form.set('client_id', cfg.clientId);
    if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  }
  const r = await axios.request<string>({
    method: 'POST',
    url,
    headers,
    data: form.toString(),
    responseType: 'text',
    transformResponse: (d: string) => d,
    validateStatus: () => true,
    timeout: o.timeoutMs,
    signal: o.signal,
    maxRedirects: 0,
    httpAgent: o.httpAgent,
    httpsAgent: o.httpsAgent,
    // The agents handle proxies.
    proxy: false
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(r.data || '{}') ?? {};
  } catch {
    /* not JSON: reported below */
  }
  if (r.status < 200 || r.status >= 300) {
    // The endpoint controls the error body and may echo credentials, codes or tokens.
    const reason = body.error === 'invalid_client' ? ' (invalid_client: Unknown client or wrong secret)' : '';
    throw new TokenError(`The token endpoint answered ${r.status}${reason}`);
  }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new TokenError('The token endpoint answered without an access_token');
  const expiresIn = Number(body.expires_in);
  const now = Date.now();
  const sensitive = [body.access_token, typeof body.refresh_token === 'string' ? body.refresh_token : undefined, cfg.clientSecret, cfg.password, fields.code, fields.code_verifier, fields.refresh_token];
  const expiresAt = now + expiresIn * 1000;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
    tokenType: typeof body.token_type === 'string' ? maskOAuth2Text(body.token_type, sensitive) : 'Bearer',
    scope: typeof body.scope === 'string' ? maskOAuth2Text(body.scope, sensitive) : undefined,
    obtainedAt: now,
    expiresAt: Number.isFinite(new Date(expiresAt).getTime()) && expiresIn > 0 ? expiresAt : undefined
  };
}
