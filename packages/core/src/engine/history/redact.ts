// Redaction applied before anything is written to history.
import type { RequestDoc, RunResult } from '../../shared/model';
import { cookieMetadata } from '../../shared/run-cookies';

export interface NamedSecret {
  name: string;
  value: string;
}

const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;
export const REDACTED = '«redacted»';

/** Replaces every known secret value with «secret:name». Longest values first, so overlapping secrets mask fully. */
export function redactText(text: string, secrets: NamedSecret[]): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.value.length >= 4).sort((a, b) => b.value.length - a.value.length)) {
    out = out.split(s.value).join(`«secret:${s.name}»`);
  }
  return out;
}

export function redactHeaders(headers: [string, string][], secrets: NamedSecret[]): [string, string][] {
  const names = new Set(secrets.map((s) => s.name.toLowerCase()));
  return headers.map(([k, v]) => [k, SENSITIVE_HEADERS.test(k) || names.has(k.toLowerCase()) ? REDACTED : redactText(v, secrets)]);
}

/** A redacted copy of a run result. The response body is handled separately (it's stored as bytes). */
export function redactResult(r: RunResult, secrets: NamedSecret[]): RunResult {
  const t = (s: string | undefined): string | undefined => (s === undefined ? undefined : redactText(s, secrets));
  return {
    ...r,
    headers: redactHeaders(r.headers, secrets),
    body: { ...r.body, text: '' },
    error: r.error ? { ...r.error, message: t(r.error.message)! } : undefined,
    request: { method: r.request.method, url: t(r.request.url)!, headers: redactHeaders(r.request.headers, secrets) },
    hops: r.hops?.map((h) => ({ ...h, url: t(h.url)!, requestHeaders: redactHeaders(h.requestHeaders, secrets), responseHeaders: redactHeaders(h.responseHeaders, secrets) })),
    cookieDetails: r.cookieDetails?.map((c) => cookieMetadata(c, (text) => redactText(text, secrets))),
    requestBody: t(r.requestBody),
    multipart: r.multipart?.map((p) => ({ ...p, value: t(p.value), path: t(p.path) })),
    timeline: r.timeline.map((e) => ({ ...e, detail: t(e.detail) })),
    scriptErrors: r.scriptErrors.map((e) => ({ ...e, message: t(e.message)! })),
    console: r.console.map((c) => ({ ...c, text: t(c.text)! })),
    tests: r.tests.map((x) => ({ ...x, name: t(x.name)!, message: t(x.message) })),
    // Requests sent by scripts are listed in the (redacted) timeline; their full results are for this session only.
    scriptRequests: undefined
  };
}

/** The request as sent, for "Restore request". Literal secrets typed into fields are masked too. */
export function redactDoc(doc: RequestDoc, secrets: NamedSecret[]): RequestDoc {
  const copy = JSON.parse(redactText(JSON.stringify(doc), secrets.map((s) => ({ ...s, value: JSON.stringify(s.value).slice(1, -1) })))) as RequestDoc;
  // A user-supplied Cookie header is a credential too, even when its value was not declared a local secret.
  if (copy.headers) copy.headers = copy.headers.map((h) => /^(cookie|set-cookie)$/i.test(h.name) ? { ...h, value: REDACTED } : h);
  return copy;
}
