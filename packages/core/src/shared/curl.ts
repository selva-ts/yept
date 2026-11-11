// "Copy as cURL": a request as a bash-style curl command (works in Git Bash, WSL, macOS and Linux shells).
// "Paste cURL": the reverse, a curl command (bash or Windows cmd syntax) read back into a request.
import { HTTP_METHODS, type HttpMethod, type MultipartField, type MultipartPartSummary, type RequestBody, type RequestDoc, type RequestSettings } from './model';
import { paramsFromUrl } from './url-params';

export interface CurlRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
  /** Multipart parts: sent with -F, so curl reads the files and writes its own boundary. */
  form?: MultipartPartSummary[];
}

/** Headers curl sets itself; copying them would duplicate or contradict curl's own. */
const SKIP = /^(host|connection|content-length)$/i;

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A double-quoted word inside a -F value: curl unescapes \" and \\ there. */
const formWord = (s: string): string => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

function formOption(p: MultipartPartSummary): string {
  // --form-string never reads files, whatever the value starts with (@ and < are special in -F).
  if (p.type === 'text' && !p.contentType) return `--form-string ${quote(`${p.name}=${p.value ?? ''}`)}`;
  if (p.type === 'text') return `-F ${quote(`${p.name}=${formWord(p.value ?? '')};type=${p.contentType}`)}`;
  const type = p.contentType ? `;type=${p.contentType}` : '';
  return `-F ${quote(`${p.name}=@${formWord(p.path ?? p.fileName ?? '')};filename=${formWord(p.fileName ?? '')}${type}`)}`;
}

/** What --compressed asks for; "Copy as cURL" turns this header back into --compressed. */
const COMPRESSED = 'gzip, deflate, br';

export function toCurl(r: CurlRequest): string {
  // One option per line: the command, then headers, then the body.
  // -X HEAD makes curl wait for a body that never comes; -I is curl's HEAD.
  const method = r.method === 'HEAD' ? '-I ' : r.method !== 'GET' || r.body !== undefined || r.form ? `-X ${r.method} ` : '';
  const lines = [`curl ${method}${quote(r.url)}`];
  let compressed = false;
  for (const [k, v] of r.headers) {
    if (SKIP.test(k)) continue;
    // With -F, curl writes the multipart Content-Type with its own boundary.
    if (r.form && /^content-type$/i.test(k)) continue;
    // curl decodes only what it asked for: let it negotiate compression instead.
    if (/^accept-encoding$/i.test(k)) {
      compressed = true;
      continue;
    }
    lines.push(`-H ${quote(`${k}: ${v}`)}`);
  }
  if (compressed) lines.push('--compressed');
  if (r.form) for (const p of r.form) lines.push(formOption(p));
  else if (r.body !== undefined) lines.push(`--data-raw ${quote(r.body)}`);
  return lines.join(' \\\n  ');
}

// ---------- paste cURL ----------

/** The command can't be read at all (no URL, an unclosed quote...). Parts that are only skipped go to `notes`. */
export class CurlParseError extends Error {}

export interface ParsedCurl {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body: RequestBody;
  /** From -u or --oauth2-bearer. An Authorization header stays a header. */
  auth?: { mode: 'basic'; username: string; password: string } | { mode: 'bearer'; token: string };
  settings: Partial<RequestSettings>;
  /** Parts of the command that weren't imported, and why. */
  notes: string[];
  /** Credentials in the command; they are saved in the request file as they are. */
  credentials: string[];
}

const unclosed = (): CurlParseError => new CurlParseError('A quote in the command is not closed.');

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/**
 * Splits a bash command line into words: '…', "…", $'…', backslash escapes and line continuations.
 * Reading stops at |, ;, &, < or > when they start a word (an & inside an unquoted URL is kept).
 * A line break without a backslash is read as a space, so commands pasted without continuations still work.
 */
