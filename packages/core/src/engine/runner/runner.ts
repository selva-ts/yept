// Request pipeline:
//   snapshot -> inherit headers/auth (collection > folders > request) -> pre-request scripts (sandbox)
//   -> resolve variables -> interpolate -> validate -> add stored cookies -> send (recording each hop) -> buffer (with limit)
//   -> store Set-Cookie -> post-response vars (token extraction) -> post-response scripts -> RunResult + variable updates.
// Requests a script sends with bru.sendRequest go through run() too, as child runs with no scripts of their own.
// The runner never mutates variable stores: it returns the variable changes and the caller decides where they go.
// Cookies are the exception: the caller hands in the jar for this collection and environment, and the runner
// reads and writes it as the requests (and redirects) happen.
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import axios, { type AxiosError, type AxiosResponse } from 'axios';
import { interpolate, utils as brunoUtils } from '@usebruno/common';
import { caOptions } from '../net/ca';
import { ProxyError, proxyAgents, proxyName, type ProxyRouter } from '../net/proxy';
import type { LoadedClientCertificate } from '../net/client-certs';
import { AUTH_MODES, OAUTH2_AUTHORIZATION_CODE, isOAuth2Grant, type AuthConfig, type CookieUse, type ExtractionResult, type HttpMethod, type KeyValue, type NetworkHop, type OAuth2Use, type RequestDoc, type RunResult, type ScriptRequest, type ScriptStage, type SettingsDoc, type TestResult, type TimelineEntry } from '../../shared/model';
import { findUnresolved } from '../../shared/vars';
import { emptyEnvLayer, envVariables, resolveLayers, type VarLayers } from '../env/variables';
import type { RawResult, SandboxHooks, SandboxHost, ScriptSendReply, SandboxRequest, SandboxResponse, SandboxResult } from '../sandbox/host';
import type { RunCookies } from '../cookies/cookie-store';
import { WireRecorder, type RedirectEvent, type WireHop } from './network';
import { captureCookies } from '../cookies/exchange';
import { TokenCache, TokenError, fetchOAuth2Token, isExpired, maskOAuth2Text, oauth2Fields, resolveOAuth2, type TokenEntry, type TokenFetcher } from '../auth/oauth2';
import { cookieMetadata } from '../../shared/run-cookies';
import { describeParts } from '../../shared/multipart';
import { MultipartFileError, encodeMultipart, loadParts, type EncodedMultipart, type MultipartInput, type MultipartPart } from './multipart';
import { MAX_SCRIPT_REQUESTS, ScriptRequestError, prepareScriptRequest, scriptOptions, scriptReply, scriptRequestDoc } from './script-requests';
import { ChallengeError, challengeAuth } from '../auth/challenge';
import { sha256Hex, signRequest } from '../auth/aws-sigv4';

export { findUnresolved };

export interface RunOptions {
  runId: string;
  /** Simple variables for callers without layers (treated as runtime variables). */
  variables?: Record<string, string>;
  layers?: VarLayers;
  /** Environment used for this run ('' for none). */
  environment?: string;
  /** Names declared secret in the environment: extracted values for these go to local secrets. */
  secretNames?: string[];
  /** Collection and folder defaults above the request. */
  inherited?: { collection: SettingsDoc; folders: SettingsDoc[] };
  sandbox?: SandboxHost;
  /**
   * Why scripts may not run here (an untrusted folder, say). When set, the request is still sent, but pre-request and
   * post-response scripts, post-response vars, assertions and tests are reported as not run with this reason.
   */
  scriptsBlocked?: string;
  collectionPath?: string;
  collectionName?: string;
  processEnv?: Record<string, string>;
  tls?: { skipVerify: boolean; ca?: string[]; clientCertificates?: LoadedClientCertificate[] };
  /** Picks the proxy for each connection. Absent: connect directly (or as the host platform does). */
  proxy?: ProxyRouter;
  /** Used when the request's own timeout is 0. */
  defaultTimeoutMs: number;
  /** Bytes buffered before reading stops and the result is marked truncated. */
  maxBodyBytes: number;
  signal?: AbortSignal;
  /** The cookie jar for this collection and environment. Absent when automatic cookies are off. */
  cookies?: RunCookies;
  /** OAuth2 token cache and the collection + environment it's scoped to. Absent: a token is fetched for each run. */
  oauth2?: { cache: TokenCache; scope: string };
  /** A request a script built with bru.sendRequest: sent as it is, without variables, auth, scripts or inherited defaults. */
  prepared?: Prepared;
  /** More values to mask in the result (a script's child run gets the parent's auth values). */
  mask?: string[];
}

/** Variable changes produced by the run. `undefined` means "remove". */
export interface VariableUpdates {
  runtime: Record<string, string>;
  session: Record<string, string | undefined>;
  secrets: Record<string, string | undefined>;
}

export interface RunOutput {
  result: RunResult;
  /** Raw body bytes, kept in the main process for "Save to file". Never sent over IPC. */
  bodyBytes: Buffer;
  updates: VariableUpdates;
  /** Every secret value involved in the run, by name, for redacting history. Never sent to the UI. */
  secrets: { name: string; value: string }[];
  /** The final request exactly as sent, unmasked, for "Copy as cURL" with secrets. Never sent to the UI unasked. */
  sent?: { method: string; url: string; headers: [string, string][]; body?: string; form?: MultipartPart[] };
  /** Values aligned with result.cookieDetails, for explicit reveal. Never persist or return through start IPC. */
  cookieValues?: string[];
  /** The unmasked parts of each bru.sendRequest run (result.scriptRequests), for the same in-memory uses. */
  scriptRequests?: { runId: string; sent?: RunOutput['sent']; cookieValues?: string[] }[];
}

/** Sent unless the request sets its own User-Agent. The main process sets the real app version at startup. */
let USER_AGENT = 'Yept';
export function setUserAgent(ua: string): void {
  USER_AGENT = ua;
}
export const userAgent = (): string => USER_AGENT;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|problem\+json|[\w.+-]+\+(json|xml)))/i;

type Agents = { http: http.Agent; https: https.Agent };

/** OS certificate store + Node roots, so the trusted ASP.NET dev cert works; plus any extra CA. Through the proxy, if any. */
const newAgents = (tls?: RunOptions['tls'], extra: http.AgentOptions = {}, proxy?: ProxyRouter): Agents => {
  const httpOptions: http.AgentOptions = { keepAlive: true, ...extra };
  const httpsOptions: https.AgentOptions = { keepAlive: true, ...extra, ...caOptions(tls?.ca), rejectUnauthorized: !tls?.skipVerify };
  const certs = tls?.clientCertificates?.length ? tls.clientCertificates : undefined;
  return proxy || certs ? proxyAgents(proxy, httpOptions, httpsOptions, certs) : { http: new http.Agent(httpOptions), https: new https.Agent(httpsOptions) };
};

const agentCache = new Map<string, Agents>();
export function getAgents(tls?: RunOptions['tls'], proxy?: ProxyRouter): Agents {
  // Keyed by the full CA content: certificates of the same length often share their opening characters.
  const certs = (tls?.clientCertificates ?? []).map((c) => [c.host, c.pfx?.toString('base64'), c.cert?.toString('base64'), c.key?.toString('base64'), c.passphrase]);
  const key = createHash('sha256').update(JSON.stringify([!!tls?.skipVerify, tls?.ca ?? [], proxy?.key ?? '', certs])).digest('hex');
  let a = agentCache.get(key);
  if (!a) {
    a = newAgents(tls, {}, proxy);
    agentCache.set(key, a);
  }
  return a;
}

const enabled = (list: KeyValue[]): KeyValue[] => list.filter((x) => x.enabled && x.name.trim() !== '');

