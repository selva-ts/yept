// Tracks in-flight runs (for cancel), keeps the last few response bodies (for "Save to file") and unmasked
// requests (for "Copy as cURL" with secrets), owns the script sandbox and the OAuth2 token cache, hands each run
// its cookie jar, and records every run in history (redacted).
import { join } from 'node:path';
import { interpolate } from '@usebruno/common';
import { classify, findUnresolved, getAgents, resolveAuth, run, setUserAgent, userAgent } from '@yept/core/engine/runner/runner';
import { TokenCache, TokenError, fetchClientCredentialsToken, oauth2Fields, resolveOAuth2, tokenScope } from '@yept/core/engine/auth/oauth2';
import { resolveLayers } from '@yept/core/engine/env/variables';
import type { OAuth2TokenView } from '@yept/core/shared/ipc';
import { SandboxHost } from '@yept/core/engine/sandbox/host';
import { HistoryStore } from '@yept/core/engine/history/store';
import type { RequestContext } from '@yept/core/engine/workspace/workspace';
import { OAUTH2_CLIENT_CREDENTIALS, type RequestDoc, type RunResult } from '@yept/core/shared/model';
import type { EnvService } from './env-service';
import type { SettingsService } from './settings-service';
import type { CookieService } from './cookie-service';
import { toCurl, type CurlRequest } from '@yept/core/shared/curl';
import { rawRequestHead } from '@yept/core/shared/raw-http';
import type { AppHost } from './host';
import { RecentCookies } from './recent-cookies';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 50 * 1024 * 1024; // processing limit
const SCRIPT_TIMEOUT_MS = 5_000; // per script stage
const KEEP_BODIES = 10;
// Unmasked requests kept for "Copy as cURL" with secrets: memory only, this session only.
const KEEP_SENT = 50;

export interface RunTarget {
  requestId: string;
  requestName: string;
  requestPath: string;
  ctx: RequestContext;
}

/** Runtime and script values a collection run without an environment carries from one request to the next. */
export interface RunScratch {
  runtime: Record<string, string>;
  session: Record<string, string>;
}

export interface StartOptions {
  /** Instead of the collection's active environment ('' for none). */
  environment?: string;
  /** Cancels the run along with its own Cancel. */
  signal?: AbortSignal;
  /** Without an environment nothing is kept between runs, except in this. */
  scratch?: RunScratch;
}

export interface RunServiceOptions {
  /** Checked at each run: why scripts may not run now (the extension's untrusted folders), or undefined. */
  scriptsBlocked?: () => string | undefined;
}

export class RunService {
  private active = new Map<string, AbortController>();
  private bodies = new Map<string, Buffer>();
  private sent = new Map<string, CurlRequest>();
  private cookieValues = new RecentCookies(KEEP_SENT);
  // OAuth2 tokens, in memory only: a restart fetches new ones.
  private tokens = new TokenCache();
  private sandbox: SandboxHost | null = null;
  private historyStore: HistoryStore | null = null;
  private readonly ownsHistory: boolean;

  /** A history store passed in is shared with other services and stays open when this one closes. */
  constructor(private env: EnvService, private settings: SettingsService, private cookies: CookieService, private platform: Pick<AppHost, 'userDataPath' | 'appVersion' | 'sandboxWorkerPath'>, history?: HistoryStore, private options: RunServiceOptions = {}) {
    setUserAgent(`Yept/${this.platform.appVersion()}`);
    this.historyStore = history ?? null;
    this.ownsHistory = !history;
  }

  private host(): SandboxHost {
    this.sandbox ??= new SandboxHost(this.platform.sandboxWorkerPath, { timeoutMs: SCRIPT_TIMEOUT_MS, poolSize: 2 });
    return this.sandbox;
  }

  get history(): HistoryStore {
    this.historyStore ??= new HistoryStore(join(this.platform.userDataPath(), 'history.db'), () => this.settings.get());
    return this.historyStore;
  }