function bashWords(text: string): { words: string[]; stoppedAt?: string } {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  const end = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] !== '\n' && i + 1 < text.length) {
        word += text[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (/\s/.test(c)) {
      end();
      i++;
    } else if (!inWord && /[|;&<>]/.test(c)) {
      return { words, stoppedAt: c };
    } else if (!inWord && c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw unclosed();
      word += text.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (c === '$' && text[i + 1] === "'") {
      // ANSI-C quoting, as Chrome's "Copy as cURL (bash)" writes bodies with line breaks or non-ASCII text.
      inWord = true;
      i += 2;
      for (;;) {
        if (i >= text.length) throw unclosed();
        const d = text[i];
        if (d === "'") {
          i++;
          break;
        }
        if (d !== '\\') {
          word += d;
          i++;
          continue;
        }
        const rest = text.slice(i + 1);
        const m = /^x([0-9a-fA-F]{1,2})|^u([0-9a-fA-F]{1,4})|^U([0-9a-fA-F]{1,8})|^([0-7]{1,3})/.exec(rest);
        if (ESCAPES[rest[0]] !== undefined) {
          word += ESCAPES[rest[0]];
          i += 2;
        } else if (m) {
          word += m[4] !== undefined ? String.fromCharCode(parseInt(m[4], 8)) : String.fromCodePoint(parseInt(m[1] ?? m[2] ?? m[3], 16));
          i += 1 + m[0].length;
        } else {
          word += '\\';
          i++;
        }
      }
    } else if (c === '"') {
      inWord = true;
      i++;
      for (;;) {
        if (i >= text.length) throw unclosed();
        const d = text[i];
        if (d === '"') {
          i++;
          break;
        }
        // Inside double quotes a backslash only escapes $ ` " \ and the line break.
        if (d === '\\' && '$`"\\\n'.includes(text[i + 1] ?? '')) {
          if (text[i + 1] !== '\n') word += text[i + 1];
          i += 2;
        } else {
          word += d;
          i++;
        }
      }
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  end();
  return { words };
}

/**
 * Splits a Windows cmd command line, as Chrome's "Copy as cURL (cmd)" writes it: ^ escapes the next character
 * (^ before a line break continues the line; ^ and two line breaks is a line break in the value), then the
 * C runtime splits the words: "…" quotes, \" is a quote and backslashes before a quote are halved.
 */
function cmdWords(text: string): { words: string[] } {
  let s = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '^') s += text[i];
    else if (text[i + 1] === '\n') {
      i++;
      if (text[i + 1] === '\n') {
        s += '\n';
        i++;
      }
    } else if (i + 1 < text.length) s += text[++i];
  }
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i + n] === '\\') n++;
      if (s[i + n] === '"') {
        word += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) {
          word += '"';
          i += n;
        } else i += n - 1;
      } else {
        word += '\\'.repeat(n);
        i += n - 1;
      }
      inWord = true;
    } else if (c === '"') {
      if (quoted && s[i + 1] === '"') {
        word += '"';
        i++;
      } else quoted = !quoted;
      inWord = true;
    } else if (!quoted && /\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quoted) throw unclosed();
  if (inWord) words.push(word);
  return { words };
}

const SHORT: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie', G: 'get', I: 'head',
  L: 'location', m: 'max-time', k: 'insecure', s: 'silent', S: 'show-error', v: 'verbose', i: 'include', o: 'output', O: 'remote-name',
  w: 'write-out', x: 'proxy', U: 'proxy-user', c: 'cookie-jar', E: 'cert', T: 'upload-file', K: 'config', f: 'fail', '#': 'progress-bar',
  N: 'no-buffer', D: 'dump-header', r: 'range', C: 'continue-at', z: 'time-cond', Y: 'speed-limit', y: 'speed-time', g: 'globoff',
  J: 'remote-header-name', R: 'remote-time', n: 'netrc', q: 'disable', '4': 'ipv4', '6': 'ipv6', '0': 'http1.0', Z: 'parallel', p: 'proxytunnel'
};

/** Long options that take a value; anything not listed here is read as a switch. */
const TAKES_VALUE = new Set([
  'request', 'header', 'data', 'data-ascii', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'form', 'form-string', 'user', 'user-agent',
  'referer', 'cookie', 'max-time', 'max-redirs', 'url', 'url-query', 'oauth2-bearer', 'output', 'write-out', 'proxy', 'proxy-user', 'proxy-header',
  'noproxy', 'preproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'cookie-jar', 'cert', 'key', 'cacert', 'capath', 'cert-type', 'key-type',
  'pass', 'pinnedpubkey', 'ciphers', 'tls-max', 'upload-file', 'config', 'dump-header', 'range', 'continue-at', 'time-cond', 'speed-limit',
  'speed-time', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'resolve', 'connect-to', 'interface', 'dns-servers', 'unix-socket',
  'abstract-unix-socket', 'limit-rate', 'max-filesize', 'aws-sigv4', 'request-target', 'local-port', 'keepalive-time', 'expect100-timeout',
  'stderr', 'trace', 'trace-ascii', 'output-dir', 'netrc-file', 'parallel-max', 'variable', 'hsts', 'alt-svc', 'doh-url', 'happy-eyeballs-timeout-ms',
  'proto', 'proto-redir', 'proto-default', 'create-file-mode', 'etag-save', 'etag-compare', 'service-name', 'sasl-authzid', 'mail-from', 'mail-rcpt'
]);

