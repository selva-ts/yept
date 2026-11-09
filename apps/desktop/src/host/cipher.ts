import { safeStorage } from 'electron';
import type { Cipher } from '@yept/core/engine/env/local-store';

export const safeCipher: Cipher = {
  encrypt: (plain) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system, so secrets cannot be saved');
    return safeStorage.encryptString(plain).toString('base64');
  },
  decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, 'base64'))
};
