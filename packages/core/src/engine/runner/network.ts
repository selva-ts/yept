// Records what happens on the wire during one run: every request (redirect hops included), its phase timings,
// the connection and TLS details, and the headers actually sent. It plugs into axios as the transport, wrapping
// follow-redirects (or plain http/https when redirects are off), so redirect behaviour is unchanged.
import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { isIP } from 'node:net';
import type { TLSSocket, PeerCertificate } from 'node:tls';
import followRedirects from 'follow-redirects';
import type { CertificateInfo, ConnectionInfo, PhaseTimings } from '../../shared/model';
import { viaProxy } from '../net/proxy';

/** A hop with unmasked headers. The runner masks it before it leaves the engine. */
export interface WireHop {
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  requestHeaders: [string, string][];
  responseHeaders: [string, string][];
  timings: PhaseTimings;
  connection: ConnectionInfo;
}

/** Called for each redirect before the next request goes out. `nextHeaders` can be changed (e.g. Cookie). */
export interface RedirectEvent {
  fromUrl: string;
  status: number;
  responseHeaders: http.IncomingHttpHeaders;
  nextUrl: string;
  nextMethod: string;
  nextHeaders: Record<string, unknown>;
}

interface Marks {
  start: number;
  socket?: number;
  lookup?: number;
  connect?: number;
  secure?: number;
  response?: number;
  end?: number;
  reused: boolean;
  /** The address the DNS lookup returned. */
  address?: string;
}

const span = (from: number | undefined, to: number | undefined): number | undefined =>
  from === undefined || to === undefined ? undefined : Math.max(0, Math.round(to - from));

function describeName(n: PeerCertificate['subject'] | undefined): string {
  if (!n) return '';
  return (['CN', 'O', 'OU', 'L', 'ST', 'C'] as const)
    .filter((k) => n[k])
    .map((k) => `${k}=${Array.isArray(n[k]) ? (n[k] as string[]).join('+') : n[k]}`)
    .join(', ');
}

function certificate(s: TLSSocket): CertificateInfo | undefined {
  try {
    const c = s.getPeerCertificate();
    if (!c || !Object.keys(c).length) return undefined;
    return { subject: describeName(c.subject), issuer: describeName(c.issuer), validFrom: c.valid_from, validTo: c.valid_to, fingerprint256: c.fingerprint256 };
  } catch {
    return undefined;
  }
}

/**
 * `dialled` is where the request connected (host or looked-up IP, and port): sockets don't always report their peer.
 * Through a proxy, the remote address is the proxy's.
 */
function connectionOf(socket: Socket | null | undefined, dialled: { address?: string; port?: number }, httpVersion?: string): ConnectionInfo {
  const via = socket ? viaProxy.get(socket) : undefined;
  const info: ConnectionInfo = { httpVersion, remoteAddress: socket?.remoteAddress || dialled.address, remotePort: socket?.remotePort || dialled.port };
  if (via) {
    info.proxy = via.proxy;
    info.proxySource = via.source;
  }
  if (!socket) return info;
  const t = socket as TLSSocket;
  if (t.encrypted) info.tls = { protocol: t.getProtocol() ?? '', cipher: t.getCipher()?.name ?? '', certificate: certificate(t) };
  return info;
}

/** Header list from a request object, in the order they were set, plus Host. */
function sentHeaders(req: http.ClientRequest): [string, string][] {
  const out: [string, string][] = [];
  if (!req.hasHeader('host')) out.push(['Host', req.host ?? '']);
  for (const name of req.getRawHeaderNames()) {
    const v = req.getHeader(name);
    if (Array.isArray(v)) v.forEach((x) => out.push([name, String(x)]));
    else if (v !== undefined) out.push([name, String(v)]);
  }
  return out;
}

function headerList(h: Record<string, unknown> | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(h ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => out.push([k, String(x)]));
    else if (v !== undefined && v !== null) out.push([k, String(v)]);
  }
  return out;
}

export class WireRecorder {
  readonly hops: WireHop[] = [];
  private current: { hop: WireHop; marks: Marks; socket: Socket | null; host: string; port: number } | null = null;

  /** Starts a hop. `options` are its request options (hostname, port, protocol). */
  private begin(method: string, url: string, options: { hostname?: string; port?: number | string; protocol?: string }): void {
    this.current = {
      hop: { method, url, requestHeaders: [], responseHeaders: [], timings: { total: 0, reused: false }, connection: {} },
      marks: { start: performance.now(), reused: false },
      socket: null,
      host: String(options.hostname ?? ''),
      port: Number(options.port) || (options.protocol === 'https:' ? 443 : 80)
    };
    this.hops.push(this.current.hop);
  }

