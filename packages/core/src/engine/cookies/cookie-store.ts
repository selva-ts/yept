// Cookie jars, one per collection and environment, so a session cookie from one environment is never sent
// while another is selected, and two collections that call the same host don't share cookies.
// Session cookies live in memory only and are gone when the app closes, like a browser. Persistent cookies
// (Expires or Max-Age) are saved to one file, encrypted with the injected cipher, until they expire.
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Cookie, CookieJar, type SerializedCookie, type SerializedCookieJar } from 'tough-cookie';
import type { Cipher } from '../env/local-store';
import type { CookieView } from '../../shared/model';

/** What the runner and the script sandbox need from one jar. */
export interface RunCookies {
  /** The Cookie header for a URL, '' when nothing matches. */
  header(url: string): string;
  /** Stores Set-Cookie headers received from a URL. Returns the names stored. */
  store(url: string, setCookie: string[]): string[];
  /** The jar as plain data, for the script sandbox. */
  serialize(): SerializedCookieJar;
  /** Replaces the jar with a script's changed copy. The later change wins if two runs overlap. */
  replace(data: SerializedCookieJar): void;
}

interface FileShape {
  version: 1;
  /** Encrypted JSON: jar key -> serialized jar with persistent cookies only. */
  data: string;
}

const newJar = (): CookieJar => new CookieJar(undefined, { rejectPublicSuffixes: true, allowSpecialUseDomain: true });

const isPersistent = (c: SerializedCookie): boolean => (c.expires !== undefined && c.expires !== 'Infinity') || typeof c.maxAge === 'number';

function expiry(c: SerializedCookie): Date | undefined {
  return Cookie.fromJSON(c)?.expiryDate() ?? undefined;
}

export function toView(c: SerializedCookie): CookieView {
  const exp = isPersistent(c) ? expiry(c) : undefined;
  return {
    name: String(c.key ?? ''),
    value: String(c.value ?? ''),
    domain: String(c.domain ?? ''),
    path: String(c.path ?? '/'),
    expires: exp ? exp.toISOString() : null,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite ? String(c.sameSite) : '',
    hostOnly: c.hostOnly !== false
  };
}

export class CookieStore {
  private jars = new Map<string, CookieJar>();

