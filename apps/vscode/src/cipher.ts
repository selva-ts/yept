import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Cipher } from '@yept/core/engine/env/local-store';

/** Where the data key lives in VS Code's secret storage (the operating system's keychain). */
export const KEY_NAME = 'yept.localDataKey';
const FORMAT = 'v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The part of VS Code's SecretStorage the key needs. */
export interface KeyStorage {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

/**
 * Local secrets, overrides and cookies are encrypted with AES-256-GCM under one random key. The key itself is kept in
 * VS Code's secret storage, never on disk next to the data. Each value gets a fresh IV; the tag rejects any change.
 */
export function keyCipher(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error('The local data key must be 32 bytes');
  return {
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return FORMAT + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt(encrypted) {
      const raw = encrypted.startsWith(FORMAT) ? Buffer.from(encrypted.slice(FORMAT.length), 'base64') : null;
      if (!raw || raw.length < IV_BYTES + TAG_BYTES) throw new Error('A stored secret is not in the expected format');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('A stored secret could not be decrypted; it was changed or saved with another key. Set it again');
      }
    }
  };
}

/**
 * Reads the data key, creating it on first use. After storing a new key it reads back what was stored, so two windows
 * activating at the same moment settle on the same key.
 */
export async function loadKey(storage: KeyStorage): Promise<Buffer> {
  const decode = (value: string): Buffer => {
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error('The stored local data key is invalid');
    return key;
  };
  const existing = await storage.get(KEY_NAME);
  if (existing) return decode(existing);
  await storage.store(KEY_NAME, randomBytes(32).toString('base64'));
  const stored = await storage.get(KEY_NAME);
  if (!stored) throw new Error('Secret storage did not keep the local data key');
  return decode(stored);
}

/** Used when the keychain can't be reached: everything else works, secrets explain why they can't be saved. */
export function unavailableCipher(reason: string): Cipher {
  const fail = (): never => { throw new Error(`Secrets can't be stored: ${reason}`); };
  return { encrypt: fail, decrypt: fail };
}