  private onSocket(socket: Socket): void {
    const cur = this.current;
    if (!cur) return;
    const m = cur.marks;
    cur.socket = socket;
    m.socket = performance.now();
    // A proxy tunnel arrives already connected; the agent timed the connection to the proxy and the CONNECT.
    // Only its first request gets those times: later ones reuse the connection.
    const via = viaProxy.get(socket);
    if (via?.marks) {
      const t = via.marks;
      via.marks = undefined;
      m.socket = t.start;
      m.lookup = t.lookup;
      m.connect = t.tunnel ?? t.connect;
      if ((socket as TLSSocket).encrypted) socket.once('secureConnect', () => (m.secure = performance.now()));
      return;
    }
    if (!socket.connecting) {
      m.reused = true;
      return;
    }
    socket.once('lookup', (err: Error | null, address: string) => {
      m.lookup = performance.now();
      if (!err) m.address = address;
    });
    socket.once('connect', () => (m.connect = performance.now()));
    socket.once('secureConnect', () => (m.secure = performance.now()));
  }

  /** Fills timings and connection details for the current hop from what has happened so far. */
  private settle(httpVersion?: string): void {
    const cur = this.current;
    if (!cur) return;
    const m = cur.marks;
    const sentAt = m.secure ?? m.connect ?? m.socket;
    cur.hop.timings = {
      dns: span(m.socket, m.lookup),
      connect: span(m.lookup ?? m.socket, m.connect),
      tls: span(m.connect, m.secure),
      wait: span(sentAt, m.response),
      download: span(m.response, m.end),
      total: span(m.start, m.end ?? m.response ?? performance.now()) ?? 0,
      reused: m.reused
    };
    if (m.reused) {
      cur.hop.timings.dns = undefined;
      cur.hop.timings.connect = undefined;
      cur.hop.timings.tls = undefined;
    }
    // Read the socket while it's live: once the body ends it may be pooled or closed and report nothing.
    if (!cur.hop.connection.httpVersion) {
      const dialled = { address: m.address ?? (isIP(cur.host) ? cur.host : undefined), port: cur.port };
      cur.hop.connection = connectionOf(cur.socket, dialled, httpVersion);
    }
  }

  /** The body finished (or failed): close the final hop's timings. */
  end(): void {
    if (!this.current) return;
    this.current.marks.end ??= performance.now();
    this.settle();
  }

  /** An axios transport for one request to `url` that records into this recorder. */
  transport(opts: { url: string; followRedirects: boolean; maxRedirects: number; onRedirect?: (e: RedirectEvent) => void }): { request: (options: any, cb: (res: http.IncomingMessage) => void) => http.ClientRequest } {
    return {
      request: (options: any, cb: (res: http.IncomingMessage) => void): http.ClientRequest => {
        const isHttps = options.protocol === 'https:';
        this.begin(options.method, opts.url, options);

        const onResponse = (res: http.IncomingMessage): void => {
          const cur = this.current;
          if (cur) {
            cur.marks.response = performance.now();
            cur.hop.status = res.statusCode;
            cur.hop.statusText = res.statusMessage;
            cur.hop.responseHeaders = headerList(res.headers);
            cur.hop.requestHeaders = sentHeaders((res as http.IncomingMessage & { req: http.ClientRequest }).req);
            cur.socket ??= res.socket;
            this.settle(res.httpVersion);
          }
          cb(res);
        };

        let req: http.ClientRequest;
        if (!opts.followRedirects) {
          req = (isHttps ? https : http).request(options, onResponse);
        } else {
          options.maxRedirects = opts.maxRedirects;
          // Same as axios's own follow-redirects setup: no extra headers stripped beyond follow-redirects' defaults.
          options.sensitiveHeaders = [];
          options.beforeRedirects.config = (next: any, response: { headers: http.IncomingHttpHeaders; statusCode: number }, request: { url: string; method: string; headers: Record<string, unknown> }): void => {
            const cur = this.current;
            if (cur) {
              cur.marks.response = performance.now();
              cur.hop.status = response.statusCode;
              cur.hop.statusText = http.STATUS_CODES[response.statusCode];
              cur.hop.responseHeaders = headerList(response.headers);
              cur.hop.requestHeaders = headerList(request.headers);
              this.settle();
            }
            opts.onRedirect?.({ fromUrl: request.url, status: response.statusCode, responseHeaders: response.headers, nextUrl: next.href, nextMethod: next.method, nextHeaders: next.headers });
            this.begin(next.method, next.href, next);
          };
          req = (isHttps ? followRedirects.https : followRedirects.http).request(options, onResponse);
        }
        req.on('socket', (s: Socket) => this.onSocket(s));
        req.on('error', () => this.settle());
        return req;
      }
    };
  }
}
