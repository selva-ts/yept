import { beforeEach, expect, it, vi } from 'vitest';
import { safeCipher } from './cipher';

const { storage } = vi.hoisted(() => ({ storage: {
  isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn()
} }));
vi.mock('electron', () => ({ safeStorage: storage }));
beforeEach(() => {
  vi.clearAllMocks();
  storage.isEncryptionAvailable.mockReturnValue(true);
  storage.encryptString.mockReturnValue(Buffer.from('synthetic protected bytes'));
  storage.decryptString.mockReturnValue('synthetic secret');
});

it('keeps the synchronous base64 safeStorage format when encrypting and decrypting', () => {
  const encrypted = safeCipher.encrypt('synthetic secret');
  expect(encrypted).toBe(Buffer.from('synthetic protected bytes').toString('base64'));
  expect(storage.encryptString).toHaveBeenCalledWith('synthetic secret');
  expect(safeCipher.decrypt(encrypted)).toBe('synthetic secret');
  expect(storage.decryptString).toHaveBeenCalledWith(Buffer.from('synthetic protected bytes'));
});

it('refuses to save secrets when secure storage is unavailable', () => {
  storage.isEncryptionAvailable.mockReturnValue(false);
  expect(() => safeCipher.encrypt('synthetic secret')).toThrow('Secure storage is not available on this system, so secrets cannot be saved');
  expect(storage.encryptString).not.toHaveBeenCalled();
});

it('does not turn an unreadable encrypted value into plaintext or an empty value', () => {
  storage.decryptString.mockImplementation(() => { throw new Error('Synthetic decryption failure'); });
  expect(() => safeCipher.decrypt('c3ludGhldGlj')).toThrow('Synthetic decryption failure');
});
