import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@yept/core/shared/model';
import { createHandlers } from './handlers';
import type { AppHost } from '@yept/core/services/host';

let dir: string, host: AppHost, application: ReturnType<typeof createHandlers>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yept-handlers-'));
  host = {
    userDataPath: () => dir,
    appVersion: () => '0.6.0',
    versions() { return { app: this.appVersion() }; },
    notices: vi.fn(async () => 'synthetic notices'),
    selfTest: vi.fn(async () => []),
    sandboxWorkerPath: 'unused-worker.mjs',
    openDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    saveDialog: vi.fn(async () => ({ canceled: true })),
    trash: vi.fn(async () => {}),
    openExternal: vi.fn(),
    writeClipboard: vi.fn(),
    cipher: { encrypt: (plain) => plain, decrypt: (encrypted) => encrypted },
    applyAppearance: vi.fn(), metrics: vi.fn(() => []), emit: vi.fn()
  };
  application = createHandlers(host);
});
afterEach(async () => { await application.close(); rmSync(dir, { recursive: true, force: true }); });

it('runs host operations through the registry in plain Node without Electron', async () => {
  expect(await application.handlers.invoke('app:versions')).toEqual({ app: '0.6.0' });
  expect(await application.handlers.invoke('app:notices')).toBe('synthetic notices');
  expect(await application.handlers.invoke('app:self-test')).toEqual([]);
  await application.handlers.invoke('clipboard:write', 'synthetic clipboard');
  expect(host.writeClipboard).toHaveBeenCalledWith('synthetic clipboard');
});

it('keeps cancelled workspace, CA and import pickers as null results', async () => {
  for (const channel of ['workspace:pick', 'env:pick-ca-file', 'import:pick']) {
    expect(await application.handlers.invoke(channel)).toBeNull();
  }
  expect(host.openDialog).toHaveBeenCalledTimes(3);
});

it('does not export history after a cancelled save dialog', async () => {
  expect(await application.handlers.invoke('history:export', [], true, 'synthetic.json')).toBeNull();
  expect(host.saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'synthetic.json' }));
});

it('persists appearance through the supplied data path and ignores unrelated keys', async () => {
  const original = application.settings();
  const result = await application.handlers.invoke('app-settings:set-appearance', { theme: 'dark', historyCapMb: 999 }) as { settings: AppSettings };
  expect(result.settings.theme).toBe('dark');
  expect(result.settings.historyCapMb).toBe(original.historyCapMb);
  expect(host.applyAppearance).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme).toBe('dark');
});

it('rejects an unavailable response before opening a save dialog', async () => {
  await expect(application.handlers.invoke('runs:save-body', 'missing-run', 'synthetic.txt')).rejects.toThrow('This response is no longer available to save');
  expect(host.saveDialog).not.toHaveBeenCalled();
});

it('refuses a pasted command that is not curl before touching the workspace', async () => {
  await expect(application.handlers.invoke('requests:create-from-curl', 'collection:none', 'Pasted', 'wget https://api.example.test/')).rejects.toThrow('This is not a curl command');
});

it('rejects preview bytes for a response that is not kept', async () => {
  await expect(application.handlers.invoke('runs:body-bytes', 'missing-run')).rejects.toThrow('no longer available');
});
