// "Copy as" in Network: a request as code, from the same input as "Copy as cURL". Values come in masked unless the
// main process built the input from the unmasked request, so nothing here decides what is secret.
import { toCurl, type CurlRequest } from './curl';
import type { MultipartPartSummary } from './model';

export type SnippetLanguage = 'curl' | 'csharp' | 'powershell' | 'fetch' | 'axios' | 'python';

export const SNIPPET_LANGUAGES: readonly { id: SnippetLanguage; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'csharp', label: 'C# HttpClient' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'fetch', label: 'JavaScript fetch' },
  { id: 'axios', label: 'JavaScript axios' },
  { id: 'python', label: 'Python requests' }
];

export const isSnippetLanguage = (v: unknown): v is SnippetLanguage => SNIPPET_LANGUAGES.some((l) => l.id === v);

export const snippetLabel = (language: SnippetLanguage): string => SNIPPET_LANGUAGES.find((l) => l.id === language)?.label ?? language;

export function toSnippet(language: SnippetLanguage, r: CurlRequest): string {
  switch (language) {
    case 'curl': return toCurl(r);
    case 'csharp': return toCSharp(r);
    case 'powershell': return toPowerShell(r);
    case 'fetch': return toFetch(r);
    case 'axios': return toAxios(r);
    case 'python': return toPython(r);
    default: throw new Error(`Unknown language: ${String(language)}`);
  }
}

// ---------- the request, as every language needs it ----------

/** Set by the HTTP library itself, or refused by it. Accept-Encoding is left to the library, which decodes what it asked for. */
const SKIP = /^(host|connection|keep-alive|content-length|transfer-encoding|upgrade|accept-encoding)$/i;

/** What a masked value looks like; it doesn't count as non-ASCII text. */
const MASK = '••••••';
const nonAscii = (s: string): boolean => /[^\x00-\x7f]/.test(s.split(MASK).join(''));

interface Prepared {
  method: string;
  url: string;
  /** One entry per header name: repeated headers joined as they would be on the wire. */
  headers: [string, string][];
  body?: string;
  form?: MultipartPartSummary[];
  /** The request asked for compressed responses. */
  compressed: boolean;
}

function prepare(r: CurlRequest): Prepared {
  const merged = new Map<string, [string, string[]]>();
  let compressed = false;
  for (const [k, v] of r.headers) {
    if (/^accept-encoding$/i.test(k)) compressed = true;
    if (SKIP.test(k)) continue;
    // Multipart: the library writes the Content-Type with its own boundary.
    if (r.form && /^content-type$/i.test(k)) continue;
    const key = k.toLowerCase();
    const entry = merged.get(key);
    if (entry) entry[1].push(v);
    else merged.set(key, [k, [v]]);
  }
  const headers = [...merged.entries()].map(([key, [name, values]]): [string, string] => [name, values.join(key === 'cookie' ? '; ' : ', ')]);
  return { method: r.method.toUpperCase(), url: r.url, headers, body: r.form ? undefined : r.body, form: r.form, compressed };
}

/** Parts grouped by field name, first appearance first (for languages that take a dictionary). */
function groupParts(form: MultipartPartSummary[]): [string, MultipartPartSummary[]][] {
  const groups = new Map<string, MultipartPartSummary[]>();
  for (const p of form) groups.set(p.name, [...(groups.get(p.name) ?? []), p]);
  return [...groups.entries()];
}

const hex = (c: string, width: number): string => c.charCodeAt(0).toString(16).padStart(width, '0');
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

// ---------- string literals ----------

const C_ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** A Python or JavaScript string literal: single quotes unless the text has them and no double quotes. */
function cLike(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/[\\'"\x00-\x1f\x7f\u2028\u2029]/g, (c) => {
    if (c === "'" || c === '"') return c === q ? `\\${c}` : c;
    return C_ESCAPES[c] ?? (c.charCodeAt(0) > 0xff ? `\\u${hex(c, 4)}` : `\\x${hex(c, 2)}`);
  }) + q;
}

/**
 * A C# string literal. Verbatim (@"...", quotes doubled) when the text has backslashes, quotes or line breaks; a
 * regular escaped literal when it has other control characters, which an editor could change or hide.
 */
