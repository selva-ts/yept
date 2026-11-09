import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { KEY_NAME, keyCipher, loadKey, unavailableCipher, type KeyStorage } from './cipher';

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  let stores = 0;
  const storage: KeyStorage & { stores: () => number; values: Map<string, string> } = {
    get: async (key) => values.get(key),
    store: async (key, value) => { stores++; values.set(key, value); },
    stores: () => stores,
    values
  };
  return storage;
};

it('round-trips text, including empty and non-ASCII values, with a fresh IV each time', () => {
  const cipher = keyCipher(randomBytes(32));
  for (const plain of ['synthetic-secret', '', 'pässwörd ✓ 秘密']) expect(cipher.decrypt(cipher.encrypt(plain))).toBe(plain);
  expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  expect(cipher.encrypt('synthetic-secret')).not.toContain('synthetic-secret');
});

it('rejects changed data, another key and other formats', () => {
  const cipher = keyCipher(randomBytes(32));
  const encrypted = cipher.encrypt('synthetic-secret');
  const raw = Buffer.from(encrypted.slice(3), 'base64');
  raw[raw.length - 1] ^= 1;
  expect(() => cipher.decrypt(`v1:${raw.toString('base64')}`)).toThrow('could not be decrypted');
  expect(() => keyCipher(randomBytes(32)).decrypt(encrypted)).toThrow('could not be decrypted');
  expect(() => cipher.decrypt('c3ludGhldGlj')).toThrow('not in the expected format');
  expect(() => cipher.decrypt('v1:AAAA')).toThrow('not in the expected format');
  expect(() => keyCipher(randomBytes(16))).toThrow('32 bytes');
});

it('creates the key once in secret storage and reuses it', async () => {
  const storage = memory();
  const first = await loadKey(storage);
  expect(first.length).toBe(32);
  expect(storage.values.get(KEY_NAME)).toBe(first.toString('base64'));
  const second = await loadKey(storage);
  expect(second.equals(first)).toBe(true);
  expect(storage.stores()).toBe(1);
  const encrypted = keyCipher(first).encrypt('synthetic-secret');
  expect(keyCipher(second).decrypt(encrypted)).toBe('synthetic-secret');
});

it('settles on the stored key when another window stored one first', async () => {
  const winner = randomBytes(32).toString('base64');
  let reads = 0;
  const storage: KeyStorage = { get: async () => (reads++ === 0 ? undefined : winner), store: async () => {} };
  expect((await loadKey(storage)).toString('base64')).toBe(winner);
});

it('refuses a damaged stored key and explains an unavailable keychain', async () => {
  await expect(loadKey(memory({ [KEY_NAME]: 'c2hvcnQ=' }))).rejects.toThrow('invalid');
  const cipher = unavailableCipher('the keychain is locked');
  expect(() => cipher.encrypt('x')).toThrow("Secrets can't be stored: the keychain is locked");
});
