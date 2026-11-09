// App-wide preferences that aren't tied to a collection: appearance (light/dark, theme, fonts), history limits and
// automatic cookies.
import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@yept/core/shared/model';
import { cleanCodeSize, cleanFontName, isPalette } from '@yept/core/shared/appearance';
import type { AppHost } from './host';

export class SettingsService {
  private current: AppSettings;

  private file(): string {
    return join(this.host.userDataPath(), 'settings.json');
  }

  constructor(private host: Pick<AppHost, 'userDataPath'>) {
    let loaded: Partial<AppSettings> = {};
    try {
      loaded = JSON.parse(readFileSync(this.file(), 'utf8'));
    } catch {
      // first run or unreadable: defaults
    }
    this.current = SettingsService.clean({ ...DEFAULT_APP_SETTINGS, ...loaded });
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
      cookies: s.cookies !== false
    };
  }

  get(): AppSettings {
    return { ...this.current };
  }

  set(next: AppSettings): AppSettings {
    this.current = SettingsService.clean(next);
    const tmp = `${this.file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2));
    renameSync(tmp, this.file());
    return this.get();
  }
}
