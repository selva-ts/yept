import type { YeptApi } from '@shared/ipc';

declare global {
  interface Window {
    yept: YeptApi;
  }
}
