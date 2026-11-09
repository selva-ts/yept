import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { createApi, type Subscribe } from '@shared/create-api';

const invoke = (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(channel, ...args);

const subscribe: Subscribe = (channel, cb) => {
  const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]): void => cb(event);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('yept', createApi(invoke, subscribe));
