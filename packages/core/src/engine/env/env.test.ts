import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore, type Cipher } from './local-store';
import { emptyEnvLayer, resolveLayers } from './variables';
import { parseCollectionFile, parseEnvironmentFile, stringifyCollectionFile, stringifyEnvironmentFile, applySettingsDoc, toSettingsDoc } from '../workspace/bruno-adapter';

// Test cipher: reversible but not plain text, so the test can prove plain secrets never hit the file.
const cipher: Cipher = {
  encrypt: (s) => Buffer.from(s, 'utf8').toString('base64').split('').reverse().join(''),
  decrypt: (s) => Buffer.from(s.split('').reverse().join(''), 'base64').toString('utf8')
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yept-env-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('LocalStore', () => {
  it('keeps overrides, encrypted secrets, active env and TLS per collection and environment', () => {
    const path = join(dir, 'local.json');
    const s = new LocalStore(path, cipher);
    s.setActiveEnv('C:\\Repo\\Api', 'dev');
    s.setOverride('C:\\Repo\\Api', 'dev', 'baseUrl', 'http://localhost:5000');
    s.setSecret('C:\\Repo\\Api', 'dev', 'password', 'hunter2-very-secret');
    s.setTls('C:\\Repo\\Api', 'dev', { skipVerify: true, caFile: '' });

    const again = new LocalStore(path, cipher);
    expect(again.activeEnv('C:\\Repo\\Api')).toBe('dev');
    expect(again.overrides('C:\\Repo\\Api', 'dev')).toEqual({ baseUrl: 'http://localhost:5000' });
    expect(again.secrets('C:\\Repo\\Api', 'dev')).toEqual({ password: 'hunter2-very-secret' });
    expect(again.tls('C:\\Repo\\Api', 'dev').skipVerify).toBe(true);
    expect(again.secrets('C:\\Repo\\Api', 'prod')).toEqual({});
    expect(readFileSync(path, 'utf8')).not.toContain('hunter2-very-secret');
  });

  it('renames and deletes environments, and clears secrets with undefined', () => {
    const s = new LocalStore(join(dir, 'local.json'), cipher);
    s.setSecrets('/c', 'dev', { token: 'abc12345', other: 'x' });
    s.setActiveEnv('/c', 'dev');
    s.renameEnv('/c', 'dev', 'development');
    expect(s.secrets('/c', 'development')).toEqual({ token: 'abc12345', other: 'x' });
    expect(s.activeEnv('/c')).toBe('development');
    s.setSecrets('/c', 'development', { token: undefined });
    expect(s.secretNames('/c', 'development')).toEqual(['other']);
    s.deleteEnv('/c', 'development');
    expect(s.activeEnv('/c')).toBeUndefined();
    expect(s.secrets('/c', 'development')).toEqual({});
  });
});

describe('resolveLayers', () => {
  it('follows Bruno precedence: collection < environment < folder < request < runtime', () => {
    const kv = (name: string, value: string) => ({ name, value, enabled: true });
    const env = { ...emptyEnvLayer(), file: { a: 'env', b: 'env', c: 'env', d: 'env', e: 'env', f: 'env-file' }, overrides: { f: 'override' }, secrets: { s: 'secret' } };
    const r = resolveLayers({
      collection: [kv('a', 'collection'), kv('z', 'collection')],
      environment: env,
      folders: [[kv('b', 'outer'), kv('c', 'outer')], [kv('c', 'inner')]],
      request: [kv('d', 'request'), { name: 'off', value: 'x', enabled: false }],
      runtime: { e: 'runtime' }
    });
    expect(r.values).toMatchObject({ z: 'collection', a: 'env', b: 'outer', c: 'inner', d: 'request', e: 'runtime', f: 'override', s: 'secret' });
    expect(r.values.off).toBeUndefined();
    expect(r.sources).toMatchObject({ z: 'collection', a: 'environment', c: 'folder', d: 'request', e: 'runtime', f: 'override', s: 'secret' });
  });
});

describe('collection and environment files', () => {
  const OC = 'opencollection: 1.0.0\n\ninfo:\n  name: Sample Travel\nbundled: false\nextensions:\n  bruno:\n    ignore:\n      - node_modules\n      - .git\n';

  it('re-saving opencollection.yml does not add the injected default proxy block', () => {
    const f = parseCollectionFile(OC, 'yml');
    expect(stringifyCollectionFile(f)).toBe(OC);
  });

  it('saves collection auth, headers and variables', () => {
    const f = parseCollectionFile(OC, 'yml');
    const doc = toSettingsDoc('Sample Travel', f.root, 'none');
    doc.auth = { ...doc.auth, mode: 'bearer', bearer: { token: '{{accessToken}}' } };
    doc.headers = [{ name: 'X-Client', value: 'yept', enabled: true }];
    doc.vars = [{ name: 'apiVersion', value: 'v2', enabled: true }];
    const out = stringifyCollectionFile({ ...f, root: applySettingsDoc(f.root, doc) });
    expect(out).toContain('type: bearer');
    expect(out).toContain('token: "{{accessToken}}"');
    expect(out).not.toContain('proxy');
    const back = toSettingsDoc('x', parseCollectionFile(out, 'yml').root, 'none');
    expect(back.auth.bearer.token).toBe('{{accessToken}}');
    expect(back.vars).toEqual(doc.vars);
  });

  it('never writes secret values into an environment file', () => {
    const text = stringifyEnvironmentFile({ name: 'dev', variables: [{ name: 'baseUrl', value: 'http://x', secret: false, enabled: true }, { name: 'password', value: 'should-not-appear', secret: true, enabled: true }] });
    expect(text).not.toContain('should-not-appear');
    const env = parseEnvironmentFile(text, 'yml', 'fallback');
    expect(env).toEqual({ name: 'dev', variables: [{ name: 'baseUrl', value: 'http://x', secret: false, enabled: true }, { name: 'password', value: '', secret: true, enabled: true }] });
  });
});
