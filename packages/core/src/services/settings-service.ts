// App-wide preferences that aren't tied to a collection: appearance (light/dark, theme, fonts), history limits,
// automatic cookies and the proxy. The proxy password is stored encrypted and never leaves this service except
// to send requests.
import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROXY, type AppSettings, type ProxySettings } from '@yept/core/shared/model';
import { cleanCodeSize, cleanFontName, isPalette } from '@yept/core/shared/appearance';
import type { AppHost } from './host';

export class SettingsService {
  private current: AppSettings;
  /** Encrypted; '' when none. */
  private proxyPasswordStored = '';

  private file(): string {
    return join(this.host.userDataPath(), 'settings.json');
  }

  constructor(private host: Pick<AppHost, 'userDataPath'> & Partial<Pick<AppHost, 'cipher'>>) {
    let loaded: Partial<AppSettings> & { proxyPassword?: unknown } = {};
    try {
      loaded = JSON.parse(readFileSync(this.file(), 'utf8'));
    } catch {
      // first run or unreadable: defaults
    }
    if (typeof loaded.proxyPassword === 'string') this.proxyPasswordStored = loaded.proxyPassword;
    this.current = SettingsService.clean({ ...DEFAULT_APP_SETTINGS, ...loaded });
  }

  static cleanProxy(p: Partial<ProxySettings> | undefined): ProxySettings {
    const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    return {
      mode: p?.mode === 'manual' || p?.mode === 'off' ? p.mode : DEFAULT_PROXY.mode,
      url: text(p?.url, 2000),
      bypass: text(p?.bypass, 4000),
      username: text(p?.username, 500)
    };
  }

  static clean(s: AppSettings): AppSettings {
    const num = (v: unknown, d: number, min: number, max: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
    };
    return {
      theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
      palette: isPalette(s.palette) ? s.palette : DEFAULT_APP_SETTINGS.palette,
      uiFont: cleanFontName(s.uiFont),
      codeFont: cleanFontName(s.codeFont),
      codeFontSize: cleanCodeSize(s.codeFontSize),
      historyRunsPerRequest: Math.round(num(s.historyRunsPerRequest, DEFAULT_APP_SETTINGS.historyRunsPerRequest, 1, 500)),
      historyCapMb: num(s.historyCapMb, DEFAULT_APP_SETTINGS.historyCapMb, 10, 20_000),
      historyBodyLimitMb: num(s.historyBodyLimitMb, DEFAULT_APP_SETTINGS.historyBodyLimitMb, 0, 50),
      cookies: s.cookies !== false,
      proxy: SettingsService.cleanProxy(s.proxy)
    };
  }

  get(): AppSettings {
    return { ...this.current, proxy: { ...this.current.proxy } };
  }

  set(next: AppSettings): AppSettings {
    this.current = SettingsService.clean(next);
    this.write();
    return this.get();
  }

  hasProxyPassword(): boolean {
    return this.proxyPasswordStored !== '';
  }

  /** The proxy password for sending requests; '' when none is stored or it can't be decrypted here. */
  proxyPassword(): string {
    if (!this.proxyPasswordStored || !this.host.cipher) return '';
    try {
      return this.host.cipher.decrypt(this.proxyPasswordStored);
    } catch {
      return ''; // e.g. copied from another Windows account
    }
  }

  /** Stores the proxy password encrypted, or removes it ('' or null). */
  setProxyPassword(password: string | null): void {
    if (password && !this.host.cipher) throw new Error("Passwords can't be stored here");
    this.proxyPasswordStored = password ? this.host.cipher!.encrypt(password) : '';
    this.write();
  }

  private write(): void {
    const tmp = `${this.file()}.tmp`;
    const stored = this.proxyPasswordStored ? { ...this.current, proxyPassword: this.proxyPasswordStored } : this.current;
    writeFileSync(tmp, JSON.stringify(stored, null, 2));
    renameSync(tmp, this.file());
  }
}
