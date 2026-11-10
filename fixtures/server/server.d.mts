import type { Server } from 'node:http';

export const CLIENT_ID: string;
export const CLIENT_SECRET: string;
export function createFixtureServer(): Server;
export const DIGEST_USER: string;
export const DIGEST_PASSWORD: string;
export const NTLM_USER: string;
export const NTLM_DOMAIN: string;
export const NTLM_PASSWORD: string;
export const AWS_ACCESS_KEY_ID: string;
export const AWS_SECRET_ACCESS_KEY: string;
