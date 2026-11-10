import type { Cipher } from '@yept/core/engine/env/local-store';
import type { HostEvents, ProcessMetric, SelfTestResult } from '@yept/core/shared/ipc';
import type { Appearance } from '@yept/core/shared/model';

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  properties?: ('openFile' | 'openDirectory' | 'multiSelections')[];
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** Platform services used by the application handlers, independent of their transport. */
export interface AppHost {
  userDataPath(): string;
  appVersion(): string;
  versions(): Record<string, string>;
  notices(): Promise<string>;
  selfTest(): Promise<SelfTestResult[]>;
  sandboxWorkerPath: string | URL;
  openDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  saveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  trash(path: string): Promise<void>;
  openExternal(url: string): void;
  /** Opens a validated OAuth2 authorization URL and reports whether the browser opened. */
  openAuthorizationUrl?(url: string): Promise<void>;
  writeClipboard(text: string): void;
  cipher: Cipher;
  applyAppearance(appearance: Appearance): void;
  metrics(): ProcessMetric[];
  emit<K extends keyof HostEvents>(channel: K, event: HostEvents[K]): void;
}
