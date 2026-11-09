import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '@yept/core/engine/env/local-store';
import { CookieStore } from '@yept/core/engine/cookies/cookie-store';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import { EnvService } from './env-service';
import { CookieService } from './cookie-service';
import { SettingsService } from './settings-service';
import type { AppHost } from './host';
import type { AuthConfig, SettingsDoc } from '@yept/core/shared/model';

let dir: string, identity: IdentityStore, workspace: Workspace, collectionId: string;
let host: Pick<AppHost, 'userDataPath' | 'cipher'>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yept-host-services-'));
  const collection = join(dir, 'collection');
  cpSync(join(__dirname, '../../../../fixtures/collections/sample-travel'), collection, { recursive: true });
  identity = new IdentityStore(join(dir, 'identity.db'));
  workspace = new Workspace(collection, identity, { trash: async () => {} });
  collectionId = (await workspace.load()).collections[0].id;
  host = {
    userDataPath: () => dir,
    cipher: {
      encrypt: vi.fn((plain: string) => Buffer.from(`synthetic:${plain}`).toString('base64')),
      decrypt: vi.fn((encrypted: string) => Buffer.from(encrypted, 'base64').toString().slice('synthetic:'.length))
    }
  };
});
afterEach(() => { identity.close(); rmSync(dir, { recursive: true, force: true }); });

it('reads existing local secrets through the supplied cipher and keeps the existing filename', () => {
  const file = join(dir, 'local-environments.json');
  const previous = new LocalStore(file, host.cipher);
  previous.setActiveEnv(workspace.collectionDir(collectionId), 'local');
  previous.setSecret(workspace.collectionDir(collectionId), 'local', 'clientSecret', 'synthetic-secret');
  const env = new EnvService(() => workspace, host);
  expect(env.revealSecret(collectionId, 'local', 'clientSecret')).toBe('synthetic-secret');
  expect(env.active(collectionId)).toBe('local');
  expect(host.cipher.decrypt).toHaveBeenCalled();
  expect(readFileSync(file, 'utf8')).not.toContain('synthetic-secret');
});

it('reads persistent cookies from the existing encrypted format using the same host cipher', () => {
  const previous = new CookieStore(join(dir, 'cookies.json'), host.cipher);
  previous.forRun(workspace.collectionDir(collectionId), '').store('https://api.example.test/', ['sid=synthetic-cookie; Max-Age=3600; Secure']);
  const env = new EnvService(() => workspace, host);
  const cookies = new CookieService(() => workspace, env, new SettingsService(host), host);
  expect(cookies.view(collectionId).cookies).toMatchObject([{ name: 'sid', value: 'synthetic-cookie' }]);
  expect(host.cipher.decrypt).toHaveBeenCalled();
  expect(readFileSync(join(dir, 'cookies.json'), 'utf8')).not.toContain('synthetic-cookie');
});

it('previews the auth a request will use, inheriting from the nearest folder, then the collection', async () => {
  const env = new EnvService(() => workspace, host);
  const id = [...workspace.liveRequestIds()].find((r) => workspace.getRequest(r).doc.name === 'List bookings')!;
  const ctx = await workspace.requestContext(id);
  const doc = workspace.getRequest(id).doc;
  const bearer = (token: string): AuthConfig => ({ ...doc.auth, mode: 'bearer', bearer: { token } });
  const inherit: AuthConfig = { ...doc.auth, mode: 'inherit' };
  const folder = (name: string, auth: AuthConfig): SettingsDoc => ({ ...ctx.collection, name, auth });
  const preview = (folders: SettingsDoc[], collectionAuth: AuthConfig, auth = inherit) =>
    env.requestPreview({ ...ctx, folders, collection: { ...ctx.collection, auth: collectionAuth } }, { ...doc, auth });
  const fromCollection = `collection "${ctx.collectionName}"`;

  expect(await preview([folder('Outer', bearer('outer'))], bearer('collection'), bearer('own'))).toMatchObject({ auth: { bearer: { token: 'own' } }, authFrom: 'request' });
  expect(await preview([folder('Outer', bearer('outer')), folder('Inner', bearer('inner'))], bearer('collection'))).toMatchObject({ auth: { bearer: { token: 'inner' } }, authFrom: 'folder "Inner"' });
  expect(await preview([folder('Outer', bearer('outer')), folder('Inner', inherit)], bearer('collection'))).toMatchObject({ auth: { bearer: { token: 'outer' } }, authFrom: 'folder "Outer"' });
  expect(await preview([folder('Inner', inherit)], bearer('collection'))).toMatchObject({ auth: { bearer: { token: 'collection' } }, authFrom: fromCollection });
  expect(await preview([], inherit)).toMatchObject({ auth: { mode: 'none' }, authFrom: fromCollection, environment: null });
});