  constructor(private path: string, private cipher: Cipher) {
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as FileShape;
      if (parsed?.version !== 1 || typeof parsed.data !== 'string') return;
      const all = JSON.parse(cipher.decrypt(parsed.data)) as Record<string, SerializedCookieJar>;
      const now = Date.now();
      for (const [key, data] of Object.entries(all)) {
        const cookies = (data.cookies ?? []).filter((c) => (expiry(c)?.getTime() ?? Infinity) > now);
        if (cookies.length) this.jars.set(key, CookieJar.deserializeSync({ ...data, cookies }));
      }
    } catch {
      // Unreadable or written by another Windows user: start empty rather than block requests.
    }
  }

  // Keys are collection folders plus environment; Windows paths compare case-insensitively.
  private key(collectionDir: string, env: string): string {
    return `${process.platform === 'win32' ? collectionDir.toLowerCase() : collectionDir}\u0000${env}`;
  }

  private jar(collectionDir: string, env: string): CookieJar {
    const k = this.key(collectionDir, env);
    let j = this.jars.get(k);
    if (!j) {
      j = newJar();
      this.jars.set(k, j);
    }
    return j;
  }

  private serialized(collectionDir: string, env: string): SerializedCookieJar {
    return this.jar(collectionDir, env).serializeSync() ?? { ...newJar().serializeSync()!, cookies: [] };
  }

  private setCookies(collectionDir: string, env: string, cookies: SerializedCookie[]): void {
    const base = this.serialized(collectionDir, env);
    this.jars.set(this.key(collectionDir, env), CookieJar.deserializeSync({ ...base, cookies }));
    this.save();
  }

  /** Writes persistent cookies only. Session cookies stay in memory. */
  save(): void {
    const all: Record<string, SerializedCookieJar> = {};
    for (const [key, jar] of this.jars) {
      const data = jar.serializeSync();
      const cookies = (data?.cookies ?? []).filter(isPersistent);
      if (data && cookies.length) all[key] = { ...data, cookies };
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, data: this.cipher.encrypt(JSON.stringify(all)) } satisfies FileShape), 'utf8');
    renameSync(tmp, this.path);
  }

  forRun(collectionDir: string, env: string): RunCookies {
    return {
      header: (url) => {
        try {
          return this.jar(collectionDir, env).getCookieStringSync(url);
        } catch {
          return '';
        }
      },
      store: (url, setCookie) => {
        const jar = this.jar(collectionDir, env);
        const names: string[] = [];
        for (const line of setCookie) {
          const c = jar.setCookieSync(line, url, { ignoreError: true });
          if (c) names.push(c.key);
        }
        if (names.length) this.save();
        return names;
      },
      serialize: () => this.serialized(collectionDir, env),
      replace: (data) => {
        this.jars.set(this.key(collectionDir, env), CookieJar.deserializeSync(data));
        this.save();
      }
    };
  }

  /** Every cookie in the jar, unexpired, sorted by domain then name. */
  list(collectionDir: string, env: string): CookieView[] {
    const now = Date.now();
    return (this.serialized(collectionDir, env).cookies ?? [])
      .filter((c) => (expiry(c)?.getTime() ?? Infinity) > now)
      .map(toView)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  }

  count(collectionDir: string, env: string): number {
    return this.list(collectionDir, env).length;
  }

  /** Adds or replaces a cookie (same domain, path and name). `previous` identifies the one being edited. */
  upsert(collectionDir: string, env: string, view: CookieView, previous?: Pick<CookieView, 'domain' | 'path' | 'name'>): void {
    const domain = view.domain.trim().replace(/^\./, '').toLowerCase();
    const name = view.name.trim();
    if (!domain) throw new Error('A cookie needs a domain');
    if (!name) throw new Error('A cookie needs a name');
    if (/[;,\s]/.test(name) || /[;\r\n]/.test(view.value)) throw new Error('Cookie names cannot contain spaces, commas or semicolons, and values cannot contain semicolons or line breaks');
    const path = view.path.trim() || '/';
    const cookie = new Cookie({
      key: name,
      value: view.value,
      domain,
      path: path.startsWith('/') ? path : `/${path}`,
      expires: view.expires ? new Date(view.expires) : 'Infinity',
      secure: view.secure,
      httpOnly: view.httpOnly,
      sameSite: view.sameSite || undefined,
      hostOnly: view.hostOnly,
      creation: new Date()
    });
    const same = (c: SerializedCookie, d: string, p: string, n: string): boolean => c.domain === d && (c.path ?? '/') === p && c.key === n;
    const keep = (this.serialized(collectionDir, env).cookies ?? []).filter(
      (c) => !same(c, domain, cookie.path ?? '/', name) && !(previous && same(c, previous.domain, previous.path, previous.name))
    );
    this.setCookies(collectionDir, env, [...keep, cookie.toJSON()]);
  }

  remove(collectionDir: string, env: string, target: Pick<CookieView, 'domain' | 'path' | 'name'>): void {
    const keep = (this.serialized(collectionDir, env).cookies ?? []).filter((c) => !(c.domain === target.domain && (c.path ?? '/') === target.path && c.key === target.name));
    this.setCookies(collectionDir, env, keep);
  }

  /** Removes every cookie for a domain, or the whole jar when domain is omitted. */
  clear(collectionDir: string, env: string, domain?: string): void {
    const keep = domain ? (this.serialized(collectionDir, env).cookies ?? []).filter((c) => c.domain !== domain) : [];
    this.setCookies(collectionDir, env, keep);
  }
}