export class PrepareError extends Error {}

/**
 * JSON-aware interpolation: a {{var}} inside a JSON string literal is JSON-escaped, so values with
 * quotes, backslashes or newlines keep the body valid. Outside a string (e.g. {"n": {{count}}}) the value is
 * inserted as-is. Bruno inserts values textually in both cases; this is a deliberate difference.
 */
export function interpolateJson(text: string, vars: Record<string, unknown>): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        const placeholder = text.slice(i, end + 2);
        const value = String(interpolate(placeholder, vars));
        out += inString && value !== placeholder ? JSON.stringify(value).slice(1, -1) : value;
        i = end + 1;
        continue;
      }
    }
    if (inString && ch === '\\') {
      out += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') inString = !inString;
    out += ch;
  }
  return out;
}

/** The effective auth: the request's own, or the nearest folder's, or the collection's. */
export function resolveAuth(own: AuthConfig, inherited?: RunOptions['inherited']): AuthConfig {
  if (own.mode !== 'inherit') return own;
  for (const f of [...(inherited?.folders ?? [])].reverse()) if (f.auth.mode !== 'inherit') return f.auth;
  const c = inherited?.collection.auth;
  return c && c.mode !== 'inherit' ? c : { ...own, mode: 'none' };
}

/** Collection headers, then each folder's, then the request's; later ones replace earlier ones by name. */
export function mergeHeaders(own: KeyValue[], inherited?: RunOptions['inherited']): KeyValue[] {
  const byName = new Map<string, KeyValue>();
  for (const list of [inherited?.collection.headers ?? [], ...(inherited?.folders ?? []).map((f) => f.headers), own]) {
    for (const h of enabled(list)) byName.set(h.name.toLowerCase(), h);
  }
  return [...byName.values()];
}

function authValues(auth: AuthConfig): string[] {
  if (auth.mode === 'bearer') return [auth.bearer.token];
  if (auth.mode === 'basic') return [auth.basic.username, auth.basic.password];
  if (auth.mode === 'apikey') return [auth.apikey.key, auth.apikey.value];
  if (auth.mode === 'oauth2') return oauth2Fields(auth.oauth2);
  if (auth.mode === 'digest') return [auth.digest.username, auth.digest.password];
  if (auth.mode === 'ntlm') return [auth.ntlm.username, auth.ntlm.password, auth.ntlm.domain];
  if (auth.mode === 'awsv4') {
    const w = auth.awsv4;
    return [w.accessKeyId, w.secretAccessKey, w.sessionToken, w.service, w.region];
  }
  return [];
}

/** Auth values never shown: masked in results and the console, redacted in history. */
function authSecrets(auth: AuthConfig): string[] {
  if (auth.mode === 'basic') return [auth.basic.password];
  if (auth.mode === 'bearer') return [auth.bearer.token];
  if (auth.mode === 'apikey') return [auth.apikey.value];
  if (auth.mode === 'digest') return [auth.digest.password];
  if (auth.mode === 'ntlm') return [auth.ntlm.password];
  if (auth.mode === 'awsv4') return [auth.awsv4.secretAccessKey, auth.awsv4.sessionToken];
  return [];
}

/** Stands in for the OAuth2 token while a request is validated, before any token is fetched. */
const TOKEN_PLACEHOLDER = 'oauth2-token-placeholder';

/** Methods that can be re-sent automatically after a 401: they don't change server state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface Prepared {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  data?: string;
  /** Multipart parts with variables filled in. The runner checks the files and encodes the body. */
  multipart?: MultipartInput[];
}

/**
 * Builds the exact request that will be sent. Throws a PrepareError for problems found before sending.
 * `oauth2Token` is required for OAuth2 auth (the runner gets it first).
 */
