import { ipcMain } from 'electron';
import { IPC_ERROR_PREFIX } from '@yept/core/shared/ipc';
import type { HandlerRegistry } from '@yept/core/shared/handler-registry';

/** Binds only the registered application operations and preserves Electron's readable error format. */
export function bindIpc(registry: HandlerRegistry): () => void {
  const channels = registry.channels();
  for (const channel of channels) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await registry.invoke(channel, ...args);
      } catch (e) {
        throw new Error(IPC_ERROR_PREFIX + (e instanceof Error ? e.message : String(e)));
      }
    });
  }
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}
