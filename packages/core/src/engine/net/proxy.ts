// Proxies for every request the engine sends: the request itself, redirects, OAuth2 token requests, the NTLM
// handshake and requests sent by scripts. The router picks the proxy for each URL (environment variables, the
// operating system's settings, or a manual proxy with a bypass list); the agents connect through it. HTTPS goes
// through a CONNECT tunnel. Plain HTTP goes to the proxy with the full URL as the request target.
import http from 'node:http';
import type { Duplex } from 'node:stream';
import https from 'node:https';
import net, { BlockList, isIP, type Socket } from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import type { ProxyMode, ProxySource } from '../../shared/model';
import { certificateFor, type LoadedClientCertificate } from './client-certs';

export interface ProxyServer {
  protocol: 'http:' | 'https:';
  host: string;
  port: number;
  username?: string;
  password?: string;
  source: ProxySource;
}

/** The proxy settings for this machine, with the stored password. */
export interface ProxyConfig {
  mode: ProxyMode;
  /** The manual proxy. */
  url: string;
  /** Hosts that skip the manual proxy. */
  bypass: string;
  /** Proxy sign-in, used for any proxy whose address doesn't carry its own. */
  username: string;
  password: string;
}

export class ProxyError extends Error {
  readonly code = 'EPROXY';
}

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_HEAD = 16 * 1024;
const SYSTEM_CACHE_MS = 60_000;

/** host:port for messages and the Network view. Never the credentials. */
export const proxyName = (p: Pick<ProxyServer, 'host' | 'port'>): string => `${isIP(p.host) === 6 ? `[${p.host}]` : p.host}:${p.port}`;

const hostForUrl = (host: string): string => (isIP(host) === 6 ? `[${host}]` : host);

/** A proxy address: `http://host:port`, `https://host:port` or `host:port`, with optional `user:password@`. */
export function parseProxyUrl(raw: string, source: ProxySource, what = 'The proxy address'): ProxyServer {
  const text = raw.trim();
  if (!text) throw new ProxyError(`${what} is empty`);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new ProxyError(`${what} isn't valid. Use http://host:port`);
  }
  if (/^socks/i.test(u.protocol)) throw new ProxyError(`${what} is a SOCKS proxy, which Yept doesn't support. Use an HTTP proxy`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProxyError(`${what} must start with http:// or https://`);
  if (!u.hostname) throw new ProxyError(`${what} has no host`);
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return {
    protocol: u.protocol,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
    username: u.username ? decode(u.username) : undefined,
    password: u.password ? decode(u.password) : undefined,
    source
  };
}

/**
 * What the operating system says for a URL, in the PAC result format Chromium uses: `PROXY host:port; DIRECT`.
 * The first entry Yept can use wins; SOCKS entries are skipped.
 */
export function parseSystemProxy(result: string): ProxyServer | null {
  const entries = result.split(';').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [kind, address = ''] = entry.split(/\s+/, 2);
    const k = kind.toUpperCase();
    if (k === 'DIRECT') return null;
    if (k === 'PROXY' || k === 'HTTP') return parseProxyUrl(`http://${address}`, 'system', 'The system proxy');
    if (k === 'HTTPS') return parseProxyUrl(`https://${address}`, 'system', 'The system proxy');
  }
  if (entries.length) throw new ProxyError(`The system proxy settings only offer a proxy Yept doesn't support (${entries[0].split(/\s+/)[0]}). Use an HTTP proxy, or set one in Settings`);
  return null;
}

const LOOPBACK = (() => {
  const b = new BlockList();
  b.addSubnet('127.0.0.0', 8, 'ipv4');
  b.addAddress('::1', 'ipv6');
  return b;
})();