  async start(runId: string, target: RunTarget, doc: RequestDoc, options: StartOptions = {}): Promise<{ result: RunResult; historyError?: string }> {
    const ac = new AbortController();
    this.active.set(runId, ac);
    const stop = (): void => ac.abort();
    if (options.signal?.aborted) ac.abort();
    options.signal?.addEventListener('abort', stop, { once: true });
    const startedAt = new Date().toISOString();
    const { ctx } = target;
    try {
      const e = await this.env.forRun(ctx, options.environment);
      const scratch = e.environment ? undefined : options.scratch;
      if (scratch) {
        e.layers.runtime = { ...scratch.runtime };
        e.layers.environment.session = { ...scratch.session };
      }
      const out = await run(doc, {
        runId,
        environment: e.environment,
        layers: e.layers,
        secretNames: e.secretNames,
        tls: e.tls,
        inherited: { collection: ctx.collection, folders: ctx.folders },
        sandbox: this.host(),
        scriptsBlocked: this.options.scriptsBlocked?.(),
        collectionPath: ctx.collectionDir,
        collectionName: ctx.collectionName,
        processEnv: ctx.processEnv,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        maxBodyBytes: MAX_BODY_BYTES,
        signal: ac.signal,
        cookies: this.cookies.forRun(ctx.collectionDir, e.environment),
        oauth2: { cache: this.tokens, scope: tokenScope(ctx.collectionDir, e.environment) }
      });
      this.env.apply(ctx.collectionDir, e.environment, out.updates);
      if (scratch) {
        scratch.runtime = out.updates.runtime;
        for (const [name, v] of Object.entries(out.updates.session)) {
          if (v === undefined) delete scratch.session[name];
          else scratch.session[name] = v;
        }
      }
      this.bodies.set(runId, out.bodyBytes);
      while (this.bodies.size > KEEP_BODIES) this.bodies.delete(this.bodies.keys().next().value!);
      if (out.sent) this.sent.set(runId, out.sent);
      if (out.cookieValues !== undefined) this.cookieValues.keep(runId, out.cookieValues);
      // Requests sent by scripts: the same in-memory copies, under their own run ids. No history entries of their own.
      for (const c of out.scriptRequests ?? []) {
        if (c.sent) this.sent.set(c.runId, c.sent);
        if (c.cookieValues !== undefined) this.cookieValues.keep(c.runId, c.cookieValues);
      }
      while (this.sent.size > KEEP_SENT) this.sent.delete(this.sent.keys().next().value!);
      // A history failure must not lose the result on screen; it's reported instead.
      let historyError: string | undefined;
      try {
        this.history.add({
          runId,
          requestId: target.requestId,
          collectionDir: ctx.collectionDir,
          requestName: target.requestName,
          requestPath: target.requestPath,
          startedAt,
          result: out.result,
          doc,
          bodyBytes: out.bodyBytes,
          secrets: out.secrets,
          appVersion: this.platform.appVersion()
        });
      } catch (err) {
        historyError = `This run wasn't saved to history: ${(err as Error).message}`;
      }
      return { result: out.result, historyError };
    } finally {
      this.active.delete(runId);
      options.signal?.removeEventListener('abort', stop);
    }
  }

  cancel(runId: string): void {
    this.active.get(runId)?.abort();
  }

  /** Live body bytes for recent runs, else the stored (redacted, possibly truncated) history body. */
  body(runId: string): Buffer | undefined {
    return this.bodies.get(runId) ?? this.historyStore?.body(runId);
  }

  curlWithSecrets(runId: string): string {
    return toCurl(this.unmasked(runId));
  }

  /** The raw request head of the last request on the wire, with secret values and cookies. */
  rawWithSecrets(runId: string): string {
    return rawRequestHead(this.unmasked(runId));
  }

  private unmasked(runId: string): CurlRequest {
    const r = this.sent.get(runId);
    if (!r) throw new Error('Secrets are only kept for the last 50 requests sent in this session. Send the request again, or copy it without secrets.');
    return r;
  }

  cookieValue(runId: string, index: number): string { return this.cookieValues.reveal(runId, index); }

  /**
   * The OAuth2 token for a request's effective auth (its own or inherited) in the active environment: its status,
   * or a new one ('fetch'), or forgotten ('forget'). The token itself never leaves the main process.
   */
  async oauth2Token(ctx: RequestContext, doc: RequestDoc, action: 'status' | 'fetch' | 'forget'): Promise<OAuth2TokenView> {
    const auth = resolveAuth(doc.auth, { collection: ctx.collection, folders: ctx.folders });
    if (auth.mode !== 'oauth2' || auth.oauth2.grantType !== OAUTH2_CLIENT_CREDENTIALS) return { applies: false };
    const e = await this.env.forRun(ctx);
    const values = resolveLayers({ ...e.layers, collection: ctx.collection.vars, folders: ctx.folders.map((f) => f.vars), request: doc.vars.req }).values;
    const missing = findUnresolved(oauth2Fields(auth.oauth2), Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string')) as Record<string, string>);
    if (missing.length) throw new Error(`Unresolved variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    const vars = { ...values, process: { env: ctx.processEnv } };
    const cfg = resolveOAuth2(auth.oauth2, (s) => String(interpolate(s, vars)));
    const scope = tokenScope(ctx.collectionDir, e.environment);
    if (action === 'forget') this.tokens.forget(scope, cfg);
    if (action === 'fetch') {
      const agents = getAgents(e.tls);
      try {
        await this.tokens.fetch(scope, cfg, (c) => fetchClientCredentialsToken(c, { httpAgent: agents.http, httpsAgent: agents.https, timeoutMs: DEFAULT_TIMEOUT_MS, userAgent: userAgent() }));
      } catch (err) {
        throw new Error(`OAuth2 token request failed: ${err instanceof TokenError ? err.message : classify(err).message}`);
      }
    }
    return { applies: true, environment: e.environment, status: this.tokens.status(scope, cfg) };
  }

  async close(): Promise<void> {
    this.cookieValues.clear();
    await this.sandbox?.close();
    if (this.ownsHistory) this.historyStore?.close();
  }
}
