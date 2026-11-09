// Cookie jars for the main process: one per collection and active environment, stored encrypted
// (Windows DPAPI via safeStorage) in the user's app-data folder, never in collection files.
import { join } from 'node:path';
import { CookieStore, type RunCookies } from '@yept/core/engine/cookies/cookie-store';
import type { CookieJarView } from '@yept/core/shared/ipc';
import type { CookieView } from '@yept/core/shared/model';
import type { EnvService } from './env-service';
import type { AppHost } from './host';
import type { SettingsService } from './settings-service';
import type { Workspace } from '@yept/core/engine/workspace/workspace';

export class CookieService {
  private store: CookieStore | null = null;

  /** A store passed in is shared with other services, so they keep one set of jars and one file. */
  constructor(private ws: () => Workspace, private env: EnvService, private settings: SettingsService, private host: Pick<AppHost, 'userDataPath' | 'cipher'>, store?: CookieStore) {
    this.store = store ?? null;
  }

  private jars(): CookieStore {
    this.store ??= new CookieStore(join(this.host.userDataPath(), 'cookies.json'), this.host.cipher);
    return this.store;
  }

  private where(collectionId: string): { dir: string; environment: string } {
    return { dir: this.ws().collectionDir(collectionId), environment: this.env.active(collectionId) ?? '' };
  }

  /** The jar a run uses, or undefined when automatic cookies are turned off. */
  forRun(collectionDir: string, environment: string): RunCookies | undefined {
    return this.settings.get().cookies ? this.jars().forRun(collectionDir, environment) : undefined;
  }

  view(collectionId: string): CookieJarView {
    const { dir, environment } = this.where(collectionId);
    return { collectionId, environment, enabled: this.settings.get().cookies, cookies: this.jars().list(dir, environment) };
  }

  upsert(collectionId: string, cookie: CookieView, previous?: Pick<CookieView, 'domain' | 'path' | 'name'>): CookieJarView {
    const { dir, environment } = this.where(collectionId);
    this.jars().upsert(dir, environment, cookie, previous);
    return this.view(collectionId);
  }

  remove(collectionId: string, target: Pick<CookieView, 'domain' | 'path' | 'name'>): CookieJarView {
    const { dir, environment } = this.where(collectionId);
    this.jars().remove(dir, environment, target);
    return this.view(collectionId);
  }

  clear(collectionId: string, domain?: string): CookieJarView {
    const { dir, environment } = this.where(collectionId);
    this.jars().clear(dir, environment, domain);
    return this.view(collectionId);
  }
}