/** localhost and loopback addresses never go through a proxy. */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const family = isIP(h);
  return family !== 0 && LOOPBACK.check(h, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Whether a host matches a bypass list (NO_PROXY or the manual list): entries separated by commas, semicolons or
 * spaces. `example.test` and `.example.test` match the host and its subdomains, `*.example.test` only subdomains,
 * `*` everything, `10.0.0.0/8` a range, `host:port` one port, `<local>` names without a dot, and `*` inside an entry
 * any characters.
 */
export function bypasses(list: string, host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  for (const raw of list.split(/[\s,;]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry === '<local>') {
      if (!h.includes('.') && !isIP(h)) return true;
      continue;
    }
    if (entry.includes('/')) {
      const [base, bits] = entry.split('/');
      const family = isIP(base);
      if (family && isIP(h) === family) {
        const b = new BlockList();
        try {
          b.addSubnet(base, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
          if (b.check(h, family === 6 ? 'ipv6' : 'ipv4')) return true;
        } catch {
          /* not a valid range: ignored */
        }
      }
      continue;
    }
    // host:port, [v6]:port
    const portMatch = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
    if (portMatch) {
      if (Number(portMatch[2]) !== port) continue;
      entry = portMatch[1];
    }
    entry = entry.replace(/^\[|\]$/g, '');
    if (entry.startsWith('*.')) {
      if (h.endsWith(entry.slice(1))) return true;
    } else if (entry.includes('*')) {
      const re = new RegExp(`^${entry.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      if (re.test(h)) return true;
    } else {
      const bare = entry.replace(/^\./, '');
      if (h === bare || h.endsWith(`.${bare}`)) return true;
    }
  }
  return false;
}

const envValue = (env: Record<string, string | undefined>, name: string): [string, string] | undefined => {
  for (const n of [name.toLowerCase(), name.toUpperCase()]) {
    const v = env[n]?.trim();
    if (v) return [n, v];
  }
  return undefined;
};

export interface ProxyRouterOptions {
  /** The operating system's answer for a URL, in PAC result format (Electron's session.resolveProxy). */
  system?: (url: string) => Promise<string>;
  /** Environment variables: HTTPS_PROXY, HTTP_PROXY and NO_PROXY, in either case. */
  env?: Record<string, string | undefined>;
}

/** Picks the proxy for each URL. One router per proxy configuration; system answers are cached for a minute. */
export class ProxyRouter {
  readonly key: string;
  private cache = new Map<string, { at: number; value: ProxyServer | null }>();
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly config: ProxyConfig, private readonly options: ProxyRouterOptions = {}) {
    this.env = options.env ?? {};
    const envKeys = ['https_proxy', 'http_proxy', 'no_proxy'].map((n) => envValue(this.env, n)?.[1] ?? '');
    this.key = createHash('sha256').update(JSON.stringify([config, envKeys, !!options.system])).digest('hex');
  }

  /** The proxy for a URL when it's known now; undefined when only the operating system can say. */
  peek(url: URL): ProxyServer | null | undefined {
    const host = url.hostname;
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    if (this.config.mode === 'off' || isLoopback(host)) return null;
    if (this.config.mode === 'manual') {
      if (bypasses(this.config.bypass, host, port)) return null;
      return this.withSignIn(parseProxyUrl(this.config.url, 'manual'));
    }
    const fromEnv = envValue(this.env, url.protocol === 'https:' ? 'https_proxy' : 'http_proxy');
    if (fromEnv) {
      if (bypasses(envValue(this.env, 'no_proxy')?.[1] ?? '', host, port)) return null;
      return this.withSignIn(parseProxyUrl(fromEnv[1], 'environment', `The ${fromEnv[0]} environment variable`));
    }
    if (!this.options.system) return null;
    const hit = this.cache.get(this.origin(url));
    return hit && Date.now() - hit.at < SYSTEM_CACHE_MS ? hit.value : undefined;
  }

  async resolve(url: URL): Promise<ProxyServer | null> {
    const known = this.peek(url);
    if (known !== undefined) return known;
    let answer: string;
    try {
      answer = await this.options.system!(url.href);
    } catch (e) {
      throw new ProxyError(`Couldn't read the system proxy settings: ${(e as Error).message}`);
    }
    const parsed = parseSystemProxy(answer);
    const value = parsed && this.withSignIn(parsed);
    this.cache.set(this.origin(url), { at: Date.now(), value });
    return value;
  }

  private origin(url: URL): string {
    return `${url.protocol}//${url.host}`;
  }

  private withSignIn(p: ProxyServer): ProxyServer {
    if (p.username || p.password || !this.config.username) return p;
    return { ...p, username: this.config.username, password: this.config.password };
  }
}

const basicAuth = (p: ProxyServer): string | undefined =>
  p.username || p.password ? `Basic ${Buffer.from(`${p.username ?? ''}:${p.password ?? ''}`).toString('base64')}` : undefined;

/** Connection phases of a tunnel, timed by the agent, for the Network view. */
export interface TunnelMarks {
  start: number;
  lookup?: number;
  /** Connected to the proxy (TLS included for an HTTPS proxy). */
  connect?: number;
  /** The proxy accepted CONNECT. */
  tunnel?: number;
}

/** Which proxy a socket goes through. `marks` are set for tunnels, which the agent opens before handing them over. */
export interface ViaProxy {
  proxy: string;
  source: ProxySource;
  marks?: TunnelMarks;
}

export const viaProxy = new WeakMap<Socket, ViaProxy>();

function reachFailure(p: ProxyServer, e: Error & { code?: string }): ProxyError {
  if (e instanceof ProxyError) return e;
  const why: Record<string, string> = {
    ECONNREFUSED: 'connection refused',
    ENOTFOUND: 'host not found',
    EAI_AGAIN: 'DNS lookup failed',
    ECONNRESET: 'connection reset',
    EHOSTUNREACH: 'host unreachable',
    ETIMEDOUT: 'timed out'
  };
  return new ProxyError(`Couldn't reach the proxy ${proxyName(p)}: ${why[e.code ?? ''] ?? e.message}`);
}

/** A connection to the proxy itself (TLS for an HTTPS proxy, checked with the request's TLS settings). */
function connectToProxy(p: ProxyServer, tlsOptions: tls.ConnectionOptions, marks?: TunnelMarks): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s: Socket = p.protocol === 'https:'
      ? tls.connect({ ...tlsOptions, host: p.host, port: p.port, servername: isIP(p.host) ? undefined : p.host, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: p.host, port: p.port });
    const fail = (e: Error): void => {
      s.destroy();
      reject(reachFailure(p, e));
    };
    s.setTimeout(CONNECT_TIMEOUT_MS, () => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    s.once('error', fail);
    s.once('lookup', () => marks && (marks.lookup = performance.now()));
    s.once(p.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      if (marks) marks.connect = performance.now();
      s.removeListener('error', fail);
      s.setTimeout(0);
      resolve(s);
    });
  });
}

