// The only place that knows Bruno's in-memory item model.
// Reading: Bruno model -> Yept docs. Saving: apply the doc onto a clone of the original Bruno object, so fields
// Yept doesn't edit (assertions, tests, examples, other auth modes, unknown settings) survive untouched.
import {
  parseRequest, stringifyRequest, parseFolder, stringifyFolder, parseCollection, stringifyCollection, parseEnvironment, stringifyEnvironment
} from '@usebruno/filestore';
import yaml from 'js-yaml';
import type { AuthConfig, BodyMode, Environment, HttpMethod, KeyValue, MultipartField, Param, RequestDoc, Scripts, SettingsDoc } from '../../shared/model';
import { DEFAULT_OAUTH2, HTTP_METHODS, OAUTH2_AUTHORIZATION_CODE, OAUTH2_PASSWORD, isEditableAuth } from '../../shared/model';

/** Bruno's parsed objects. Kept opaque on purpose; only this file looks inside. */
export type BrunoItem = Record<string, any>;
export type Format = 'yml' | 'bru';

const toKv = (list: any[] | undefined): KeyValue[] =>
  (list ?? []).map((x) => ({ name: String(x.name ?? ''), value: String(x.value ?? ''), enabled: x.enabled !== false }));

/** Writes key/values back, keeping Bruno's extra per-row fields (e.g. `local` on vars) when the row is unchanged in place. */
const fromKv = (rows: KeyValue[], original: any[] | undefined): any[] =>
  rows.map((r, i) => {
    const o = original?.[i];
    const base = o && o.name === r.name ? { ...o } : {};
    delete base.uid;
    return { ...base, name: r.name, value: r.value, enabled: r.enabled };
  });

const BODY_MODES_FROM_BRUNO: Record<string, BodyMode> = {
  none: 'none', json: 'json', text: 'text', xml: 'xml', formUrlEncoded: 'formUrlEncoded', multipartForm: 'multipartForm'
};

// Keep the YAML source off RequestDoc so an unrelated editor change cannot normalise it.
const preservedBodySource = new WeakMap<BrunoItem, { text: string; indent: number; newline: string }>();

