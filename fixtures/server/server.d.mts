import type { Server } from 'node:http';

export const CLIENT_ID: string;
export const CLIENT_SECRET: string;
export function createFixtureServer(): Server;