/** Opens a CONNECT tunnel through the proxy to host:port. Resolves the raw socket, ready for TLS (or plain HTTP). */
export async function openTunnel(p: ProxyServer, host: string, port: number, tlsOptions: tls.ConnectionOptions = {}, marks?: TunnelMarks): Promise<Socket> {
  const s = await connectToProxy(p, tlsOptions, marks);
  const authority = `${hostForUrl(host)}:${port}`;
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    const done = (e?: Error): void => {
      s.removeListener('data', onData);
      s.removeListener('error', onError);
      s.removeListener('end', onEnd);
      s.setTimeout(0);
      if (e) {
        s.destroy();
        reject(e);
      }
    };
    const onError = (e: Error): void => done(reachFailure(p, e));
    const onEnd = (): void => done(new ProxyError(`The proxy ${proxyName(p)} closed the connection before answering CONNECT ${authority}`));
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_RESPONSE_HEAD) done(new ProxyError(`The proxy ${proxyName(p)} sent an answer Yept can't read`));
        return;
      }
      const statusLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
      const status = m ? Number(m[1]) : 0;
      if (status >= 200 && status < 300) {
        done();
        const rest = head.subarray(end + 4);
        if (rest.length) s.unshift(rest);
        if (marks) marks.tunnel = performance.now();
        resolve(s);
        return;
      }
      const reason = m?.[2] ? ` ${m[2]}` : '';
      if (status === 407) {
        done(new ProxyError(basicAuth(p)
          ? `The proxy ${proxyName(p)} didn't accept the username and password (407${reason})`
          : `The proxy ${proxyName(p)} needs a username and password (407${reason}). Add them in Settings`));
      } else if (!m) {
        done(new ProxyError(`The proxy ${proxyName(p)} sent an answer Yept can't read`));
      } else {
        done(new ProxyError(`The proxy ${proxyName(p)} refused to connect to ${authority} (${status}${reason})`));
      }
    };
    s.on('data', onData);
    s.once('error', onError);
    s.once('end', onEnd);
    s.setTimeout(CONNECT_TIMEOUT_MS, () => done(new ProxyError(`The proxy ${proxyName(p)} didn't answer CONNECT ${authority} in time`)));
    const auth = basicAuth(p);
    s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
  });
}

type Callback = (err: Error | null, stream: Duplex) => void;
const failed = (cb: Callback | undefined, e: Error): void => cb?.(e, undefined as unknown as Duplex);
type ConnOptions = http.ClientRequestArgs & tls.ConnectionOptions & { host: string; port: number; _yeptProxy?: ProxyServer; _yeptResolve?: boolean; _yeptError?: Error };

/** The proxy's own TLS settings: the same trust as the requests. */
const proxyTls = (o: tls.ConnectionOptions): tls.ConnectionOptions => ({ ca: o.ca, rejectUnauthorized: o.rejectUnauthorized });

/** HTTPS through the router: each new connection asks it, and tunnels when there's a proxy. */
class ProxyHttpsAgent extends https.Agent {
  constructor(options: https.AgentOptions, private readonly router?: ProxyRouter, private readonly certs?: LoadedClientCertificate[]) {
    super(options);
  }

