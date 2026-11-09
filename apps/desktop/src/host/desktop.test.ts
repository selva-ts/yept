import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { DEFAULT_APP_SETTINGS } from '@yept/core/shared/model';
import { createDesktopHost } from './desktop';

const { electron } = vi.hoisted(() => ({ electron: {
  app: { getPath: vi.fn(), getVersion: vi.fn(), getAppMetrics: vi.fn(), getAppPath: vi.fn(), isPackaged: false },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { trashItem: vi.fn(), openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
  nativeTheme: { themeSource: 'system' }
} }));
vi.mock('electron', () => electron);
vi.mock('./cipher', () => ({ safeCipher: { encrypt: (value: string) => value, decrypt: (value: string) => value } }));
vi.mock('./main/self-test', () => ({ runSelfTests: async () => [] }));
vi.mock('@yept/core/engine/sandbox/worker.mjs?modulePath', () => ({ default: 'synthetic-worker.mjs' }));
beforeEach(() => {
  vi.clearAllMocks();
  electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  electron.shell.openExternal.mockResolvedValue(undefined);
  electron.nativeTheme.themeSource = 'system';
});

it('passes dialog options and cancellation through with or without a parent window', async () => {
  let window = { webContents: { send: vi.fn() } } as unknown as BrowserWindow | null;
  const host = createDesktopHost(() => window, () => {});
  const options = { title: 'Synthetic picker', properties: ['openFile' as const] };
  expect(await host.openDialog(options)).toEqual({ canceled: true, filePaths: [] });
  expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(window, options);
  const save = { defaultPath: 'synthetic.json' };
  expect(await host.saveDialog(save)).toEqual({ canceled: true });
  expect(electron.dialog.showSaveDialog).toHaveBeenLastCalledWith(window, save);
  window = null;
  await host.openDialog(options);
  await host.saveDialog(save);
  expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(options);
  expect(electron.dialog.showSaveDialog).toHaveBeenLastCalledWith(save);
});

it('keeps metric values and converts working-set kilobytes to bytes', () => {
  electron.app.getAppMetrics.mockReturnValue([{ pid: 42, type: 'Utility', serviceName: 'synthetic', cpu: { percentCPUUsage: 1.25 }, memory: { workingSetSize: 1024 } }]);
  expect(createDesktopHost(() => null, () => {}).metrics()).toEqual([{ pid: 42, type: 'Utility', name: 'synthetic', cpu: 1.25, memory: 1048576 }]);
});

it('sends events unchanged to the current window and tolerates a closed window', () => {
  const send = vi.fn();
  let window = { webContents: { send } } as unknown as BrowserWindow | null;
  const host = createDesktopHost(() => window, () => {});
  const change = { snapshot: { root: 'synthetic', collections: [], problems: [] }, changedRequestIds: [], removedRequestIds: [] };
  host.emit('workspace:external-change', change);
  expect(send).toHaveBeenCalledWith('workspace:external-change', change);
  window = null;
  expect(() => host.emit('workspace:external-change', change)).not.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});

it('changes the native theme before refreshing window colours', () => {
  const changed = vi.fn(() => expect(electron.nativeTheme.themeSource).toBe('dark'));
  createDesktopHost(() => null, changed).applyAppearance({ ...DEFAULT_APP_SETTINGS, theme: 'dark' });
  expect(changed).toHaveBeenCalledTimes(1);
});

it('keeps the web-only policy when opening links through the shell', () => {
  const host = createDesktopHost(() => null, () => {});
  host.openExternal('file:///synthetic.txt');
  expect(electron.shell.openExternal).not.toHaveBeenCalled();
  host.openExternal('HTTPS://API.EXAMPLE.TEST/docs');
  expect(electron.shell.openExternal).toHaveBeenCalledWith('https://api.example.test/docs');
});