export function prepare(doc: RequestDoc, vars: Record<string, unknown>, auth: AuthConfig = doc.auth, oauth2Token?: string): Prepared {
  const headers = enabled(doc.headers);
  const form = enabled(doc.body.formUrlEncoded);
  const parts = doc.body.mode === 'multipartForm' ? (doc.body.multipartForm ?? []).filter((f) => f.enabled && f.name.trim() !== '') : [];
  const bodyText = doc.body.mode === 'json' ? doc.body.json : doc.body.mode === 'text' ? doc.body.text : doc.body.mode === 'xml' ? doc.body.xml : undefined;
  const pathParams = doc.params.filter((p) => p.enabled && p.type === 'path');
  if (!(AUTH_MODES as readonly string[]).includes(auth.mode)) {
    throw new PrepareError(`Auth mode "${auth.mode}" isn't supported by Yept yet. Use a bearer token or set the header yourself.`);
  }
  if (auth.mode === 'oauth2' && !isOAuth2Grant(auth.oauth2.grantType)) {
    throw new PrepareError(`OAuth2 "${auth.oauth2.grantType}" isn't supported by Yept yet. Use a bearer token or set the header yourself.`);
  }
  if (doc.body.unsupported) {
    throw new PrepareError(`Body type "${doc.body.unsupported}" isn't supported by Yept yet. Choose another body type in the Body tab, or send this request from Bruno.`);
  }
  if (auth.mode === 'oauth2' && !oauth2Token) throw new PrepareError('No OAuth2 token');

  const flat = Object.fromEntries(Object.entries(vars).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  const missing = findUnresolved(
    [doc.url, ...headers.flatMap((h) => [h.name, h.value]), bodyText, ...form.flatMap((f) => [f.name, f.value]), ...parts.flatMap((f) => [f.name, f.contentType, ...(f.type === 'file' ? [...f.files, ...f.localFiles] : [f.value])]), ...pathParams.map((p) => p.value), ...authValues(auth)],
    flat
  );
  if (missing.length) throw new PrepareError(`Unresolved variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);

  const I = (s: string): string => String(interpolate(s, vars));
  let url = I(doc.url.trim());
  if (!url) throw new PrepareError('URL is empty');
  for (const p of pathParams) url = url.replace(new RegExp(`/:${p.name}(?=/|\\?|#|$)`, 'g'), `/${encodeURIComponent(I(p.value))}`);
  if (!brunoUtils.hasExplicitScheme(url)) url = `${brunoUtils.DEFAULT_SCHEME}${url}`;
  if (auth.mode === 'apikey' && auth.apikey.placement === 'queryparams' && auth.apikey.key) {
    url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(I(auth.apikey.key))}=${encodeURIComponent(I(auth.apikey.value))}`;
  }
  if (auth.mode === 'oauth2' && auth.oauth2.tokenPlacement === 'url') {
    url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(auth.oauth2.tokenQueryKey || 'access_token')}=${encodeURIComponent(oauth2Token!)}`;
  }
  // WHATWG serialisation percent-encodes what must be encoded and leaves existing %XX escapes alone,
  // so URLs are never double-encoded (Bruno's encodeUrl turns %20 into %2520 in query values).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PrepareError(`Invalid URL: ${url}`);
  }
  if (doc.settings.encodeUrl) url = parsed.href;

  const out: Record<string, string> = {};
  for (const h of headers) out[I(h.name)] = I(h.value);
  const hasHeader = (n: string): boolean => Object.keys(out).some((k) => k.toLowerCase() === n);
  if (!hasHeader('user-agent')) out['User-Agent'] = USER_AGENT;
  // An explicit Authorization header wins over the auth settings.
  if (!hasHeader('authorization')) {
    if (auth.mode === 'bearer') {
      const token = I(auth.bearer.token).trim();
      if (!token) throw new PrepareError('Bearer token is empty');
      out.Authorization = `Bearer ${token}`;
    }
    if (auth.mode === 'basic') out.Authorization = `Basic ${Buffer.from(`${I(auth.basic.username)}:${I(auth.basic.password)}`).toString('base64')}`;
    if (auth.mode === 'oauth2' && auth.oauth2.tokenPlacement === 'header') {
      const prefix = auth.oauth2.tokenHeaderPrefix.trim();
      out.Authorization = prefix ? `${prefix} ${oauth2Token}` : oauth2Token!;
    }
  }
  if (auth.mode === 'apikey' && auth.apikey.placement === 'header' && auth.apikey.key) out[I(auth.apikey.key)] = I(auth.apikey.value);
  // Digest and NTLM answer the server's challenge, and AWS signs the final request: the runner does those when sending.
  if (auth.mode === 'awsv4' && !hasHeader('authorization')) {
    const w = auth.awsv4;
    if (!I(w.accessKeyId).trim() || !I(w.secretAccessKey).trim()) {
      throw new PrepareError(w.profileName.trim() && !w.accessKeyId.trim() ? `AWS profile "${w.profileName}" can't be read by Yept. Enter the access key ID and secret access key instead.` : 'AWS access key ID and secret access key are required');
    }
    if (!I(w.service).trim() || !I(w.region).trim()) throw new PrepareError('AWS service and region are required');
  }
  if ((auth.mode === 'digest' || auth.mode === 'ntlm') && !hasHeader('authorization') && !I(auth[auth.mode].username).trim()) {
    throw new PrepareError(`${auth.mode === 'digest' ? 'Digest' : 'NTLM'} username is empty`);
  }

  let data: string | undefined;
  if (bodyText !== undefined && bodyText !== '') data = doc.body.mode === 'json' ? interpolateJson(bodyText, vars) : I(bodyText);
  if (doc.body.mode === 'formUrlEncoded') data = new URLSearchParams(form.map((f) => [I(f.name), I(f.value)])).toString();
  let multipart: MultipartInput[] | undefined;
  if (doc.body.mode === 'multipartForm') {
    multipart = parts.flatMap((f): MultipartInput[] => {
      const name = I(f.name);
      if (f.type === 'text') return [{ name, type: 'text', value: I(f.value), path: '', contentType: I(f.contentType).trim() }];
      const paths = [...f.files, ...f.localFiles].filter((x) => x.trim());
      if (!paths.length) throw new PrepareError(`Multipart field "${name}" has no file chosen on this computer`);
      return paths.map((x) => ({ name, type: 'file', value: '', path: I(x.trim()), contentType: I(f.contentType).trim() }));
    });
  }
  if (data !== undefined && !hasHeader('content-type')) {
    out['Content-Type'] = { json: 'application/json', text: 'text/plain', xml: 'application/xml', formUrlEncoded: 'application/x-www-form-urlencoded', multipartForm: '', none: '' }[doc.body.mode];
  }
  return { method: doc.method, url, headers: out, data, multipart };
}

export function classify(err: unknown): { outcome: RunResult['outcome']; message: string; code?: string } {
  const e = err as AxiosError & { cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (axios.isCancel(err) || code === 'ERR_CANCELED') return { outcome: 'cancelled', message: 'Cancelled', code };
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return { outcome: 'timeout', message: e.message, code };
  if (code === 'ERR_FR_TOO_MANY_REDIRECTS') return { outcome: 'network', message: 'Too many redirects', code };
  // The server's answer about our client certificate (mutual TLS), in plain words.
  if (/ALERT_CERTIFICATE_REQUIRED/.test(code ?? '')) return { outcome: 'network', message: "TLS error: the server requires a client certificate. Add one for this host in the environment's TLS settings", code };
  if (/ALERT_(BAD_CERTIFICATE|UNKNOWN_CA|CERTIFICATE_UNKNOWN|UNSUPPORTED_CERTIFICATE|CERTIFICATE_REVOKED|CERTIFICATE_EXPIRED|ACCESS_DENIED)/.test(code ?? '')) {
    return { outcome: 'network', message: `TLS error: the server didn't accept the client certificate (${code})`, code };
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL|ERR_TLS/.test(code ?? '')) return { outcome: 'network', message: `TLS error: ${code}`, code };
  const friendly: Record<string, string> = {
    ECONNREFUSED: 'Connection refused',
    ENOTFOUND: 'Host not found',
    ECONNRESET: 'Connection reset',
    EHOSTUNREACH: 'Host unreachable',
    EAI_AGAIN: 'DNS lookup failed'
  };
  return { outcome: 'network', message: friendly[code ?? ''] ?? e?.message ?? String(err), code };
}

function headerEntries(h: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(h ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => out.push([k, String(x)]));
    else if (v !== undefined && v !== null) out.push([k, String(v)]);
  }
  return out;
}

function looksBinary(buf: Buffer, contentType: string): boolean {
  if (TEXT_TYPES.test(contentType)) return false;
  return buf.subarray(0, 1024).includes(0);
}

/** Replaces every known secret value with a mask, so results and timelines never show them. */
function masker(secrets: string[]): (s: string) => string {
  const list = [...new Set(secrets.filter((v) => v && v.length >= 4))].sort((a, b) => b.length - a.length);
  return (s) => list.reduce((acc, v) => acc.split(v).join('••••••'), s);
}

const stringMap = (o: Record<string, unknown> | null | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (k !== '__name__' && v !== undefined && v !== null) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
};

export async function run(doc: RequestDoc, opts: RunOptions): Promise<RunOutput> {
  // Snapshot: the run uses a frozen copy, so later edits can't change a request already in flight.
  const snapshot: RequestDoc = structuredClone(doc);
  const environment = opts.environment ?? '';
  const secretNames = new Set(opts.secretNames ?? []);
  const layers: VarLayers = opts.layers
    ? structuredClone(opts.layers)
    : { collection: [], environment: emptyEnvLayer(), folders: [], request: [], runtime: { ...(opts.variables ?? {}) } };
  layers.request = snapshot.vars.req;
  if (opts.inherited) {
    layers.collection = opts.inherited.collection.vars;
    layers.folders = opts.inherited.folders.map((f) => f.vars);
  }
  const extraMask: string[] = [...(opts.mask ?? [])];
  const updates: VariableUpdates = { runtime: layers.runtime, session: {}, secrets: {} };
  const started = performance.now();
  const at = (): number => Math.round(performance.now() - started);
  const timeline: TimelineEntry[] = [];
  const scriptErrors: RunResult['scriptErrors'] = [];
  const consoleOut: RunResult['console'] = [];
  const extractions: ExtractionResult[] = [];
  const tests: TestResult[] = [];
  const testSources: { source: string; script: string }[] = [
    { source: `collection "${collectionLabel(opts)}"`, script: opts.inherited?.collection.tests ?? '' },
    ...(opts.inherited?.folders ?? []).map((f) => ({ source: `folder "${f.name}"`, script: f.tests })),
    { source: 'request', script: snapshot.tests }
  ].filter((t) => t.script.trim());
  const assertions = enabled(snapshot.assertions);
  const hasTests = testSources.length > 0 || assertions.length > 0;
  const empty = { text: '', contentType: '', truncated: false, binary: false };
  const collectionPath = opts.collectionPath ?? process.cwd();
  const collectionName = opts.collectionName ?? '';
  const processEnv = opts.processEnv ?? {};

  const auth = resolveAuth(snapshot.auth, opts.inherited);
  const working: RequestDoc = { ...snapshot, headers: mergeHeaders(snapshot.headers, opts.inherited) };

  // Routes a variable a script or extraction wants to set: secret names go to local secrets.
  const setRuntime = (name: string, value: string | undefined): void => {
    if (secretNames.has(name)) {
      updates.secrets[name] = value;
      layers.environment.secrets = { ...layers.environment.secrets };
      if (value === undefined) delete layers.environment.secrets[name];
      else layers.environment.secrets[name] = value;
      delete layers.runtime[name];
      return;
    }
    if (value === undefined) delete layers.runtime[name];
    else layers.runtime[name] = value;
  };
  const applyEnv = (next: Record<string, string>): void => {
    const current = envVariables(layers.environment);
    for (const [k, v] of Object.entries(next)) {
      if (current[k] === v) continue;
      if (secretNames.has(k)) setRuntime(k, v);
      else {
        layers.environment.session[k] = v;
        updates.session[k] = v;
      }
    }
    for (const k of Object.keys(layers.environment.session)) {
      if (!(k in next)) {
        delete layers.environment.session[k];
        updates.session[k] = undefined;
      }
    }
  };
  const applyRuntime = (next: Record<string, string>): void => {
    for (const k of Object.keys(layers.runtime)) if (!(k in next)) delete layers.runtime[k];
    for (const [k, v] of Object.entries(next)) if (layers.runtime[k] !== v) setRuntime(k, v);
  };

  const resolved = () => resolveLayers(layers);
  const sandboxRequest = (): SandboxRequest => {
    const r = resolved();
    const bodyText = working.body.mode === 'json' ? working.body.json : working.body.mode === 'text' ? working.body.text : working.body.mode === 'xml' ? working.body.xml : undefined;
    return {
      method: working.method,
      url: working.url,
      headers: Object.fromEntries(working.headers.map((h) => [h.name, h.value])),
      data: working.body.mode === 'formUrlEncoded' ? Object.fromEntries(enabled(working.body.formUrlEncoded).map((f) => [f.name, f.value]))
        // Scripts see multipart text fields; file fields are left out (their bytes never reach the sandbox).
        : working.body.mode === 'multipartForm' ? Object.fromEntries((working.body.multipartForm ?? []).filter((f) => f.enabled && f.type === 'text' && f.name).map((f) => [f.name, f.value]))
        : bodyText,
      collectionVariables: r.collection,
      folderVariables: r.folder,
      requestVariables: r.request
    };
  };
  // ---------- bru.sendRequest: child runs with this run's TLS, cookie jar, timeout default, masking and cancel ----------
  const scriptRequests: ScriptRequest[] = [];
  const scriptOutputs: NonNullable<RunOutput['scriptRequests']> = [];
  let scriptRequestSeq = 0;
  /** Hooks for one script: its own allowance of requests. */
  const hooksFor = (stage: ScriptStage): SandboxHooks => {
    let count = 0;
    return {
      signal: opts.signal,
      sendRequest: async (config, scriptCookies, signal) => {
        const refuse = (message: string): { reply: ScriptSendReply } => ({ reply: { ok: false, error: { name: 'Error', message } } });
        if (++count > MAX_SCRIPT_REQUESTS) return refuse(`bru.sendRequest: a script can send at most ${MAX_SCRIPT_REQUESTS} requests`);
        let child: { doc: RequestDoc; prepared: Prepared };
        try {
          const o = scriptOptions(config);
          const prepared = prepareScriptRequest(o, USER_AGENT);
          child = { doc: scriptRequestDoc(o, prepared), prepared };
        } catch (e) {
          if (e instanceof ScriptRequestError) return refuse(e.message);
          throw e;
        }
        // The script's own cookie changes first, so the request sees them.
        if (scriptCookies) opts.cookies?.replace(scriptCookies);
        const runId = `${opts.runId}.${++scriptRequestSeq}`;
        const startedAt = Date.now();
        const out = await run(child.doc, {
          runId,
          environment,
          layers,
          tls: opts.tls,
          proxy: opts.proxy,
          collectionPath,
          defaultTimeoutMs: opts.defaultTimeoutMs,
          maxBodyBytes: opts.maxBodyBytes,
          signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal,
          cookies: opts.cookies,
          prepared: child.prepared,
          mask: [...extraMask]
        });
        scriptRequests.push({ stage, startedAt, result: out.result });
        scriptOutputs.push({ runId, sent: out.sent, cookieValues: out.cookieValues });
        const c = out.result;
        timeline.push({ atMs: at(), label: 'Script request', detail: `${stage}: ${c.request.method} ${c.request.url} → ${c.outcome === 'http' ? `${c.status} · ${c.durationMs} ms` : (c.error?.message ?? c.outcome)}` });
        return { reply: scriptReply(out), cookies: opts.cookies?.serialize() };
      }
    };
  };
  const runScript = async (stage: ScriptStage, job: Parameters<SandboxHost['run']>[0]): Promise<SandboxResult | null> => {
    if (opts.scriptsBlocked) {
      scriptErrors.push({ stage, message: `Not run: ${opts.scriptsBlocked}` });
      return null;
    }
    if (!opts.sandbox) {
      scriptErrors.push({ stage, message: 'Scripts need the sandbox, which is not available here' });
      return null;
    }
    const r = await opts.sandbox.run(job, hooksFor(stage));
    if (r.cookies) opts.cookies?.replace(r.cookies);
    for (const l of r.logs) consoleOut.push({ stage, level: l.level, text: l.text });
    if (r.envVariables) applyEnv(stringMap(r.envVariables));
    if (r.runtimeVariables) applyRuntime(stringMap(r.runtimeVariables));
    if (!r.ok) scriptErrors.push({ stage, message: r.error ?? 'Script failed' });
    return r;
  };
  const jobBase = () => ({
    envVariables: { ...envVariables(layers.environment), __name__: environment } as Record<string, string>,
    runtimeVariables: { ...layers.runtime },
    collectionPath,
    collectionName,
    processEnv,
    cookies: opts.cookies?.serialize()
  });
  const namedSecrets = (): { name: string; value: string }[] => {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(layers.environment.secrets)) if (v) out.set(v, k);
    for (const [k, v] of Object.entries(updates.secrets)) if (v) out.set(v, k);
    for (const v of extraMask) if (v && !out.has(v)) out.set(v, 'auth');
    return [...out.entries()].map(([value, name]) => ({ name, value }));
  };
  const secretValues = (): string[] => [...Object.values(layers.environment.secrets), ...Object.values(updates.secrets).filter((v): v is string => !!v), ...extraMask];
  let wire: WireRecorder | null = null;
  let cookieUse: CookieUse | undefined;
  let oauth2Use: OAuth2Use | undefined;
  const oauthSecrets = new Set<string>();
  const rememberOAuthSecrets = (...values: (string | undefined)[]): void => {
    for (const value of values) if (value) {
      oauthSecrets.add(value);
      extraMask.push(value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2));
    }
  };
  const maskOAuth = (s: string): string => maskOAuth2Text(s, [...oauthSecrets]);
  let cookieSource: 'jar' | 'request' = 'request';
  let cookieValues: string[] = [];
  const result = (partial: Partial<RunResult> & Pick<RunResult, 'outcome'>, request: RunResult['request']): RunResult => {
    const maskOther = masker(secretValues());
    const mask = (s: string): string => maskOther(maskOAuth(s));
    const captured = captureCookies(wire?.hops ?? [], cookieSource);
    cookieValues = captured.map((c) => c.value);
    const maskSent = (headers: [string, string][]): [string, string][] => headers.map(([k, v]) => [k, SENT_SENSITIVE.test(k) ? '••••••' : mask(v)]);
    const hop = (h: WireHop): NetworkHop => ({ ...h, url: mask(h.url), requestHeaders: maskSent(h.requestHeaders), responseHeaders: h.responseHeaders.map(([k, v]) => [k, mask(v)]) });
    return {
      runId: opts.runId,
      durationMs: at(),
      sizeBytes: 0,
      environment,
      scriptErrors: scriptErrors.map((e) => ({ ...e, message: mask(e.message) })),
      extractions: extractions.map((e) => ({ ...e, message: e.message === undefined ? undefined : maskOAuth(e.message) })),
      console: consoleOut.map((c) => ({ ...c, text: mask(c.text) })),
      timeline: timeline.map((t) => ({ ...t, detail: t.detail === undefined ? undefined : mask(t.detail) })),
      tests: tests.map((t) => ({ ...t, name: maskOAuth(t.name), message: t.message === undefined ? undefined : mask(t.message) })),
      testsState: hasTests ? 'not-run' : 'none',
      testsNote: hasTests ? 'Not run: no HTTP response' : undefined,
      ...partial,
      headers: (partial.headers ?? []).map(([k, v]) => [k, maskOAuth(v)]),
      body: partial.body ? { ...partial.body, text: maskOAuth(partial.body.text) } : empty,
      error: partial.error ? { ...partial.error, message: maskOAuth(partial.error.message) } : undefined,
      requestBody: partial.requestBody === undefined ? undefined : mask(partial.requestBody),
      multipart: partial.multipart?.map((p) => ({ ...p, value: p.value === undefined ? undefined : mask(p.value), path: p.path === undefined ? undefined : mask(p.path) })),
      request: { method: request.method, url: mask(request.url), headers: maskSent(request.headers) },
      hops: wire?.hops.length ? wire.hops.map(hop) : undefined,
      cookies: cookieUse,
      oauth2: oauth2Use ? { ...oauth2Use, note: oauth2Use.note === undefined ? undefined : mask(oauth2Use.note) } : undefined,
      cookieDetails: wire?.hops.length ? captured.map((c) => cookieMetadata(c.metadata, mask)) : undefined,
      scriptRequests: scriptRequests.length ? [...scriptRequests] : undefined
    };
  };
  const finishUpdates = (): VariableUpdates => {
    // The full new runtime map: the caller replaces the environment's runtime set with it.
    return { ...updates, runtime: { ...layers.runtime } };
  };

  // ---------- pre-request scripts: collection, then folders, then the request ----------
  const preScripts = [opts.inherited?.collection.script.req, ...(opts.inherited?.folders ?? []).map((f) => f.script.req), snapshot.script.req].filter((s): s is string => !!s?.trim());
  for (const script of preScripts) {
    // Blocked scripts are reported but don't stop the request: it is sent as written.
    if (opts.scriptsBlocked) {
      scriptErrors.push({ stage: 'pre-request', message: `Not run: ${opts.scriptsBlocked}` });
      continue;
    }
    const r = await runScript('pre-request', { kind: 'pre-request', script, request: sandboxRequest(), ...jobBase() });
    if (r?.cancelled) {
      scriptErrors.pop();
      timeline.push({ atMs: at(), label: 'Cancelled', detail: 'Cancelled during the pre-request script' });
      return { result: result({ outcome: 'cancelled', error: { message: 'Cancelled' } }, { method: working.method, url: working.url, headers: [] }), bodyBytes: Buffer.alloc(0), updates: finishUpdates(), secrets: namedSecrets(), scriptRequests: scriptOutputs };
    }
    if (!r || !r.ok) {
      const message = `Pre-request script failed: ${scriptErrors.at(-1)?.message ?? 'unknown error'}`;
      timeline.push({ atMs: at(), label: 'Not sent', detail: message });
      return { result: result({ outcome: 'prepare_error', durationMs: 0, error: { message } }, { method: working.method, url: working.url, headers: [] }), bodyBytes: Buffer.alloc(0), updates: finishUpdates(), secrets: namedSecrets(), scriptRequests: scriptOutputs };
    }
    if (r.request) {
      working.method = (String(r.request.method ?? working.method).toUpperCase() as HttpMethod) || working.method;
      working.url = String(r.request.url ?? working.url);
      working.headers = Object.entries(r.request.headers ?? {}).map(([name, value]) => ({ name, value: String(value), enabled: true }));
      const d = r.request.data;
      if (working.body.mode === 'json' && d !== undefined) working.body = { ...working.body, json: typeof d === 'string' ? d : JSON.stringify(d) };
      if ((working.body.mode === 'text' || working.body.mode === 'xml') && typeof d === 'string') working.body = { ...working.body, [working.body.mode]: d };
    }
  }

  // ---------- resolve, interpolate, validate ----------
  const vars: Record<string, unknown> = { ...resolved().values, process: { env: processEnv } };
  const I = (s: string): string => String(interpolate(s, vars));
  const oauthCfg = auth.mode === 'oauth2' ? resolveOAuth2(auth.oauth2, I) : null;
  if (oauthCfg) rememberOAuthSecrets(oauthCfg.clientSecret, oauthCfg.password);
  let prepared: Prepared;
  try {
    // With OAuth2, everything is validated first, so no token is fetched for a request that can't be sent.
    prepared = opts.prepared ? structuredClone(opts.prepared) : prepare(working, vars, auth, auth.mode === 'oauth2' ? TOKEN_PLACEHOLDER : undefined);
  } catch (e) {
    const message = (e as Error).message;
    timeline.push({ atMs: 0, label: 'Not sent', detail: message });
    return { result: result({ outcome: 'prepare_error', durationMs: 0, error: { message } }, { method: working.method, url: working.url, headers: [] }), bodyBytes: Buffer.alloc(0), updates: finishUpdates(), secrets: namedSecrets(), scriptRequests: scriptOutputs };
  }
  // Multipart files are checked before anything is sent, OAuth2 token requests included.
  let parts: MultipartPart[] | undefined;
  let encoded: EncodedMultipart | undefined;
  if (prepared.multipart) {
    try {
      parts = await loadParts(prepared.multipart, collectionPath);
    } catch (e) {
      if (!(e instanceof MultipartFileError)) throw e;
      timeline.push({ atMs: 0, label: 'Not sent', detail: e.message });
      return { result: result({ outcome: 'prepare_error', durationMs: 0, error: { message: e.message } }, { method: working.method, url: working.url, headers: [] }), bodyBytes: Buffer.alloc(0), updates: finishUpdates(), secrets: namedSecrets(), scriptRequests: scriptOutputs };
    }
    encoded = encodeMultipart(parts);
  }
  /** Sets the multipart Content-Type (with its boundary) and length, replacing any Content-Type the request set. */
  const withBody = (p: Prepared): Prepared => {
    if (!encoded) return p;
    for (const k of Object.keys(p.headers)) if (/^content-(type|length)$/i.test(k)) delete p.headers[k];
    p.headers['Content-Type'] = encoded.contentType;
    p.headers['Content-Length'] = String(encoded.length);
    return p;
  };
  const sentBody = (): Pick<RunResult, 'requestBody' | 'multipart'> => (parts ? { requestBody: describeParts(parts), multipart: parts } : { requestBody: prepared.data });
  withBody(prepared);
  // Mask credentials that came from auth settings too (e.g. a Basic password typed into the request).
  for (const v of authSecrets(auth)) extraMask.push(I(v));

  const timeoutMs = snapshot.settings.timeoutMs > 0 ? snapshot.settings.timeoutMs : opts.defaultTimeoutMs;
  // An Authorization header set on the request wins over the auth settings.
  const ownAuthorization = Object.keys(prepared.headers).some((k) => k.toLowerCase() === 'authorization');
  const challenge = opts.prepared || ownAuthorization ? null : challengeAuth(auth, I);
  // NTLM authenticates the connection, so its handshake gets one of its own, closed after the run.
  const ownAgents = challenge?.sameConnection ? newAgents(opts.tls, { maxSockets: 1 }, opts.proxy) : undefined;
  const { http: httpAgent, https: httpsAgent } = ownAgents ?? getAgents(opts.tls, opts.proxy);

  // ---------- OAuth2: a cached token, or a new one (shared with sends running at the same time) ----------
  const tokenCache = opts.oauth2?.cache ?? new TokenCache();
  const tokenScope = opts.oauth2?.scope ?? '';
  // Same TLS settings as the request itself.
  const fetchToken: TokenFetcher = (cfg, previous, signal) => fetchOAuth2Token(cfg, previous, { httpAgent, httpsAgent, timeoutMs, userAgent: USER_AGENT, signal });
  const tokenFailure = (e: unknown): { outcome: RunResult['outcome']; message: string; code?: string } => {
    if (e instanceof TokenError) return { outcome: 'prepare_error', message: `OAuth2 token request failed: ${e.message}` };
    const c = classify(e);
    return c.outcome === 'cancelled' ? c : { outcome: 'prepare_error', message: `OAuth2 token request failed: ${c.message}`, code: c.code };
  };
  const notSent = (f: { outcome: RunResult['outcome']; message: string; code?: string }): RunOutput => {
    timeline.push({ atMs: at(), label: f.outcome === 'cancelled' ? 'Cancelled' : 'Not sent', detail: f.message });
    clearExtractions(`Not sent (${f.message})`);
    return { result: result({ outcome: f.outcome, error: { message: f.message, code: f.code } }, { method: working.method, url: working.url, headers: [] }), bodyBytes: Buffer.alloc(0), updates: finishUpdates(), secrets: namedSecrets(), scriptRequests: scriptOutputs };
  };
  let token: TokenEntry | undefined;
  if (oauthCfg) {
    const o = auth.oauth2;
    const cached = tokenCache.peek(tokenScope, oauthCfg);
    rememberOAuthSecrets(cached?.accessToken, cached?.refreshToken);
    let how: OAuth2Use['token'] = 'cached';
    if (cached && !isExpired(cached)) token = cached;
    else {
      if (oauthCfg.grantType === OAUTH2_AUTHORIZATION_CODE && !cached?.refreshToken) {
        return notSent(tokenFailure(new TokenError('Use Get token in the Auth tab to sign in before sending this request.')));
      }
      // Either switch allows renewal (Bruno files often have auto fetch on and auto refresh off). With a refresh
      // token the refresh grant is tried first; otherwise the grant runs again.
      if (!(cached ? o.autoRefreshToken || o.autoFetchToken : o.autoFetchToken)) {
        return notSent({ outcome: 'prepare_error', message: cached ? 'The OAuth2 token has expired and automatic renewal is off. Use Get token in the Auth tab.' : 'There is no OAuth2 token yet and automatic fetching is off. Use Get token in the Auth tab.' });
      }
      how = cached ? 'renewed' : 'fetched';
      try {
        token = await tokenCache.fetch(tokenScope, oauthCfg, fetchToken, opts.signal);
      } catch (e) {
        return notSent(tokenFailure(e));
      }
    }
    rememberOAuthSecrets(token.accessToken, token.refreshToken);
    oauth2Use = { token: how, expiresAt: token.expiresAt === undefined ? undefined : new Date(token.expiresAt).toISOString() };
    const label = { cached: 'Cached token', fetched: `New token from ${oauthCfg.accessTokenUrl}`, renewed: `Expired token renewed from ${oauthCfg.accessTokenUrl}` }[how];
    timeline.push({ atMs: at(), label: 'OAuth2 token', detail: `${label}${token.expiresAt ? `, expires in ${expiresIn(token.expiresAt)}` : ''}` });
    prepared = withBody(prepare(working, vars, auth, token.accessToken));
  }

  // Stored cookies, unless the request sets its own Cookie header or opts out. Responses are stored either way.
  const jar = opts.cookies;
  const ownCookie = Object.keys(prepared.headers).some((k) => k.toLowerCase() === 'cookie');
  const sendStored = !!jar && !ownCookie && snapshot.settings.sendCookies !== false;
  cookieSource = ownCookie ? 'request' : 'jar';
  const use: CookieUse = { source: ownCookie ? 'request' : 'none', sent: [], stored: [] };
  cookieUse = use;
  const addStoredCookies = (p: Prepared): void => {
    if (!sendStored) return;
    const header = jar!.header(p.url);
    if (header) {
      p.headers.Cookie = header;
      use.source = 'jar';
      use.sent = cookieNames(header);
    }
  };
  addStoredCookies(prepared);
  const storeCookies = (url: string, setCookie: string | string[] | undefined): void => {
    if (!jar || !setCookie) return;
    for (const name of jar.store(url, Array.isArray(setCookie) ? setCookie : [setCookie])) if (!use.stored.includes(name)) use.stored.push(name);
  };

  // AWS: signed last, over the request exactly as it will go out (cookies included, the body hashed).
  if (auth.mode === 'awsv4' && !ownAuthorization && !opts.prepared) {
    const w = auth.awsv4;
    let bodyHash: string;
    try {
      bodyHash = encoded ? await hashStream(encoded.stream()) : sha256Hex(prepared.data ?? '');
    } catch (e) {
      return notSent({ outcome: 'prepare_error', message: `Couldn't read the body to sign it: ${(e as Error).message}` });
    }
    const creds = { accessKeyId: I(w.accessKeyId).trim(), secretAccessKey: I(w.secretAccessKey).trim(), sessionToken: I(w.sessionToken).trim() || undefined, service: I(w.service).trim(), region: I(w.region).trim() };
    Object.assign(prepared.headers, signRequest({ method: prepared.method, url: prepared.url, headers: prepared.headers, bodyHash }, creds));
    timeline.push({ atMs: at(), label: 'AWS Signature v4', detail: `Signed for ${creds.service} in ${creds.region}` });
  }
  if (challenge?.initial) prepared.headers.Authorization = challenge.initial;

  // The proxy decision up front: a bad proxy setting stops the send here, and plain HTTP knows where to go.
  let via = '';
  if (opts.proxy) {
    try {
      const p = await opts.proxy.resolve(new URL(prepared.url));
      if (p) via = ` via proxy ${proxyName(p)}`;
    } catch (e) {
      if (!(e instanceof ProxyError)) throw e;
      return notSent({ outcome: 'prepare_error', message: e.message });
    }
  }
  let requestInfo: RunResult['request'] = { method: prepared.method, url: prepared.url, headers: Object.entries(prepared.headers) };
  timeline.push({ atMs: at(), label: 'Request sent', detail: `${prepared.method} ${prepared.url}${via}${opts.tls?.skipVerify ? ' (TLS verification off)' : ''}` });

  // ---------- send: one deadline for the whole exchange, one abort path for cancel and timeout ----------
  const ac = new AbortController();
  let timedOut = false;
  const onUserAbort = (): void => ac.abort();
  opts.signal?.addEventListener('abort', onUserAbort, { once: true });
  if (opts.signal?.aborted) ac.abort();
  const deadline = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  const classifyRun = (e: unknown): ReturnType<typeof classify> => (timedOut ? { outcome: 'timeout', message: `Timed out after ${timeoutMs} ms`, code: 'ETIMEDOUT' } : classify(e));
  const finish = (): void => {
    clearTimeout(deadline);
    opts.signal?.removeEventListener('abort', onUserAbort);
    ownAgents?.http.destroy();
    ownAgents?.https.destroy();
  };

  const recorder = new WireRecorder();
  wire = recorder;
  const onRedirect = (e: RedirectEvent): void => {
    // follow-redirects drops Authorization on cross-host redirects; put it back only when allowed.
    if (snapshot.settings.forwardAuthorizationHeader && prepared.headers.Authorization && !e.nextHeaders.Authorization && !e.nextHeaders.authorization) {
      e.nextHeaders.Authorization = prepared.headers.Authorization;
    }
    storeCookies(e.fromUrl, e.responseHeaders['set-cookie']);
    if (sendStored) {
      for (const k of Object.keys(e.nextHeaders)) if (k.toLowerCase() === 'cookie') delete e.nextHeaders[k];
      const header = jar!.header(e.nextUrl);
      if (header) e.nextHeaders.Cookie = header;
    }
    timeline.push({ atMs: at(), label: `Redirect ${e.status}`, detail: `${e.nextMethod} ${e.nextUrl}` });
  };
  const send = (p: Prepared): Promise<AxiosResponse<Readable>> =>
    axios.request<Readable>({
      method: p.method,
      url: p.url,
      headers: p.headers,
      data: encoded ? encoded.stream() : p.data,
      responseType: 'stream',
      signal: ac.signal,
      transport: recorder.transport({ url: p.url, followRedirects: snapshot.settings.followRedirects, maxRedirects: snapshot.settings.maxRedirects, onRedirect }),
      validateStatus: () => true,
      httpAgent,
      httpsAgent,
      // The agents handle proxies; axios's own (from environment variables) would bypass them.
      proxy: false,
      // Bodies are bounded by maxBodyBytes below, not by axios.
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  const failed = (e: unknown): RunOutput => {
    finish();
    recorder.end();
    const c = classifyRun(e);
    timeline.push({ atMs: at(), label: c.outcome === 'cancelled' ? 'Cancelled' : 'Failed', detail: c.message });
    clearExtractions(`No response (${c.message})`);
    return { result: result({ outcome: c.outcome, error: { message: c.message, code: c.code } }, requestInfo), bodyBytes: Buffer.alloc(0), updates: finishUpdates(), secrets: namedSecrets(), sent: sentRequest(), cookieValues, scriptRequests: scriptOutputs };
  };
  let response: AxiosResponse<Readable>;
  try {
    response = await send(prepared);
  } catch (e) {
    return failed(e);
  }
  storeCookies(recorder.hops.at(-1)?.url ?? prepared.url, response.headers['set-cookie']);

  // ---------- Digest and NTLM: answer the server's 401 challenge and send once more ----------
  if (challenge && response.status === 401) {
    const header = response.headers['www-authenticate'];
    let answer: string | null = null;
    let note = `The 401 response has no ${challenge.name} challenge`;
    try {
      answer = challenge.answer(Array.isArray(header) ? header.join(', ') : String(header ?? ''), prepared.method, prepared.url);
    } catch (e) {
      if (!(e instanceof ChallengeError)) throw e;
      note = `Not answered: ${e.message}`;
    }
    if (answer === null) timeline.push({ atMs: at(), label: `${challenge.name} challenge`, detail: note });
    else {
      // Read the 401 to the end, so its connection is free for the next send (NTLM needs that very connection).
      await drain(response.data);
      prepared.headers.Authorization = answer;
      requestInfo = { method: prepared.method, url: prepared.url, headers: Object.entries(prepared.headers) };
      timeline.push({ atMs: at(), label: `${challenge.name} challenge`, detail: 'Re-sent with credentials' });
      try {
        response = await send(prepared);
      } catch (e) {
        return failed(e);
      }
      storeCookies(recorder.hops.at(-1)?.url ?? prepared.url, response.headers['set-cookie']);
    }
  }

  // ---------- OAuth2: a 401 for a cached token means it was revoked or expired early ----------
  // A token fetched for this run is never retried: a 401 then points at the configuration, not the token.
  if (oauthCfg && token && oauth2Use?.token === 'cached' && response.status === 401 && (auth.oauth2.autoRefreshToken || auth.oauth2.autoFetchToken)) {
    tokenCache.invalidate(tokenScope, oauthCfg, token);
    if (!SAFE_METHODS.has(prepared.method)) {
      oauth2Use.note = `The server rejected the cached OAuth2 token (401), so it was discarded. ${prepared.method} requests aren't re-sent automatically because they may change data: send again to use a new token.`;
      timeline.push({ atMs: at(), label: 'OAuth2 token rejected', detail: 'Discarded; not re-sent automatically' });
    } else {
      let fresh: TokenEntry | undefined;
      try {
        const latest = tokenCache.peek(tokenScope, oauthCfg);
        fresh = latest && latest !== token && !isExpired(latest) ? latest : await tokenCache.fetch(tokenScope, oauthCfg, fetchToken, ac.signal);
      } catch (e) {
        oauth2Use.note = `The server rejected the cached OAuth2 token (401), and a new one couldn't be fetched. ${tokenFailure(e).message}`;
        timeline.push({ atMs: at(), label: 'OAuth2 token rejected', detail: 'A new token could not be fetched' });
      }
      if (fresh) {
        rememberOAuthSecrets(fresh.accessToken, fresh.refreshToken);
        response.data.destroy();
        prepared = withBody(prepare(working, vars, auth, fresh.accessToken));
        addStoredCookies(prepared);
        requestInfo = { method: prepared.method, url: prepared.url, headers: Object.entries(prepared.headers) };
        oauth2Use = { token: 'renewed', retried: true, expiresAt: fresh.expiresAt === undefined ? undefined : new Date(fresh.expiresAt).toISOString() };
        timeline.push({ atMs: at(), label: 'OAuth2 token rejected', detail: 'Re-sent once with a new token' });
        try {
          response = await send(prepared);
        } catch (e) {
          return failed(e);
        }
        storeCookies(recorder.hops.at(-1)?.url ?? prepared.url, response.headers['set-cookie']);
      }
    }
  }

  timeline.push({ atMs: at(), label: 'Response headers', detail: `${response.status} ${response.statusText ?? ''}`.trim() });
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let bodyError: { outcome: RunResult['outcome']; message: string; code?: string } | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = response.data;
      stream.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = opts.maxBodyBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size += room;
          truncated = true;
          stream.destroy();
          resolve();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.once('end', () => resolve());
      stream.once('error', (e) => (truncated ? resolve() : reject(e)));
      const onAbort = (): void => {
        stream.destroy(Object.assign(new Error('Cancelled'), { code: 'ERR_CANCELED' }));
      };
      if (ac.signal.aborted) onAbort();
      else ac.signal.addEventListener('abort', onAbort, { once: true });
    });
  } catch (e) {
    bodyError = classifyRun(e);
  } finally {
    finish();
    recorder.end();
  }

  const bodyBytes = Buffer.concat(chunks);
  const headers = headerEntries(response.headers as Record<string, unknown>);
  const contentType = String(response.headers['content-type'] ?? '');
  const binary = looksBinary(bodyBytes, contentType);
  const text = binary ? '' : bodyBytes.toString('utf8');
  timeline.push({ atMs: at(), label: truncated ? 'Body truncated' : 'Body received', detail: `${bodyBytes.length} bytes${truncated ? ` (limit ${opts.maxBodyBytes})` : ''}` });

  if (bodyError) {
    // Headers arrived but the body didn't finish: report the failure, never a partial success.
    timeline.push({ atMs: at(), label: 'Failed', detail: bodyError.message });
    clearExtractions(`Response incomplete (${bodyError.message})`);
    return {
      result: result({ outcome: bodyError.outcome, sizeBytes: bodyBytes.length, headers, body: { text, contentType, truncated: true, binary }, error: { message: bodyError.message, code: bodyError.code }, testsNote: hasTests ? 'Not run: the response did not complete' : undefined, ...sentBody() }, requestInfo),
      bodyBytes,
      updates: finishUpdates(),
      secrets: namedSecrets(),
      sent: sentRequest(), cookieValues, scriptRequests: scriptOutputs
    };
  }

  // ---------- post-response: variables (token extraction), then scripts (request, folders, collection) ----------
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const sandboxResponse: SandboxResponse = {
    status: response.status,
    statusText: response.statusText ?? '',
    headers: Object.fromEntries(headers.map(([k, v]) => [k, v])),
    data,
    responseTime: at()
  };
  const sreq: SandboxRequest = { ...sandboxRequest(), method: prepared.method, url: prepared.url, headers: prepared.headers, data: prepared.multipart ? sandboxRequest().data : prepared.data };
  const postVars = enabled(snapshot.vars.res);
  if (postVars.length) {
    if (truncated) clearExtractions('Not run: the response exceeded the processing limit');
    else {
      const r = await runScript('post-response vars', { kind: 'post-vars', vars: postVars, request: sreq, response: sandboxResponse, ...jobBase() });
      const ok2xx = response.status >= 200 && response.status < 300;
      for (const v of postVars) {
        const target = secretNames.has(v.name) ? 'secret' : 'runtime';
        const raw = r?.runtimeVariables?.[v.name];
        const value = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : undefined;
        let message: string | undefined;
        if (!r) message = 'Sandbox not available';
        else if (!ok2xx) message = `Response was ${response.status}, not 2xx`;
        else if (!value) message = `${v.value} is empty or not a string`;
        if (message) {
          // Never silently reuse an old token from this auth flow.
          setRuntime(v.name, undefined);
          extractions.push({ variable: v.name, expression: v.value, ok: false, target, message });
        } else {
          setRuntime(v.name, value);
          extractions.push({ variable: v.name, expression: v.value, ok: true, target });
        }
      }
    }
  }
  const postScripts = [snapshot.script.res, ...[...(opts.inherited?.folders ?? [])].reverse().map((f) => f.script.res), opts.inherited?.collection.script.res].filter((s): s is string => !!s?.trim());
  if (postScripts.length && truncated) scriptErrors.push({ stage: 'post-response', message: 'Not run: the response exceeded the processing limit' });
  else for (const script of postScripts) await runScript('post-response', { kind: 'post-response', script, request: sreq, response: sandboxResponse, ...jobBase() });

  // ---------- assertions, then tests (collection, folders, request) ----------
  let testsState: RunResult['testsState'] = 'none';
  let testsNote: string | undefined;
  if (hasTests && truncated) {
    testsState = 'not-run';
    testsNote = 'Not run: the response exceeded the processing limit, so tests would see a partial body';
  } else if (hasTests && opts.scriptsBlocked) {
    testsState = 'not-run';
    testsNote = `Not run: ${opts.scriptsBlocked}`;
  } else if (hasTests && !opts.sandbox) {
    testsState = 'not-run';
    testsNote = 'Not run: the sandbox is not available';
  } else if (hasTests) {
    testsState = 'ran';
    if (assertions.length) {
      const r = await opts.sandbox!.run({ kind: 'assertions', assertions, request: sreq, response: sandboxResponse, ...jobBase() });
      if (!r.ok) for (const x of assertions) tests.push({ name: `${x.name} ${x.value}`, kind: 'assertion', status: 'error', message: r.error ?? 'Assertion failed to run', source: 'request' });
      else for (const raw of r.results ?? []) tests.push(toAssertion(raw));
    }
    for (const t of testSources) {
      const r = await opts.sandbox!.run({ kind: 'tests', script: t.script, request: sreq, response: sandboxResponse, ...jobBase() }, hooksFor('tests'));
      if (r.cookies) opts.cookies?.replace(r.cookies);
      for (const l of r.logs) consoleOut.push({ stage: 'tests', level: l.level, text: l.text });
      for (const raw of r.results ?? []) tests.push(toTest(raw, t.source));
      if (!r.ok) tests.push({ name: `Tests script (${t.source})`, kind: 'test', status: 'error', message: r.error ?? 'Script failed', source: t.source });
      else if (!(r.results ?? []).length) tests.push({ name: `No test() calls in the ${t.source} tests`, kind: 'test', status: 'error', message: 'The tests script ran but defined no tests', source: t.source });
    }
  }

  return {
    result: result({ outcome: 'http', status: response.status, statusText: response.statusText, sizeBytes: bodyBytes.length, headers, body: { text, contentType, truncated, binary }, testsState, testsNote, ...sentBody() }, requestInfo),
    bodyBytes,
    updates: finishUpdates(),
    secrets: namedSecrets(),
    sent: sentRequest(), cookieValues, scriptRequests: scriptOutputs
  };

  /**
   * The last request on the wire as sent: the recorded headers when there are some, else the prepared ones. The
   * proxy's own sign-in stays out (it is for the proxy, and copied elsewhere it would go to the API).
   */
  function sentRequest(): RunOutput['sent'] {
    const last = recorder.hops.at(-1);
    const ownProxyAuth = Object.keys(prepared.headers).some((k) => k.toLowerCase() === 'proxy-authorization');
    const wire = last?.requestHeaders.filter(([k]) => ownProxyAuth || k.toLowerCase() !== 'proxy-authorization');
    return {
      method: last?.method ?? prepared.method,
      url: last?.url ?? prepared.url,
      headers: wire?.length ? wire : Object.entries(prepared.headers),
      body: prepared.data,
      form: parts
    };
  }

  function clearExtractions(message: string): void {
    for (const v of enabled(snapshot.vars.res)) {
      setRuntime(v.name, undefined);
      extractions.push({ variable: v.name, expression: v.value, ok: false, target: secretNames.has(v.name) ? 'secret' : 'runtime', message });
    }
  }
}


