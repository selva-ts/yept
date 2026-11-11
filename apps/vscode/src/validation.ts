import { HTTP_METHODS, BODY_MODES, type CookieView, type Environment, type RequestDoc, type TlsSettings } from '@yept/core/shared/model';

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('Expected a string');
}
export function requestDoc(value: unknown): asserts value is RequestDoc {
  const fail = (): never => { throw new Error('Invalid request document'); };
  const strings = (v: any, keys: string[]) => object(v) && keys.every((k) => typeof v[k] === 'string');
  const rows = (v: any) => Array.isArray(v) && v.every((r) => strings(r, ['name', 'value']) && typeof r.enabled === 'boolean');
  if (!object(value)) fail();
  const d = value as any;
  if (!strings(d, ['name', 'method', 'url', 'tests', 'docs']) || !HTTP_METHODS.includes(d.method)) fail();
  if (!rows(d.headers) || !rows(d.assertions) || !rows(d.params) || !d.params.every((p: any) => ['query', 'path'].includes(p.type))) fail();
  if (!object(d.vars) || !rows(d.vars.req) || !rows(d.vars.res) || !strings(d.script, ['req', 'res'])) fail();
  const b = d.body;
  if (!strings(b, ['mode', 'json', 'text', 'xml']) || !BODY_MODES.includes(b.mode) || !rows(b.formUrlEncoded) || !Array.isArray(b.multipartForm)) fail();
  if (b.unsupported !== undefined && typeof b.unsupported !== 'string') fail();
  for (const f of b.multipartForm) if (!strings(f, ['name', 'type', 'value', 'contentType']) || !['text', 'file'].includes(f.type) || typeof f.enabled !== 'boolean' || ![f.files, f.localFiles].every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))) fail();
  const a = d.auth;
  if (!strings(a, ['mode']) || !strings(a.bearer, ['token']) || !strings(a.basic, ['username', 'password']) || !strings(a.apikey, ['key', 'value', 'placement']) || !['header', 'queryparams'].includes(a.apikey.placement)) fail();
  const o = a.oauth2;
  if (!strings(o, ['grantType', 'accessTokenUrl', 'clientId', 'clientSecret', 'scope', 'credentialsPlacement', 'tokenPlacement', 'tokenHeaderPrefix', 'tokenQueryKey']) || !['basic_auth_header', 'body'].includes(o.credentialsPlacement) || !['header', 'url'].includes(o.tokenPlacement) || typeof o.autoFetchToken !== 'boolean' || typeof o.autoRefreshToken !== 'boolean') fail();
  if (['authorizationUrl', 'callbackUrl', 'refreshTokenUrl', 'username', 'password'].some((key) => o[key] !== undefined && typeof o[key] !== 'string') ||
      (o.pkce !== undefined && typeof o.pkce !== 'boolean')) fail();
  const s = d.settings;
  if (!object(s) || !['encodeUrl', 'followRedirects', 'forwardAuthorizationHeader', 'sendCookies'].every((k) => typeof s[k] === 'boolean') || !['timeoutMs', 'maxRedirects'].every((k) => Number.isSafeInteger(s[k]) && s[k] >= 0)) fail();
}
export function nullableText(value: unknown): asserts value is string | null {
  if (value !== null) text(value);
}
export function environment(value: unknown): asserts value is Environment {
  const fail = (): never => { throw new Error('Invalid environment'); };
  if (!object(value) || typeof value.name !== 'string' || !Array.isArray(value.variables)) fail();
  for (const v of (value as any).variables) {
    if (!object(v) || typeof v.name !== 'string' || typeof v.value !== 'string' || typeof v.secret !== 'boolean' || typeof v.enabled !== 'boolean') fail();
  }
}
export function tlsSettings(value: unknown): asserts value is TlsSettings {
  if (!object(value) || typeof value.skipVerify !== 'boolean' || typeof value.caFile !== 'string') throw new Error('Invalid TLS settings');
  const certs = value.clientCertificates;
  if (certs !== undefined && (!Array.isArray(certs) || certs.length > 50 || !certs.every((c) => object(c) && ['host', 'pfxFile', 'certFile', 'keyFile'].every((k) => typeof c[k] === 'string')))) {
    throw new Error('Invalid TLS settings');
  }
}
export function cookieKey(value: unknown): asserts value is Pick<CookieView, 'domain' | 'path' | 'name'> {
  if (!object(value) || !['domain', 'path', 'name'].every((k) => typeof value[k] === 'string')) throw new Error('Invalid cookie');
}
export function cookieView(value: unknown): asserts value is CookieView {
  cookieKey(value);
  const c = value as Record<string, unknown>;
  if (typeof c.value !== 'string' || typeof c.sameSite !== 'string' || (c.expires !== null && typeof c.expires !== 'string')) throw new Error('Invalid cookie');
  if (!['secure', 'httpOnly', 'hostOnly'].every((k) => typeof c[k] === 'boolean')) throw new Error('Invalid cookie');
}
