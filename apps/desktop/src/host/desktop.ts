import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import sandboxWorkerPath from '@yept/core/engine/sandbox/worker.mjs?modulePath';
import type { AppHost } from '@yept/core/services/host';
import { openExternalUrl } from '../main/external-links';
import { runSelfTests } from './main/self-test';
import { safeCipher } from './cipher';

export function createDesktopHost(getWindow: () => BrowserWindow | null, appearanceChanged: () => void): AppHost {
  return {
    userDataPath: () => app.getPath('userData'),
    appVersion: () => app.getVersion(),
    versions: () => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }),
    notices: () => fs.readFile(join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build'), 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    selfTest: runSelfTests,
    sandboxWorkerPath,
    openDialog: (options) => {
      const win = getWindow();
      return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    },
    saveDialog: (options) => {
      const win = getWindow();
      return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
    },
    trash: (path) => shell.trashItem(path),
    openExternal: (url) => { openExternalUrl(url, (safe) => shell.openExternal(safe)); },
    openAuthorizationUrl: (url) => shell.openExternal(url),
    writeClipboard: (text) => clipboard.writeText(text),
    cipher: safeCipher,
    applyAppearance: (appearance) => {
      nativeTheme.themeSource = appearance.theme;
      appearanceChanged();
    },
    metrics: () => app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name ?? m.serviceName ?? '',
      cpu: m.cpu.percentCPUUsage,
      memory: m.memory.workingSetSize * 1024
    })),
    emit: (channel, event) => { getWindow()?.webContents.send(channel, event); }
  };
}