/** Locate the http.body pair, including comments and block scalar line breaks. */
function bodySourceRange(source: string): { start: number; end: number; indent: number } | undefined {
  let depth = 0;
  let inHttp = false;
  let bodyKey: { start: number; indent: number } | undefined;
  let range: ReturnType<typeof bodySourceRange>;
  let keyStart = 0;
  yaml.load(source, {
    listener(event, state) {
      if (event === 'open') {
        if (depth === 2) keyStart = state.position;
        depth++;
        return;
      }
      depth--;
      const { position, lineStart, kind, result, input } = state;
      const isKey = kind === 'scalar' && input[position] === ':';
      if (depth === 1) inHttp = isKey && result === 'http';
      if (depth !== 2 || !inHttp) return;
      if (bodyKey) {
        // A block map ends at the next key, after its indentation has already been read.
        const end = lineStart > bodyKey.start && /^ *$/.test(input.slice(lineStart, position)) ? lineStart : position;
        const lineTail = /^[ \t]*(?:#[^\r\n]*)?\r?\n/.exec(source.slice(end))?.[0] ?? '';
        range = { ...bodyKey, end: Math.min(source.length, end + lineTail.length) };
        bodyKey = undefined;
      } else if (isKey && result === 'body') {
        const beforeKey = input.slice(lineStart, keyStart);
        bodyKey = { start: keyStart, indent: /^ *$/.test(beforeKey) ? beforeKey.length : 2 };
      }
    }
  });
  return range;
}

// Bruno keeps a file field's paths as a list (several files per field) and a text field's value as a string.
const toMultipart = (list: any[] | undefined): MultipartField[] =>
  (list ?? []).map((x): MultipartField => {
    const file = x.type === 'file';
    const paths = Array.isArray(x.value) ? x.value.map(String) : x.value ? [String(x.value)] : [];
    return { name: String(x.name ?? ''), type: file ? 'file' : 'text', value: file ? '' : String(x.value ?? ''), files: file ? paths : [], localFiles: [], contentType: String(x.contentType ?? ''), enabled: x.enabled !== false };
  });

/** Local files are never written: they stay in the local store. Extra per-row fields (description) survive as in fromKv. */
const fromMultipart = (rows: MultipartField[], original: any[] | undefined): any[] =>
  rows.map((r, i) => {
    const o = original?.[i];
    const base = o && o.name === r.name && o.type === r.type ? { ...o } : {};
    delete base.uid;
    return { ...base, name: r.name, type: r.type, value: r.type === 'file' ? [...r.files] : r.value, contentType: r.contentType || null, enabled: r.enabled };
  });

// ---------- auth ----------

export function toAuth(a: any, defaultMode: string): AuthConfig {
  const o = a?.oauth2 ?? {};
  const text = (v: unknown, d = ''): string => (v === null || v === undefined ? d : String(v));
  return {
    mode: String(a?.mode ?? defaultMode),
    bearer: { token: String(a?.bearer?.token ?? '') },
    basic: { username: String(a?.basic?.username ?? ''), password: String(a?.basic?.password ?? '') },
    apikey: { key: String(a?.apikey?.key ?? ''), value: String(a?.apikey?.value ?? ''), placement: a?.apikey?.placement === 'queryparams' ? 'queryparams' : 'header' },
    oauth2: a?.oauth2
      ? {
          grantType: text(o.grantType, DEFAULT_OAUTH2.grantType),
          accessTokenUrl: text(o.accessTokenUrl),
          refreshTokenUrl: text(o.refreshTokenUrl),
          ...(o.grantType === OAUTH2_AUTHORIZATION_CODE ? { authorizationUrl: text(o.authorizationUrl), callbackUrl: text(o.callbackUrl), pkce: o.pkce !== false } : {}),
          ...(o.grantType === OAUTH2_PASSWORD ? { username: text(o.username), password: text(o.password) } : {}),
          clientId: text(o.clientId),
          clientSecret: text(o.clientSecret),
          scope: text(o.scope),
          credentialsPlacement: o.credentialsPlacement === 'body' ? 'body' : 'basic_auth_header',
          tokenPlacement: o.tokenPlacement === 'url' ? 'url' : 'header',
          // A missing prefix means Bruno's default; an empty one is deliberate (bare token).
          tokenHeaderPrefix: text(o.tokenHeaderPrefix, DEFAULT_OAUTH2.tokenHeaderPrefix),
          tokenQueryKey: text(o.tokenQueryKey, DEFAULT_OAUTH2.tokenQueryKey) || DEFAULT_OAUTH2.tokenQueryKey,
          autoFetchToken: o.autoFetchToken !== false,
          autoRefreshToken: o.autoRefreshToken === true
        }
      : { ...DEFAULT_OAUTH2 },
    digest: { username: text(a?.digest?.username), password: text(a?.digest?.password) },
    awsv4: {
      accessKeyId: text(a?.awsv4?.accessKeyId),
      secretAccessKey: text(a?.awsv4?.secretAccessKey),
      sessionToken: text(a?.awsv4?.sessionToken),
      service: text(a?.awsv4?.service),
      region: text(a?.awsv4?.region),
      profileName: text(a?.awsv4?.profileName)
    },
    ntlm: { username: text(a?.ntlm?.username), password: text(a?.ntlm?.password), domain: text(a?.ntlm?.domain) }
  };
}

/** Applies an edited auth onto Bruno's auth object. Modes Yept doesn't edit are left exactly as they were. */
function applyAuth(original: any, auth: AuthConfig): any {
  if (!isEditableAuth(auth)) return original;
  const out = { ...(original ?? {}), mode: auth.mode };
  if (auth.mode === 'bearer') out.bearer = { token: auth.bearer.token };
  if (auth.mode === 'basic') out.basic = { username: auth.basic.username, password: auth.basic.password };
  if (auth.mode === 'apikey') out.apikey = { key: auth.apikey.key, value: auth.apikey.value, placement: auth.apikey.placement };
  if (auth.mode === 'oauth2') {
    const o = auth.oauth2;
    const previous = original?.mode === 'oauth2' ? original.oauth2 : undefined;
    const sameGrant = previous?.grantType === o.grantType;
    // Fields Yept doesn't edit (token source, credentials id, additional parameters...) are kept.
    out.oauth2 = {
      ...(sameGrant ? previous : {}),
      grantType: o.grantType,
      accessTokenUrl: o.accessTokenUrl || null,
      refreshTokenUrl: o.refreshTokenUrl || null,
      clientId: o.clientId || null,
      clientSecret: o.clientSecret || null,
      scope: o.scope || null,
      credentialsPlacement: o.credentialsPlacement,
      tokenPlacement: o.tokenPlacement,
      tokenHeaderPrefix: o.tokenPlacement === 'header' ? o.tokenHeaderPrefix : null,
      tokenQueryKey: o.tokenPlacement === 'url' ? o.tokenQueryKey : null,
      autoFetchToken: o.autoFetchToken,
      autoRefreshToken: o.autoRefreshToken
    };
    if (o.grantType === OAUTH2_AUTHORIZATION_CODE) {
      out.oauth2.authorizationUrl = o.authorizationUrl || null;
      out.oauth2.callbackUrl = o.callbackUrl || null;
      // Preserve the omission in a file that already relied on the default.
      if (!sameGrant || previous.pkce != null || o.pkce === false) out.oauth2.pkce = o.pkce !== false;
    }
    if (o.grantType === OAUTH2_PASSWORD) {
      out.oauth2.username = o.username || null;
      out.oauth2.password = o.password || null;
    }
  }
  // Bruno reads a missing field as null and writes only the fields that are set, so '' is written as null.
  if (auth.mode === 'digest') out.digest = { username: auth.digest.username || null, password: auth.digest.password || null };
  if (auth.mode === 'ntlm') out.ntlm = { username: auth.ntlm.username || null, password: auth.ntlm.password || null, domain: auth.ntlm.domain || null };
  if (auth.mode === 'awsv4') {
    const w = auth.awsv4;
    out.awsv4 = { accessKeyId: w.accessKeyId || null, secretAccessKey: w.secretAccessKey || null, sessionToken: w.sessionToken || null, service: w.service || null, region: w.region || null, profileName: w.profileName || null };
  }
  return out;
}

const toScripts = (s: any): Scripts => ({ req: String(s?.req ?? ''), res: String(s?.res ?? '') });
const fromScripts = (s: Scripts, original: any): any => ({ ...(original ?? {}), req: s.req || null, res: s.res || null });

// ---------- requests ----------

export function isHttpItem(item: BrunoItem): boolean {
  return item?.type === 'http-request';
}

export function parseRequestFile(text: string, format: Format): BrunoItem {
  const item = parseRequest(text, { format });
  restoreDefaultPkce(item, text, format, 'http');
  const mode = item?.request?.body?.mode;
  if (format === 'yml' && (mode === 'file' || mode === 'sparql')) {
    const source = text.replace(/^\uFEFF/, '');
    const range = bodySourceRange(source);
    if (range) preservedBodySource.set(item, { text: source.slice(range.start, range.end), indent: range.indent, newline: source.includes('\r\n') ? '\r\n' : '\n' });
  }
  return item;
}

/** Filestore collapses a missing YAML pkce block and an explicit opt-out to false. */
function restoreDefaultPkce(item: BrunoItem | null, source: string, format: Format, section: 'http' | 'request'): void {
  const config = item?.request?.auth?.oauth2;
  if (format !== 'yml' || config?.grantType !== OAUTH2_AUTHORIZATION_CODE || config.pkce !== false) return;
  const original = yaml.load(source) as Record<string, { auth?: { pkce?: unknown } }> | undefined;
  if (original?.[section]?.auth?.pkce === undefined) delete config.pkce;
}

export function stringifyRequestFile(item: BrunoItem): string {
  let output: string = stringifyRequest(item, { format: 'yml' });
  const body = preservedBodySource.get(item);
  if (!body) return output;
  if (body.indent !== 2) {
    output = output.replace(/^http:\n(?: +[^\n]*\n|\n)+/m, (http) =>
      http.replace(/^ {2}/gm, ' '.repeat(body.indent))
    );
  }
  output = output.replaceAll('\n', body.newline);
  const range = bodySourceRange(output);
  if (!range) throw new Error('Could not preserve the original request body.');
  const suffix = body.text.endsWith('\n') ? '' : body.newline;
  const saved = output.slice(0, range.start) + body.text + suffix + output.slice(range.end);
  // A body may reference an anchor elsewhere in the file. Avoid writing invalid YAML if the
  // serializer did not keep the anchor.
  try {
    yaml.load(saved);
  } catch {
    throw new Error('Could not save without changing the original request body. Edit the YAML file directly.');
  }
  return saved;
}

export function toRequestDoc(item: BrunoItem): RequestDoc {
  const r = item.request ?? {};
  const method = String(r.method ?? 'GET').toUpperCase() as HttpMethod;
  const b = r.body ?? {};
  const supportedBody = !b.mode || Object.hasOwn(BODY_MODES_FROM_BRUNO, b.mode);
  const s = item.settings ?? {};
  return {
    name: String(item.name ?? ''),
    method: (HTTP_METHODS as readonly string[]).includes(method) ? method : 'GET',
    url: String(r.url ?? ''),
    params: (r.params ?? []).map(
      (p: any): Param => ({ name: String(p.name ?? ''), value: String(p.value ?? ''), enabled: p.enabled !== false, type: p.type === 'path' ? 'path' : 'query' })
    ),
    headers: toKv(r.headers),
    body: {
      mode: supportedBody ? BODY_MODES_FROM_BRUNO[b.mode] : 'none',
      json: b.json ?? '',
      text: b.text ?? '',
      xml: b.xml ?? '',
      formUrlEncoded: toKv(b.formUrlEncoded),
      multipartForm: toMultipart(b.multipartForm),
      ...(supportedBody ? {} : { unsupported: String(b.mode) })
    },
    // In Bruno YAML a request without an `auth` key has no auth; `auth: inherit` is explicit.
    auth: toAuth(r.auth, 'none'),
    vars: { req: toKv(r.vars?.req), res: toKv(r.vars?.res) },
    script: toScripts(r.script),
    tests: String(r.tests ?? ''),
    assertions: toKv(r.assertions),
    docs: r.docs ?? '',
    settings: {
      encodeUrl: s.encodeUrl !== false,
      timeoutMs: Number(s.timeout ?? 0) || 0,
      followRedirects: s.followRedirects !== false,
      maxRedirects: Number(s.maxRedirects ?? 5),
      // Bruno treats a missing value as true; keep that for existing files.
      forwardAuthorizationHeader: s.forwardAuthorizationHeader !== false,
      // Not in Bruno's file format: the workspace keeps it locally per request.
      sendCookies: true
    }
  };
}

/** Returns a new Bruno item: the original with the RequestDoc's editable fields applied. */
export function applyRequestDoc(original: BrunoItem, doc: RequestDoc): BrunoItem {
  const item: BrunoItem = structuredClone(original);
  item.name = doc.name;
  item.request ??= {};
  const r = item.request;
  r.method = doc.method;
  r.url = doc.url;
  r.params = doc.params.map((p) => ({ name: p.name, value: p.value, type: p.type, enabled: p.enabled }));
  r.headers = fromKv(doc.headers, original.request?.headers);
  if (doc.body.unsupported) {
    const source = preservedBodySource.get(original);
    if (source) preservedBodySource.set(item, source);
  } else {
    r.body ??= {};
    r.body.mode = doc.body.mode;
    r.body.json = doc.body.json || null;
    r.body.text = doc.body.text || null;
    r.body.xml = doc.body.xml || null;
    r.body.formUrlEncoded = fromKv(doc.body.formUrlEncoded, original.request?.body?.formUrlEncoded);
    r.body.multipartForm = fromMultipart(doc.body.multipartForm ?? [], original.request?.body?.multipartForm);
  }
  r.auth = applyAuth(r.auth, doc.auth);
  r.vars = { ...(r.vars ?? {}), req: fromKv(doc.vars.req, original.request?.vars?.req), res: fromKv(doc.vars.res, original.request?.vars?.res) };
  r.script = fromScripts(doc.script, r.script);
  r.tests = doc.tests || null;
  r.assertions = fromKv(doc.assertions, original.request?.assertions);
  r.docs = doc.docs || null;
  item.settings = {
    ...(item.settings ?? {}),
    encodeUrl: doc.settings.encodeUrl,
    timeout: doc.settings.timeoutMs,
    followRedirects: doc.settings.followRedirects,
    maxRedirects: doc.settings.maxRedirects,
    forwardAuthorizationHeader: doc.settings.forwardAuthorizationHeader
  };
  return item;
}

/** A new, empty GET request that inherits auth. New requests don't forward Authorization on cross-origin redirects. */
export function newRequestItem(name: string, seq: number): BrunoItem {
  const yml = `info:
  name: ${JSON.stringify(name)}
  type: http
  seq: ${seq}

http:
  method: GET
  url: ""
  auth: inherit

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: false
`;
  return parseRequest(yml, { format: 'yml' });
}

// ---------- folders ----------

export interface FolderMeta {
  name: string;
  seq: number;
  raw: BrunoItem | null;
}

export function parseFolderFile(text: string, format: Format = 'yml'): FolderMeta {
  const raw = parseFolder(text, { format });
  restoreDefaultPkce(raw, text, format, 'request');
  return { name: String(raw?.meta?.name ?? ''), seq: Number(raw?.meta?.seq ?? 0), raw };
}

export function stringifyFolderFile(meta: { name: string; seq: number }, raw: BrunoItem | null): string {
  const folder: BrunoItem = raw ? structuredClone(raw) : { request: { auth: { mode: 'inherit' } } };
  folder.meta = { ...(folder.meta ?? {}), name: meta.name, seq: meta.seq };
  return stringifyFolder(folder, { format: 'yml' });
}

/** Settings for a folder or the collection root. Both keep their defaults under `request`. */
export function toSettingsDoc(name: string, root: BrunoItem | null, defaultAuth: string): SettingsDoc {
  const r = root?.request ?? {};
  return {
    name,
    headers: toKv(r.headers),
    auth: toAuth(r.auth, defaultAuth),
    vars: toKv(r.vars?.req),
    script: toScripts(r.script),
    tests: String(r.tests ?? ''),
    docs: String(root?.docs ?? '')
  };
}

export function applySettingsDoc(original: BrunoItem | null, doc: SettingsDoc): BrunoItem {
  const root: BrunoItem = original ? structuredClone(original) : {};
  root.request ??= {};
  const r = root.request;
  r.headers = fromKv(doc.headers, original?.request?.headers);
  r.auth = applyAuth(r.auth ?? { mode: 'inherit' }, doc.auth);
  r.vars = { ...(r.vars ?? {}), req: fromKv(doc.vars, original?.request?.vars?.req), res: r.vars?.res ?? [] };
  r.script = fromScripts(doc.script, r.script);
  r.tests = doc.tests || null;
  root.docs = doc.docs || null;
  return root;
}

// ---------- collections ----------

export interface CollectionFile {
  name: string;
  root: BrunoItem | null;
  config: BrunoItem;
  /** filestore injects a default proxy block into the parsed config; remember whether the file really had one. */
  hadProxy: boolean;
}

export function parseCollectionFile(text: string, format: Format): CollectionFile {
  if (format === 'yml') {
    const { collectionRoot, brunoConfig } = parseCollection(text, { format: 'yml' });
    restoreDefaultPkce(collectionRoot, text, format, 'request');
    return { name: String(brunoConfig?.name ?? ''), root: collectionRoot ?? null, config: brunoConfig ?? {}, hadProxy: /^\s*proxy:/m.test(text) };
  }
  // .bru collections: collection.bru holds the root; the name lives in bruno.json (read separately).
  return { name: '', root: parseCollection(text, { format: 'bru' }), config: {}, hadProxy: false };
}

export function stringifyCollectionFile(file: CollectionFile): string {
  const config = { ...file.config };
  if (!file.hadProxy) delete config.proxy; // otherwise every save adds a 12-line default proxy block
  return stringifyCollection(file.root ?? {}, config, { format: 'yml' });
}

export function collectionNameFromYml(text: string): string | null {
  try {
    const { brunoConfig } = parseCollection(text, { format: 'yml' });
    return brunoConfig?.name ? String(brunoConfig.name) : null;
  } catch {
    return null;
  }
}

/** Bruno's .bru collections keep their name in bruno.json. */
export function collectionNameFromBrunoJson(text: string): string | null {
  try {
    return JSON.parse(text).name ?? null;
  } catch {
    return null;
  }
}

// ---------- environments ----------

export function parseEnvironmentFile(text: string, format: Format, fallbackName: string): Environment {
  const e = parseEnvironment(text, { format });
  return {
    name: String(e?.name && e.name !== 'Untitled Environment' ? e.name : fallbackName),
    variables: (e?.variables ?? []).map((v: any) => ({
      name: String(v.name ?? ''),
      value: v.secret ? '' : String(v.value ?? ''),
      secret: !!v.secret,
      enabled: v.enabled !== false
    }))
  };
}

/** Secret variables are always written without a value: the shared file declares names, never secrets. */
export function stringifyEnvironmentFile(env: Environment): string {
  return stringifyEnvironment(
    { name: env.name, variables: env.variables.map((v) => ({ name: v.name, value: v.secret ? '' : v.value, enabled: v.enabled, secret: v.secret, type: 'text' })) },
    { format: 'yml' }
  );
}
