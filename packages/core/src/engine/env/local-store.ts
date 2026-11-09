// Per-machine data that must never reach the repository: local overrides, secret values
// (encrypted by an injected cipher, Windows DPAPI via Electron safeStorage in the app), the active
// environment per collection, and TLS settings per environment.
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TlsSettings } from '../../shared/model';

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

interface EnvLocal {
  overrides: Record<string, string>;
  /** Encrypted with the cipher. */
  secrets: Record<string, string>;
  tls: TlsSettings;
}

interface CollectionLocal {
  activeEnv?: string;
  envs: Record<string, EnvLocal>;
}

interface FileShape {
  version: 1;
  collections: Record<string, CollectionLocal>;
}

const DEFAULT_TLS: TlsSettings = { skipVerify: false, caFile: '' };

export class LocalStore {
  private data: FileShape = { version: 1, collections: {} };

  constructor(private path: string, private cipher: Cipher) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed?.version === 1 && parsed.collections) this.data = parsed;
      } catch {
        // A damaged file is replaced on the next save rather than blocking the app; secrets are re-entered.
      }
    }
  }

  // Keys are collection folders; Windows paths compare case-insensitively.
  private key(collectionDir: string): string {
    return process.platform === 'win32' ? collectionDir.toLowerCase() : collectionDir;
  }

  private col(collectionDir: string): CollectionLocal {
    const k = this.key(collectionDir);
    this.data.collections[k] ??= { envs: {} };
    return this.data.collections[k];
  }

  private env(collectionDir: string, env: string): EnvLocal {
    const c = this.col(collectionDir);
    c.envs[env] ??= { overrides: {}, secrets: {}, tls: { ...DEFAULT_TLS } };
    return c.envs[env];
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  activeEnv(collectionDir: string): string | undefined {
    return this.col(collectionDir).activeEnv;
  }

  setActiveEnv(collectionDir: string, env: string | undefined): void {
    this.col(collectionDir).activeEnv = env;
    this.save();
  }

  overrides(collectionDir: string, env: string): Record<string, string> {
    return { ...this.env(collectionDir, env).overrides };
  }

  setOverride(collectionDir: string, env: string, name: string, value: string | undefined): void {
    const e = this.env(collectionDir, env);
    if (value === undefined) delete e.overrides[name];
    else e.overrides[name] = value;
    this.save();
  }

  /** Decrypted secret values. Only the main process ever holds these. */
  secrets(collectionDir: string, env: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env(collectionDir, env).secrets)) {
      try {
        out[k] = this.cipher.decrypt(v);
      } catch {
        // Undecryptable (e.g. copied from another Windows account): treat as missing.
      }
    }
    return out;
  }

  secretNames(collectionDir: string, env: string): string[] {
    return Object.keys(this.env(collectionDir, env).secrets);
  }

  setSecret(collectionDir: string, env: string, name: string, value: string | undefined): void {
    const e = this.env(collectionDir, env);
    if (value === undefined || value === '') delete e.secrets[name];
    else e.secrets[name] = this.cipher.encrypt(value);
    this.save();
  }

  /** Applies several secret changes with one write (used after a run extracts tokens). */
  setSecrets(collectionDir: string, env: string, changes: Record<string, string | undefined>): void {
    const e = this.env(collectionDir, env);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined || value === '') delete e.secrets[name];
      else e.secrets[name] = this.cipher.encrypt(value);
    }
    this.save();
  }

  /** Every decrypted secret value stored for these collections (for the pre-commit leak check). */
  allSecretValues(collectionDirs: string[]): string[] {
    const out: string[] = [];
    for (const dir of collectionDirs) {
      const c = this.data.collections[this.key(dir)];
      for (const env of Object.keys(c?.envs ?? {})) out.push(...Object.values(this.secrets(dir, env)));
    }
    return out;
  }

  tls(collectionDir: string, env: string): TlsSettings {
    return { ...DEFAULT_TLS, ...this.env(collectionDir, env).tls };
  }

  setTls(collectionDir: string, env: string, tls: TlsSettings): void {
    this.env(collectionDir, env).tls = { ...tls };
    this.save();
  }

  renameEnv(collectionDir: string, from: string, to: string): void {
    const c = this.col(collectionDir);
    if (c.envs[from]) {
      c.envs[to] = c.envs[from];
      delete c.envs[from];
    }
    if (c.activeEnv === from) c.activeEnv = to;
    this.save();
  }

  deleteEnv(collectionDir: string, env: string): void {
    const c = this.col(collectionDir);
    delete c.envs[env];
    if (c.activeEnv === env) c.activeEnv = undefined;
    this.save();
  }
}
