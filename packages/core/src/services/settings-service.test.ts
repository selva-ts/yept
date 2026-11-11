import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@yept/core/shared/model';
import { SettingsService } from './settings-service';

// Reversible stand-in for the platform's encryption: enough to show the file never holds the plain password.
const cipher = {
  encrypt: (s: string) => `enc:${Buffer.from(s).toString('base64')}`,
  decrypt: (s: string) => {
    if (!s.startsWith('enc:')) throw new Error('not encrypted here');
    return Buffer.from(s.slice(4), 'base64').toString();
  }
};

describe('proxy settings', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const service = (): SettingsService => new SettingsService({ userDataPath: () => dir, cipher });

  it('defaults to the system proxy and cleans what is saved', () => {
    dir = mkdtempSync(join(tmpdir(), 'yept-settings-'));
    const s = service();
    expect(s.get().proxy).toEqual({ mode: 'system', url: '', bypass: '', username: '' });
    s.set({ ...DEFAULT_APP_SETTINGS, proxy: { mode: 'socks' as never, url: '  http://proxy.example.test:8080 ', bypass: 'a.test', username: ' alex ' } });
    expect(service().get().proxy).toEqual({ mode: 'system', url: 'http://proxy.example.test:8080', bypass: 'a.test', username: 'alex' });
  });

  it('keeps the password encrypted, out of the settings and across restarts', () => {
    dir = mkdtempSync(join(tmpdir(), 'yept-settings-'));
    const s = service();
    s.set({ ...DEFAULT_APP_SETTINGS, proxy: { mode: 'manual', url: 'http://proxy.example.test:8080', bypass: '', username: 'alex' } });
    s.setProxyPassword('synthetic-proxy-pass');
    const file = readFileSync(join(dir, 'settings.json'), 'utf8');
    expect(file).not.toContain('synthetic-proxy-pass');
    expect(JSON.stringify(s.get())).not.toContain('enc:');
    const again = service();
    expect(again.hasProxyPassword()).toBe(true);
    expect(again.proxyPassword()).toBe('synthetic-proxy-pass');
    // Saving other settings keeps it.
    again.set({ ...again.get(), cookies: false });
    expect(service().proxyPassword()).toBe('synthetic-proxy-pass');
    again.setProxyPassword(null);
    expect(service().hasProxyPassword()).toBe(false);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('proxyPassword');
  });

  it('a password that cannot be decrypted here counts as none', () => {
    dir = mkdtempSync(join(tmpdir(), 'yept-settings-'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ proxyPassword: 'from-another-account' }));
    expect(service().proxyPassword()).toBe('');
  });
});
