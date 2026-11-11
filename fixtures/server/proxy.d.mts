import type { Server } from 'node:http';

export interface ProxySeen {
  kind: 'http' | 'connect';
  method?: string;
  url?: string;
  authority?: string;
  auth: boolean;
}

export function createTestProxy(options?: { target?: { host: string; port: number }; username?: string; password?: string }): { server: Server; seen: ProxySeen[] };