/** Options that change only curl's own output or connection handling, not the request. */
const CURL_ONLY = new Set([
  'silent', 'show-error', 'verbose', 'include', 'output', 'remote-name', 'remote-name-all', 'remote-header-name', 'remote-time', 'write-out',
  'fail', 'fail-with-body', 'fail-early', 'progress-bar', 'no-progress-meter', 'no-buffer', 'dump-header', 'retry', 'retry-delay', 'retry-max-time',
  'retry-all-errors', 'retry-connrefused', 'connect-timeout', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'http3-only',
  'ipv4', 'ipv6', 'globoff', 'trace', 'trace-ascii', 'trace-time', 'stderr', 'create-dirs', 'output-dir', 'styled-output', 'no-styled-output',
  'raw', 'tcp-nodelay', 'tcp-fastopen', 'keepalive-time', 'no-keepalive', 'limit-rate', 'max-filesize', 'speed-limit', 'speed-time', 'parallel',
  'parallel-max', 'parallel-immediate', 'path-as-is', 'disable', 'netrc', 'netrc-optional', 'netrc-file', 'basic', 'expect100-timeout',
  'create-file-mode', 'etag-save', 'etag-compare', 'xattr', 'clobber', 'no-clobber', 'remove-on-error', 'show-headers'
]);

/** Options with no per-request setting here, and what to do instead. */
const NOT_IMPORTED: Record<string, string> = {
  insecure: 'TLS checks are set per environment (TLS settings)',
  cacert: 'trusted CA files are set per environment (TLS settings)',
  capath: 'trusted CA files are set per environment (TLS settings)',
  cert: 'client certificates are not supported',
  key: 'client certificates are not supported',
  'cert-type': 'client certificates are not supported',
  'key-type': 'client certificates are not supported',
  pass: 'client certificates are not supported',
  'cookie-jar': 'cookies are kept by the app',
  'junk-session-cookies': 'cookies are kept by the app',
  digest: 'only basic, bearer, API key and OAuth2 auth are supported',
  ntlm: 'only basic, bearer, API key and OAuth2 auth are supported',
  negotiate: 'only basic, bearer, API key and OAuth2 auth are supported',
  anyauth: 'only basic, bearer, API key and OAuth2 auth are supported',
  'aws-sigv4': 'only basic, bearer, API key and OAuth2 auth are supported',
  'upload-file': 'files named in a pasted command are not read',
  config: 'files named in a pasted command are not read'
};

/** curl's URL encoding for --data-urlencode: everything but letters, digits and -._~ */
const curlEscape = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** --data-urlencode: "content", "=content" and "name=content" are encoded; "@file" and "name@file" read a file. */
function urlencoded(arg: string): string | null {
  const eq = arg.indexOf('=');
  const at = arg.indexOf('@');
  if (eq >= 0 && (at < 0 || eq < at)) return eq === 0 ? curlEscape(arg.slice(1)) : `${arg.slice(0, eq)}=${curlEscape(arg.slice(eq + 1))}`;
  return at >= 0 ? null : curlEscape(arg);
}

/** a=1&b=2 as decoded fields, or null when the data isn't name=value pairs (sent as text instead). */
function formFields(data: string): { name: string; value: string; enabled: boolean }[] | null {
  const decode = (s: string): string => decodeURIComponent(s.replace(/\+/g, ' '));
  try {
    const pairs = data.split('&').filter((p) => p !== '');
    if (pairs.some((p) => !p.includes('='))) return null;
    return pairs.map((p) => {
      const eq = p.indexOf('=');
      return { name: decode(p.slice(0, eq)), value: decode(p.slice(eq + 1)), enabled: true };
    });
  } catch {
    return null;
  }
}

