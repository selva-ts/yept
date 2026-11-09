import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppHost } from '@yept/core/services/host';
import { unavailableCipher } from './cipher';

/** Services that need VS Code itself; the extension passes them in, tests may leave them out. */
export interface HostOptions {
  cipher?: AppHost['cipher'];
  openDialog?: AppHost['openDialog'];
  saveDialog?: AppHost['saveDialog'];
  trash?: AppHost['trash'];
}

export async function createHost(storage: string, extensionPath: string, version: string, versions: Record<string, string>, writeClipboard: (text: string) => void, emit: AppHost['emit'], options: HostOptions = {}): Promise<AppHost> {
  await mkdir(storage, { recursive: true });
  const unavailable = (): never => { throw new Error('This operation is not available in the extension yet'); };
  return {
    userDataPath: () => storage, appVersion: () => version, versions: () => ({ ...versions, app: version }),
    sandboxWorkerPath: join(extensionPath, 'dist', 'worker.cjs'),
    writeClipboard, emit, cipher: options.cipher ?? unavailableCipher('no secret storage is connected'),
    openDialog: options.openDialog ?? unavailable, trash: options.trash ?? unavailable,
    notices: unavailable, selfTest: unavailable, saveDialog: options.saveDialog ?? unavailable,
    openExternal: unavailable, applyAppearance: () => {}, metrics: () => []
  };
}