  // Node's agent accepts a socket through the callback when this returns nothing.
  override createConnection(args: http.ClientRequestArgs, cb?: Callback): Duplex | undefined {
    const base = args as ConnOptions;
    // The client certificate for this host, if one is set: offered when the server asks for one.
    const cert = certificateFor(this.certs, base.host, base.port);
    const options: ConnOptions = cert ? { ...base, pfx: cert.pfx, cert: cert.cert, key: cert.key, passphrase: cert.passphrase } : base;
    const direct = (): Socket => (https.Agent.prototype as unknown as { createConnection: (o: unknown) => Socket }).createConnection.call(this, options);
    const target = new URL(`https://${hostForUrl(options.host)}:${options.port}`);
    let known: ProxyServer | null | undefined;
    try {
      known = this.router ? this.router.peek(target) : null;
    } catch (e) {
      failed(cb, e as Error);
      return undefined;
    }
    if (known === null) return direct();
    (known ? Promise.resolve(known) : this.router!.resolve(target))
      .then(async (p) => {
        if (!p) return cb?.(null, direct());
        const marks: TunnelMarks = { start: performance.now() };
        const raw = await openTunnel(p, options.host, options.port, proxyTls(options), marks);
        const socket = (https.Agent.prototype as unknown as { createConnection: (o: unknown) => Socket }).createConnection.call(this, { ...options, socket: raw });
        viaProxy.set(socket, { proxy: proxyName(p), source: p.source, marks });
        cb?.(null, socket);
      })
      .catch((e: Error) => failed(cb, e));
    return undefined;
  }
}

/**
 * Plain HTTP through the router. With a proxy known up front, the request goes to the proxy with the full URL as
 * its target. When only the operating system can say (a redirect to a new host), the connection asks it and tunnels.
 */
class ProxyHttpAgent extends http.Agent {
  constructor(options: http.AgentOptions, private readonly router: ProxyRouter) {
    super(options);
  }

  addRequest(req: http.ClientRequest, options: ConnOptions): void {
    const target = new URL(`http://${hostForUrl(options.host)}:${options.port}`);
    let next: ConnOptions = options;
    try {
      const p = this.router.peek(target);
      if (p) {
        req.path = `http://${target.host}${req.path}`;
        const auth = basicAuth(p);
        if (auth && !req.hasHeader('proxy-authorization')) req.setHeader('Proxy-Authorization', auth);
        next = { ...options, host: p.host, port: p.port, _yeptProxy: p };
      } else if (p === undefined) {
        next = { ...options, _yeptResolve: true };
      }
    } catch (e) {
      next = { ...options, _yeptError: e as Error };
    }
    (http.Agent.prototype as unknown as { addRequest: (r: unknown, o: unknown) => void }).addRequest.call(this, req, next);
  }

  override createConnection(args: http.ClientRequestArgs, cb?: Callback): Duplex | undefined {
    const options = args as ConnOptions;
    const plain = (o: ConnOptions): Socket => (http.Agent.prototype as unknown as { createConnection: (o: unknown) => Socket }).createConnection.call(this, o);
    if (options._yeptError) {
      failed(cb, options._yeptError);
      return undefined;
    }
    const p = options._yeptProxy;
    if (p) {
      if (p.protocol === 'http:') {
        const s = plain(options);
        viaProxy.set(s, { proxy: proxyName(p), source: p.source });
        return s;
      }
      connectToProxy(p, proxyTls(options))
        .then((s) => {
          viaProxy.set(s, { proxy: proxyName(p), source: p.source });
          cb?.(null, s);
        })
        .catch((e: Error) => failed(cb, e));
      return undefined;
    }
    if (!options._yeptResolve) return plain(options);
    this.router
      .resolve(new URL(`http://${hostForUrl(options.host)}:${options.port}`))
      .then(async (route) => {
        if (!route) return cb?.(null, plain(options));
        const marks: TunnelMarks = { start: performance.now() };
        const s = await openTunnel(route, options.host, options.port, proxyTls(options), marks);
        viaProxy.set(s, { proxy: proxyName(route), source: route.source, marks });
        cb?.(null, s);
      })
      .catch((e: Error) => failed(cb, e));
    return undefined;
  }
}

/** Agents that send through the router's proxies (if any), offering a client certificate to hosts that have one. */
export function proxyAgents(router: ProxyRouter | undefined, httpOptions: http.AgentOptions, httpsOptions: https.AgentOptions, certs?: LoadedClientCertificate[]): { http: http.Agent; https: https.Agent } {
  return { http: router ? new ProxyHttpAgent(httpOptions, router) : new http.Agent(httpOptions), https: new ProxyHttpsAgent(httpsOptions, router, certs) };
}