/** A -F value or parameter: a double-quoted word (\" and \\ unescaped) or text up to `stop`. */
function formValue(s: string, stop: RegExp): { value: string; rest: string } {
  if (s.startsWith('"')) {
    let value = '';
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) value += s[++i];
      else if (s[i] === '"') return { value, rest: s.slice(i + 1) };
      else value += s[i];
    }
    return { value, rest: '' };
  }
  const m = stop.exec(s);
  return m ? { value: s.slice(0, m.index), rest: s.slice(m.index) } : { value: s, rest: '' };
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** One -F option (or --form-string, which takes the value as it is). */
function formPart(flag: string, arg: string, notes: string[]): MultipartField {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new CurlParseError(`${flag} ${arg}: expected name=value.`);
  const part: MultipartField = { name: arg.slice(0, eq), type: 'text', value: '', files: [], localFiles: [], contentType: '', enabled: true };
  const content = arg.slice(eq + 1);
  if (flag === '--form-string') return { ...part, value: content };
  const isFile = content.startsWith('@');
  const fromFile = content.startsWith('<');
  // Unquoted text runs up to a known parameter; an unquoted file name ends at the first ";".
  const first = formValue(isFile || fromFile ? content.slice(1) : content, isFile || fromFile ? /;/ : /;(type|filename|headers|encoder)=/);
  let rest = first.rest;
  let filename: string | undefined;
  while (rest.startsWith(';')) {
    const eqAt = rest.indexOf('=');
    if (eqAt < 0) break;
    const key = rest.slice(1, eqAt).trim();
    const v = formValue(rest.slice(eqAt + 1), /;/);
    rest = v.rest;
    if (key === 'type') part.contentType = v.value;
    else if (key === 'filename') filename = v.value;
    else notes.push(`${key}= in ${flag} for "${part.name}" is not supported and was ignored.`);
  }
  if (fromFile) {
    notes.push(`${flag} ${part.name}=<${first.value} reads the value from a file, which a pasted command can't do: the value is left empty.`);
    return part;
  }
  if (!isFile) return { ...part, value: first.value };
  if (filename !== undefined && filename !== baseName(first.value)) {
    notes.push(`filename="${filename}" for "${part.name}" is not kept: the file is sent under its own name.`);
  }
  // A pasted path belongs to the computer it came from, so it stays local and out of the request file.
  return { ...part, type: 'file', localFiles: [first.value] };
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|[\w-]*(token|secret)[\w-]*)$/i;