/** Request header names whose values are never shown, even outside history. */
const SENT_SENSITIVE = /^(authorization|proxy-authorization|cookie|x-amz-security-token)$/i;

/** Reads a response body to the end without keeping it. */
const drain = (s: Readable): Promise<void> =>
  new Promise((resolve) => {
    s.once('end', resolve);
    s.once('close', resolve);
    s.once('error', () => resolve());
    s.resume();
  });

async function hashStream(s: Readable): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of s) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** "52 min", for timeline entries about token expiry. */
const expiresIn = (at: number): string => {
  const minutes = Math.round((at - Date.now()) / 60_000);
  return minutes >= 1 ? `${minutes} min` : 'under a minute';
};

const cookieNames = (header: string): string[] => header.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean);

function collectionLabel(opts: RunOptions): string {
  return opts.collectionName || opts.inherited?.collection.name || 'collection';
}

/** A test whose failure is a fault in the script (not a failed expectation) is an error, never a fail or a pass. */
const SCRIPT_FAULT = /Invalid Chai property|is not a function|is not defined|Cannot read propert|Unexpected token|SyntaxError|timed out/i;

function toTest(raw: RawResult, source: string): TestResult {
  const message = raw.error ? String(raw.error) : undefined;
  const status: TestResult['status'] = raw.status === 'pass' ? 'passed' : message && SCRIPT_FAULT.test(message) ? 'error' : 'failed';
  return { name: String(raw.description ?? 'unnamed test'), kind: 'test', status, message, source };
}

function toAssertion(raw: RawResult): TestResult {
  const message = raw.error ? String(raw.error) : undefined;
  const status: TestResult['status'] = raw.status === 'pass' ? 'passed' : message && SCRIPT_FAULT.test(message) ? 'error' : 'failed';
  return { name: `${raw.lhsExpr ?? ''} ${raw.rhsExpr ?? ''}`.trim(), kind: 'assertion', status, message, source: 'request' };
}