function cs(s: string): string {
  if (/[\x00-\x09\x0b-\x1f\x7f\u0085\u2028\u2029]/.test(s)) {
    return `"${s.replace(/[\\"\x00-\x1f\x7f\u0085\u2028\u2029]/g, (c) => c === '"' ? '\\"' : C_ESCAPES[c] ?? `\\u${hex(c, 4)}`)}"`;
  }
  return /[\\"\n]/.test(s) ? `@"${s.replace(/"/g, '""')}"` : `"${s}"`;
}

const PS_ESCAPES: Record<string, string> = { '\0': '`0', '\x07': '`a', '\b': '`b', '\f': '`f', '\n': '`n', '\r': '`r', '\t': '`t', '\v': '`v', '\x1b': '`e' };

/**
 * A PowerShell string literal. Single-quoted (nothing expands; quotes doubled, including the curly ones PowerShell
 * also treats as quotes) unless it has control characters other than line breaks, which go double-quoted with escapes.
 */
function ps(s: string): string {
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(s)) {
    return `"${s.replace(/[`"$\u201c\u201d\u201e\x00-\x1f\x7f]/g, (c) => PS_ESCAPES[c] ?? (c < ' ' || c === '\x7f' ? `\`u{${hex(c, 1)}}` : `\`${c}`))}"`;
  }
  return `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`;
}

// ---------- C# HttpClient ----------

/** Headers that .NET keeps on the content, not on the request. */
const CONTENT_HEADER = /^(allow|content-[a-z0-9-]+|expires|last-modified)$/i;

function toCSharp(r: CurlRequest): string {
  const p = prepare(r);
  const latin1 = p.headers.some(([, v]) => nonAscii(v));
  const hasContent = p.body !== undefined || !!p.form;
  const out = ['using System.Net.Http;'];
  if (p.compressed) out.push('using System.Net;');
  if (latin1) out.push('using System.Text;');
  out.push('');
  const handler = [
    ...(p.compressed ? ['    AutomaticDecompression = DecompressionMethods.All'] : []),
    // .NET refuses header values outside ASCII unless told how to encode them.
    ...(latin1 ? ['    RequestHeaderEncodingSelector = (_, _) => Encoding.Latin1'] : [])
  ];
  if (handler.length) out.push('using var client = new HttpClient(new SocketsHttpHandler', '{', handler.join(',\n'), '});');
  else out.push('using var client = new HttpClient();');
  out.push(`using var request = new HttpRequestMessage(new HttpMethod(${cs(p.method)}), ${cs(p.url)});`);
  const contentHeaders = p.headers.filter(([k]) => CONTENT_HEADER.test(k));
  for (const [k, v] of p.headers) if (!CONTENT_HEADER.test(k)) out.push(`request.Headers.TryAddWithoutValidation(${cs(k)}, ${cs(v)});`);
  if (p.form) {
    out.push('', 'var form = new MultipartFormDataContent();');
    p.form.forEach((part, i) => {
      const v = `part${i + 1}`;
      if (part.type === 'text') {
        out.push(`var ${v} = new StringContent(${cs(part.value ?? '')});`);
        // StringContent says text/plain; the part goes with the type it was sent with, or none.
        out.push(`${v}.Headers.ContentType = null;`);
      } else {
        out.push(`var ${v} = new StreamContent(File.OpenRead(${cs(part.path ?? part.fileName ?? '')}));`);
      }
      if (part.contentType) out.push(`${v}.Headers.TryAddWithoutValidation("Content-Type", ${cs(part.contentType)});`);
      out.push(part.type === 'text' ? `form.Add(${v}, ${cs(part.name)});` : `form.Add(${v}, ${cs(part.name)}, ${cs(part.fileName ?? '')});`);
    });
    out.push('request.Content = form;');
  } else if (p.body !== undefined) {
    out.push('', `request.Content = new StringContent(${cs(p.body)});`);
    // StringContent says text/plain; the body goes with the Content-Type it was sent with, or none.
    out.push('request.Content.Headers.ContentType = null;');
  }
  for (const [k, v] of contentHeaders) {
    out.push(hasContent ? `request.Content.Headers.TryAddWithoutValidation(${cs(k)}, ${cs(v)});` : `// Left out, as there is no body: ${k}: ${v.replace(/[\r\n]+/g, ' ')}`);
  }
  out.push(
    '',
    'using var response = await client.SendAsync(request);',
    'Console.WriteLine((int)response.StatusCode);',
    'Console.WriteLine(await response.Content.ReadAsStringAsync());'
  );
  return out.join('\n');
}

// ---------- PowerShell Invoke-RestMethod ----------

const PS_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'TRACE', 'OPTIONS', 'MERGE', 'PATCH']);

function toPowerShell(r: CurlRequest): string {
  const p = prepare(r);
  const notes: string[] = [];
  const params: [string, string][] = [];
  if (PS_METHODS.has(p.method)) params.push(['Method', ps(p.method[0] + p.method.slice(1).toLowerCase())]);
  else {
    params.push(['CustomMethod', ps(p.method)]);
    notes.push('# -CustomMethod needs PowerShell 7 or later.');
  }
  params.push(['Uri', ps(p.url)]);
  const headers: [string, string][] = [];
  for (const [k, v] of p.headers) {
    // Invoke-RestMethod sets these two itself; its own parameters work on Windows PowerShell 5.1 too.
    if (/^user-agent$/i.test(k)) params.push(['UserAgent', ps(v)]);
    else if (/^content-type$/i.test(k) && p.body !== undefined) params.push(['ContentType', ps(v)]);
    else headers.push([k, v]);
  }
  if (p.headers.some(([, v]) => nonAscii(v))) notes.push('# .NET sends only ASCII header values: the ones with other characters may be refused.');
  if (headers.length) params.push(['Headers', '$headers']);
  const out: string[] = [];
  if (headers.length) out.push('$headers = [ordered]@{', ...headers.map(([k, v]) => `  ${ps(k)} = ${ps(v)}`), '}');
  if (p.form) {
    notes.push("# -Form needs PowerShell 7 or later. Windows PowerShell 5.1 can't send a multipart form with Invoke-RestMethod.");
    const entries: string[] = [];
    for (const [name, parts] of groupParts(p.form)) {
      const values = parts.map((part) => {
        if (part.type === 'text') {
          if (part.contentType) notes.push(`# -Form sends "${name}" as plain text; it was sent as ${part.contentType}.`);
          return ps(part.value ?? '');
        }
        const path = part.path ?? part.fileName ?? '';
        if (part.fileName && part.fileName !== baseName(path)) notes.push(`# -Form names the file after the one on disk; it was sent as "${part.fileName}".`);
        if (part.contentType && part.contentType !== 'application/octet-stream') notes.push(`# -Form sends "${name}" as application/octet-stream; it was sent as ${part.contentType}.`);
        return `(Get-Item -LiteralPath ${ps(path)})`;
      });
      entries.push(`  ${ps(name)} = ${values.length > 1 ? `@(${values.join(', ')})` : values[0]}`);
    }
    out.push('$form = [ordered]@{', ...entries, '}');
    params.push(['Form', '$form']);
  } else if (p.body !== undefined) {
    // A string body goes as ISO-8859-1 on Windows PowerShell 5.1: send UTF-8 bytes when it isn't plain ASCII.
    params.push(['Body', nonAscii(p.body) ? `[System.Text.Encoding]::UTF8.GetBytes(${ps(p.body)})` : ps(p.body)]);
  }
  out.push('$params = @{', ...params.map(([k, v]) => `  ${k} = ${v}`), '}', 'Invoke-RestMethod @params');
  return [...new Set(notes), ...out].join('\n');
}

// ---------- Python requests ----------

function toPython(r: CurlRequest): string {
  const p = prepare(r);
  const out = ['import requests', '', `url = ${cLike(p.url)}`];
  const args = [cLike(p.method), 'url'];
  if (p.headers.length) {
    out.push('headers = {', ...p.headers.map(([k, v]) => `    ${cLike(k)}: ${cLike(v)},`), '}');
    args.push('headers=headers');
  }
  if (p.form) {
    out.push('files = [', ...p.form.map((part) => {
      const type = part.contentType ? `, ${cLike(part.contentType)}` : '';
      const value = part.type === 'text'
        ? `(None, ${cLike(part.value ?? '')}${type})`
        : `(${cLike(part.fileName ?? '')}, open(${cLike(part.path ?? part.fileName ?? '')}, 'rb')${type})`;
      return `    (${cLike(part.name)}, ${value}),`;
    }), ']');
    args.push('files=files');
  } else if (p.body !== undefined) {
    out.push(`data = ${cLike(p.body)}`);
    // requests would send a str body as ISO-8859-1.
    args.push(nonAscii(p.body) ? "data=data.encode('utf-8')" : 'data=data');
  }
  out.push('', `response = requests.request(${args.join(', ')})`, 'print(response.status_code)', 'print(response.text)');
  return out.join('\n');
}

// ---------- JavaScript fetch and axios ----------

/** Builds `form` for fetch and axios. Files are read by path, which needs Node.js. */
function jsForm(form: MultipartPartSummary[]): { imports: string[]; lines: string[] } {
  const files = form.some((p) => p.type === 'file');
  const lines = files ? ['// Node.js 20 or later: openAsBlob reads the files. In a browser, append File objects instead.'] : [];
  lines.push('const form = new FormData();');
  for (const part of form) {
    if (part.type === 'text') {
      if (part.contentType) lines.push(`// FormData can't set a type on a text field: this goes as plain text, not ${part.contentType}.`);
      lines.push(`form.append(${cLike(part.name)}, ${cLike(part.value ?? '')});`);
    } else {
      const type = part.contentType ? `, { type: ${cLike(part.contentType)} }` : '';
      lines.push(`form.append(${cLike(part.name)}, await openAsBlob(${cLike(part.path ?? part.fileName ?? '')}${type}), ${cLike(part.fileName ?? '')});`);
    }
  }
  return { imports: files ? ["import { openAsBlob } from 'node:fs';"] : [], lines };
}

const jsHeaders = (headers: [string, string][], indent: string): string =>
  `{\n${headers.map(([k, v]) => `${indent}  ${cLike(k)}: ${cLike(v)}`).join(',\n')}\n${indent}}`;

function toFetch(r: CurlRequest): string {
  const p = prepare(r);
  const form = p.form && jsForm(p.form);
  const out = form ? [...form.imports, ...(form.imports.length ? [''] : []), ...form.lines, ''] : [];
  const options: string[] = [];
  if (p.method !== 'GET') options.push(`method: ${cLike(p.method)}`);
  if (p.headers.length) options.push(`headers: ${jsHeaders(p.headers, '  ')}`);
  if (form) options.push('body: form');
  else if (p.body !== undefined) {
    if (p.method === 'GET' || p.method === 'HEAD') out.push(`// fetch can't send a body with ${p.method}; it was sent with ${p.body.length} characters.`);
    else options.push(`body: ${cLike(p.body)}`);
  }
  out.push(options.length ? `const response = await fetch(${cLike(p.url)}, {\n${options.map((o) => `  ${o}`).join(',\n')}\n});` : `const response = await fetch(${cLike(p.url)});`);
  out.push('', 'console.log(response.status);', 'console.log(await response.text());');
  return out.join('\n');
}

function toAxios(r: CurlRequest): string {
  const p = prepare(r);
  const form = p.form && jsForm(p.form);
  const out = ["import axios from 'axios';", ...(form?.imports ?? []), ''];
  if (form) out.push(...form.lines, '');
  const options = [`method: ${cLike(p.method.toLowerCase())}`, `url: ${cLike(p.url)}`];
  if (p.headers.length) options.push(`headers: ${jsHeaders(p.headers, '  ')}`);
  if (form) options.push('data: form');
  else if (p.body !== undefined) {
    options.push(`data: ${cLike(p.body)}`);
    // With a JSON Content-Type, axios trims JSON text and quotes anything that doesn't parse.
    if (p.headers.some(([k, v]) => /^content-type$/i.test(k) && v.includes('application/json'))) options.push('transformRequest: [(data) => data]');
  }
  out.push(`const response = await axios.request({\n${options.map((o) => `  ${o}`).join(',\n')}\n});`);
  out.push('', 'console.log(response.status);', 'console.log(response.data);');
  return out.join('\n');
}
