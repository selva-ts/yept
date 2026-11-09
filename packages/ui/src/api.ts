import { IPC_ERROR_PREFIX } from '@shared/ipc';

export const yept = window.yept;

/** Turns "Error invoking remote method 'x': Error: YeptError: message" into "message". */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const i = raw.indexOf(IPC_ERROR_PREFIX);
  return i >= 0 ? raw.slice(i + IPC_ERROR_PREFIX.length) : raw;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