/** Reads a curl command (bash, or Windows cmd as Chrome copies it) into a request. Never reads the files it names. */
export function parseCurl(command: string): ParsedCurl {
  const text = command.replace(/\r\n?/g, '\n').trim();
  const { words, stoppedAt } = /^\S+\s+\^"|\^\n/.test(text) ? { ...cmdWords(text), stoppedAt: undefined } : bashWords(text);
  if (words[0] === '$') words.shift();
  if (!words.length || !/^curl(\.exe)?$/i.test(baseName(words[0]))) throw new CurlParseError('This is not a curl command: it should start with "curl".');

  const notes: string[] = [];
  const curlOnly: string[] = [];
  const unknown: string[] = [];
  const headers: [string, string][] = [];
  const data: string[] = [];
  const parts: MultipartField[] = [];
  const query: string[] = [];
  const settings: Partial<RequestSettings> = {};
  // One object, so assignments inside option() aren't hidden from type narrowing.
  const st: { url?: string; method?: string; head: boolean; toQuery: boolean; sendsData: boolean; json: boolean; compressed: boolean; upload: boolean; auth?: ParsedCurl['auth'] } = {
    head: false, toQuery: false, sendsData: false, json: false, compressed: false, upload: false
  };

  const option = (name: string, flag: string, value: string): void => {
    switch (name) {
      case 'request': st.method = value; break;
      case 'url': if (st.url === undefined) st.url = value; else notes.push(`Only the first URL is used; ${value} was ignored.`); break;
      case 'head': st.head = true; break;
      case 'get': st.toQuery = true; break;
      case 'header': {
        if (value.startsWith('@')) { notes.push(`${flag} ${value} reads headers from a file, which a pasted command can't do: ignored.`); break; }
        const colon = value.indexOf(':');
        const semi = value.indexOf(';');
        if (colon > 0 && (semi < 0 || colon < semi)) {
          const v = value.slice(colon + 1).trimStart();
          // "Name:" removes a header curl would add; "Name;" sends it empty.
          if (v === '') notes.push(`${flag} '${value}' removes a header curl adds itself: ignored.`);
          else headers.push([value.slice(0, colon).trim(), v]);
        } else if (semi > 0 && value.slice(semi + 1).trim() === '') headers.push([value.slice(0, semi).trim(), '']);
        else notes.push(`${flag} '${value}' is not a header (expected Name: value): ignored.`);
        break;
      }
      case 'user-agent': headers.push(['User-Agent', value]); break;
      case 'referer': headers.push(['Referer', value.replace(/;auto$/, '')]); break;
      case 'cookie':
        if (value.includes('=')) headers.push(['Cookie', value]);
        else notes.push(`${flag} ${value} reads cookies from a file, which a pasted command can't do: ignored.`);
        break;
      case 'compressed': st.compressed = true; break;
      case 'data':
      case 'data-ascii':
      case 'data-binary':
      case 'json':
        st.sendsData = true;
        if (name === 'json') st.json = true;
        if (value.startsWith('@')) notes.push(`${flag} ${value} reads the body from a file, which a pasted command can't do: that part of the body is left out.`);
        else data.push(value);
        break;
      case 'data-raw': st.sendsData = true; data.push(value); break;
      case 'data-urlencode':
      case 'url-query': {
        const encoded = urlencoded(value);
        if (name === 'data-urlencode') st.sendsData = true;
        if (encoded === null) notes.push(`${flag} ${value} reads a file, which a pasted command can't do: left out.`);
        else (name === 'url-query' ? query : data).push(encoded);
        break;
      }
      case 'form':
      case 'form-string': parts.push(formPart(flag, value, notes)); break;
      case 'user': {
        const colon = value.indexOf(':');
        if (colon < 0) notes.push(`${flag} has no password (curl would ask for one): the password is left empty.`);
        st.auth = { mode: 'basic', username: colon < 0 ? value : value.slice(0, colon), password: colon < 0 ? '' : value.slice(colon + 1) };
        break;
      }
      case 'oauth2-bearer': st.auth = { mode: 'bearer', token: value }; break;
      case 'location': settings.followRedirects = true; break;
      case 'location-trusted': settings.followRedirects = true; settings.forwardAuthorizationHeader = true; break;
      case 'max-redirs': if (Number(value) >= 0) settings.maxRedirects = Number(value); break;
      case 'max-time': if (Number(value) > 0) settings.timeoutMs = Math.round(Number(value) * 1000); break;
      case 'next': throw new CurlParseError('--next starts a second request: paste one request at a time.');
      default:
        if (name === 'upload-file') st.upload = true;
        if (CURL_ONLY.has(name)) curlOnly.push(flag);
        else if (NOT_IMPORTED[name]) notes.push(`${flag} is not imported: ${NOT_IMPORTED[name]}.`);
        else if (name.startsWith('proxy') || name.startsWith('socks') || name === 'noproxy' || name === 'preproxy') notes.push(`${flag} is not imported: set a proxy in Settings instead.`);
        else if (/^(tls|ssl)/.test(name) || name === 'ciphers' || name === 'pinnedpubkey') notes.push(`${flag} is not imported: TLS options other than the environment's TLS settings are not supported.`);
        else if (TAKES_VALUE.has(name) || SHORT[flag.slice(1)] === name) notes.push(`${flag} is not supported: ignored.`);
        else unknown.push(flag);
    }
  };

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const needValue = (flag: string): string => {
      if (i + 1 >= words.length) throw new CurlParseError(`${flag} needs a value.`);
      return words[++i];
    };
    if (w.startsWith('--') && w.length > 2) {
      const name = w.slice(2);
      option(name, w, TAKES_VALUE.has(name) ? needValue(w) : '');
    } else if (w.startsWith('-') && w.length > 1) {
      // Short options can be joined (-sSL) and take their value attached (-XPOST) or as the next word.
      for (let j = 1; j < w.length; j++) {
        const flag = `-${w[j]}`;
        const name = SHORT[w[j]];
        if (!name) unknown.push(flag);
        else if (TAKES_VALUE.has(name)) {
          option(name, flag, j + 1 < w.length ? w.slice(j + 1) : needValue(flag));
          break;
        } else option(name, flag, '');
      }
    } else if (/^curl(\.exe)?$/i.test(w)) {
      notes.push('Only the first curl command is used.');
      break;
    } else if (st.url === undefined) st.url = w;
    else notes.push(`Only the first URL is used; ${w} was ignored.`);
  }
  if (stoppedAt) notes.push(`Everything from "${stoppedAt}" on is not part of the curl command: ignored.`);
  if (curlOnly.length) notes.push(`Ignored, as they only change curl's own output or connection: ${curlOnly.join(', ')}.`);
  if (unknown.length) notes.push(`Not recognised and ignored: ${unknown.join(', ')}.`);
  if (!st.url) throw new CurlParseError('The command has no URL.');
  if (parts.length && data.length) throw new CurlParseError('The command has both -d and -F options; curl would refuse it.');

  const hasHeader = (n: string): boolean => headers.some(([k]) => k.toLowerCase() === n);
  if (st.json) {
    if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/json']);
    if (!hasHeader('accept')) headers.push(['Accept', 'application/json']);
  }
  if (st.compressed && !hasHeader('accept-encoding')) headers.push(['Accept-Encoding', COMPRESSED]);
  // Left out as "Copy as cURL" leaves them out: the length and the multipart boundary are worked out when sending.
  for (let i = headers.length - 1; i >= 0; i--) {
    const k = headers[i][0].toLowerCase();
    if (k === 'content-length' || (parts.length && k === 'content-type')) {
      notes.push(`The ${headers[i][0]} header is left out: it is set when the request is sent.`);
      headers.splice(i, 1);
    }
  }

  if (st.toQuery) query.push(...data.splice(0));
  if (query.length) st.url += `${st.url.includes('?') ? '&' : '?'}${query.join('&')}`;

  const body: RequestBody = { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] };
  if (parts.length) Object.assign(body, { mode: 'multipartForm', multipartForm: parts });
  else if (data.length) {
    const joined = data.join('&');
    const type = headers.filter(([k]) => k.toLowerCase() === 'content-type').pop()?.[1].toLowerCase() ?? '';
    const fields = !type || type.startsWith('application/x-www-form-urlencoded') ? formFields(joined) : null;
    if (/[/+]json\b/.test(type)) Object.assign(body, { mode: 'json', json: joined });
    else if (/[/+]xml\b/.test(type)) Object.assign(body, { mode: 'xml', xml: joined });
    else if (fields) Object.assign(body, { mode: 'formUrlEncoded', formUrlEncoded: fields });
    else {
      Object.assign(body, { mode: 'text', text: joined });
      // curl sends -d data as a form unless told otherwise; keep that, rather than the text/plain a text body gets.
      if (!type) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
  }

  let resolved: HttpMethod = st.head ? 'HEAD' : st.toQuery ? 'GET' : parts.length || st.sendsData ? 'POST' : st.upload ? 'PUT' : 'GET';
  if (st.method !== undefined) {
    const m = st.method.toUpperCase();
    if ((HTTP_METHODS as readonly string[]).includes(m)) resolved = m as HttpMethod;
    else notes.push(`The method ${st.method} is not supported: the request uses ${resolved}.`);
  }

  const credentials = headers.filter(([k]) => SECRET_HEADER.test(k)).map(([k]) => `the ${k} header`);
  if (st.auth?.mode === 'basic' && st.auth.password) credentials.push('the -u password');
  if (st.auth?.mode === 'bearer') credentials.push('the bearer token');

  return { method: resolved, url: st.url, headers, body, auth: st.auth, settings, notes, credentials };
}

/** A new request's document with the pasted command applied. Auth stays as it was (inherit) unless the command sets it. */
export function requestFromCurl(doc: RequestDoc, c: ParsedCurl): RequestDoc {
  const auth = !c.auth ? doc.auth
    : c.auth.mode === 'basic' ? { ...doc.auth, mode: 'basic', basic: { username: c.auth.username, password: c.auth.password } }
    : { ...doc.auth, mode: 'bearer', bearer: { token: c.auth.token } };
  return {
    ...doc,
    method: c.method,
    url: c.url,
    params: paramsFromUrl(c.url, []),
    headers: c.headers.map(([name, value]) => ({ name, value, enabled: true })),
    body: c.body,
    auth,
    settings: { ...doc.settings, ...c.settings }
  };
}

/** A name for the new request: the method and the last part of the URL path, e.g. "POST users". */
export function curlRequestName(c: ParsedCurl): string {
  const path = c.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
  const segments = path.split('/').filter(Boolean);
  let last = segments[segments.length - 1] ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    // Keep it as it is.
  }
  return `${c.method} ${last || 'request'}`.trim();
}
