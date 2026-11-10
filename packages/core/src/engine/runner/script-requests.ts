// bru.sendRequest: the options a script passes, turned into a request for the runner, and the run turned back
// into what the script gets. The shapes follow Bruno's own bru.sendRequest, which is a thin axios call:
//   bru.sendRequest(urlOrOptions) -> Promise<response>; rejects for a non-2xx status or no response
//   bru.sendRequest(options, (err, res) => ...) -> the callback form (@usebruno/js adds it inside QuickJS)
//   options: { url, method, headers, data, params, auth: { username, password }, timeout, maxRedirects, baseURL }
//   response: { status, statusText, headers, data, responseTime }
//   error: { name, message, code, status, response }
// As in Bruno, nothing in the options is interpolated: scripts build values with bru.getEnvVar() and friends.
import { utils as brunoUtils } from '@usebruno/common';
import { emptyAuth, HTTP_METHODS, type HttpMethod, type RequestDoc } from '../../shared/model';
import type { ScriptHttpError, ScriptHttpResponse, ScriptSendReply } from '../sandbox/host';
import type { MultipartInput } from './multipart';
import type { Prepared, RunOutput } from './runner';

/** Requests one script may send. More fail in the script with an explanation. */
export const MAX_SCRIPT_REQUESTS = 10;

export class ScriptRequestError extends Error {}

export interface ScriptRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, unknown>;
  data?: unknown;
  params?: Record<string, unknown>;
  auth?: { username?: string; password?: string };
  timeout?: number;
  maxRedirects?: number;
  baseURL?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates what a script passed: a URL string or an options object. */
export function scriptOptions(config: unknown): ScriptRequestOptions {
  if (typeof config === 'string') return { url: config };
  if (!isObject(config)) throw new ScriptRequestError('bru.sendRequest needs a URL or an options object with a url');
  if (typeof config.url !== 'string' || !config.url.trim()) throw new ScriptRequestError('bru.sendRequest needs a url');
  if (config.headers !== undefined && !isObject(config.headers)) throw new ScriptRequestError('bru.sendRequest: headers must be an object of name: value');
  if (config.params !== undefined && !isObject(config.params)) throw new ScriptRequestError('bru.sendRequest: params must be an object of name: value');
  return config as unknown as ScriptRequestOptions;
}

const headerValue = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : Array.isArray(v) ? v.join(', ') : String(v));

/**
 * The request as the runner sends it. Bodies follow axios: an object is sent as JSON, as a URL-encoded form or as
 * multipart text fields depending on the Content-Type; a string is sent as it is.
 */
export function prepareScriptRequest(o: ScriptRequestOptions, userAgent: string): Prepared {
  const method = String(o.method ?? 'GET').toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) throw new ScriptRequestError(`bru.sendRequest: method "${method}" isn't supported`);

  let url = o.url.trim();
  if (o.baseURL && !/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `${o.baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  if (!brunoUtils.hasExplicitScheme(url)) url = `${brunoUtils.DEFAULT_SCHEME}${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScriptRequestError(`bru.sendRequest: invalid URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new ScriptRequestError(`bru.sendRequest: only http and https URLs can be sent (${parsed.protocol})`);
  const query = Object.entries(o.params ?? {}).filter(([, v]) => v !== undefined && v !== null);
  if (query.length) url += `${url.includes('?') ? '&' : '?'}${new URLSearchParams(query.map(([k, v]) => [k, String(v)])).toString()}`;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    const value = headerValue(v);
    if (value !== undefined) headers[k] = value;
  }
  const find = (name: string): string | undefined => Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (!find('user-agent')) headers['User-Agent'] = userAgent;
  if (o.auth && !find('authorization')) headers.Authorization = `Basic ${Buffer.from(`${o.auth.username ?? ''}:${o.auth.password ?? ''}`).toString('base64')}`;

  const contentType = (find('content-type') ? headers[find('content-type')!] : '').toLowerCase();
  let data: string | undefined;
  let multipart: MultipartInput[] | undefined;
  const d = o.data;
  if (d === undefined || d === null) data = undefined;
  else if (typeof d === 'string') data = d;
  else if (isObject(d) && contentType.includes('application/x-www-form-urlencoded')) {
    data = new URLSearchParams(Object.entries(d).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();
  } else if (isObject(d) && contentType.includes('multipart/form-data')) {
    // Text fields only: a script has no files to send. The runner sets the Content-Type with its boundary.
    multipart = Object.entries(d)
      .filter(([, v]) => v !== undefined && v !== null)
      .flatMap(([name, v]) => (Array.isArray(v) ? v : [v]).map((x): MultipartInput => ({ name, type: 'text', value: typeof x === 'object' ? JSON.stringify(x) : String(x), path: '', contentType: '' })));
  } else {
    data = JSON.stringify(d);
    if (!contentType) headers['Content-Type'] = 'application/json';
  }
  return { method: method as HttpMethod, url, headers, data, multipart };
}

/** A request document for the runner's settings (timeout, redirects): no scripts, auth, variables or tests. */
export function scriptRequestDoc(o: ScriptRequestOptions, prepared: Prepared): RequestDoc {
  const timeout = typeof o.timeout === 'number' && o.timeout > 0 ? Math.round(o.timeout) : 0;
  const maxRedirects = typeof o.maxRedirects === 'number' && o.maxRedirects >= 0 ? Math.round(o.maxRedirects) : 5;
  return {
    name: 'bru.sendRequest',
    method: prepared.method,
    url: prepared.url,
    params: [],
    headers: [],
    body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
    auth: { ...emptyAuth(), mode: 'none' },
    vars: { req: [], res: [] },
    script: { req: '', res: '' },
    tests: '',
    assertions: [],
    docs: '',
    settings: { encodeUrl: false, timeoutMs: timeout, followRedirects: maxRedirects > 0, maxRedirects, forwardAuthorizationHeader: false, sendCookies: true }
  };
}

/** What the script gets back: the response for a 2xx status, otherwise an axios-shaped error. */
export function scriptReply(out: RunOutput): ScriptSendReply {
  const r = out.result;
  if (r.outcome !== 'http') {
    const code = r.outcome === 'timeout' ? 'ECONNABORTED' : r.outcome === 'cancelled' ? 'ERR_CANCELED' : (r.error?.code ?? 'ERR_NETWORK');
    return { ok: false, error: { name: r.outcome === 'cancelled' ? 'CanceledError' : 'AxiosError', message: r.error?.message ?? 'No response', code } };
  }
  const text = out.bodyBytes.toString('utf8');
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of r.headers) {
    const key = k.toLowerCase();
    if (key === 'set-cookie') headers[key] = [...((headers[key] as string[] | undefined) ?? []), v];
    else headers[key] = key in headers ? `${headers[key]}, ${v}` : v;
  }
  const response: ScriptHttpResponse = { status: r.status!, statusText: r.statusText ?? '', headers, data, responseTime: r.durationMs };
  if (r.status! >= 200 && r.status! < 300) return { ok: true, response };
  const error: ScriptHttpError = {
    name: 'AxiosError',
    message: `Request failed with status code ${r.status}`,
    code: r.status! >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    status: r.status,
    response
  };
  return { ok: false, error };
}
