import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IdentityStore } from '../engine/identity/identity-store';
import { Workspace } from '../engine/workspace/workspace';
import type { TreeNode } from '../shared/model';
import type { EnvService } from './env-service';
import { ImportService } from './import-service';

const FIX = resolve(__dirname, '../../../../fixtures/import');
let dir: string;
let ws: Workspace;
let identity: IdentityStore;
let stored: { collectionId: string; values: { name: string; value: string; environment: string | null }[] }[];
let saveTo: string | null;
let service: ImportService;

const flat = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const requests = (id: string | null): string[] => flat(ws.snapshot().collections.filter((c) => c.id === id)).filter((n) => n.kind === 'request').map((n) => n.name).sort();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yept-import-service-'));
  mkdirSync(join(dir, 'ws'));
  identity = new IdentityStore(join(dir, 'id.db'));
  ws = new Workspace(join(dir, 'ws'), identity, { trash: async () => {} });
  await ws.load();
  stored = [];
  saveTo = null;
  const env = { storeImportedSecrets: (collectionId: string, values: (typeof stored)[number]['values']) => stored.push({ collectionId, values }) } as unknown as EnvService;
  service = new ImportService(() => ws, env, {
    openDialog: async () => ({ canceled: true, filePaths: [] }),
    saveDialog: async () => (saveTo ? { canceled: false, filePath: saveTo } : { canceled: true })
  });
});
afterEach(() => {
  identity.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ImportService', () => {
  it.each([
    ['postman-sample.postman_collection.json', 'postman', 'Sample Postman Travel', ['Create booking', 'List bookings', 'Login']],
    ['insomnia-sample.json', 'insomnia', undefined, ['List bookings', 'Login']],
    ['openapi-sample.yaml', 'openapi', undefined, undefined]
  ])('previews and imports %s', async (file, format, name, names) => {
    const preview = await service.fromFile(join(FIX, file));
    expect(preview.format).toBe(format);
    if (name) expect(preview.collectionName).toBe(name);
    expect(preview.counts.requests).toBeGreaterThan(0);
    expect(preview.targetExists).toBe(false);
    expect(preview.parentDir).toBe(join(dir, 'ws'));
    const r = await service.apply(preview.planId, preview.collectionName, preview.findings.map((f) => f.id), 'copy');
    expect(r.collectionId).toBeTruthy();
    expect(r.snapshot.problems).toEqual([]);
    expect(requests(r.collectionId).length).toBe(preview.counts.requests);
    if (names) expect(requests(r.collectionId)).toEqual(names);
  });

  it('imports a .bru collection folder from outside the workspace without touching it', async () => {
    const source = join(dir, 'bruno');
    cpSync(join(FIX, 'bruno-sample'), source, { recursive: true });
    const before = readdirSync(source, { recursive: true }).sort();
    const preview = await service.fromFolder(source);
    expect(preview).toMatchObject({ format: 'bru', source: 'bruno', collectionName: 'Sample Bruno Travel', counts: { requests: 3, folders: 2, environments: 1 }, targetExists: false });
    expect(preview.issues[0]).toMatch(/converted to OpenCollection YAML/);
    expect(preview.findings.map((f) => f.variable)).toEqual(['clientSecret']);
    const r = await service.apply(preview.planId, preview.collectionName, preview.findings.map((f) => f.id), 'copy');
    expect(requests(r.collectionId)).toEqual(['Create booking', 'List bookings', 'Login']);
    expect(existsSync(join(dir, 'ws', 'Sample Bruno Travel', 'opencollection.yml'))).toBe(true);
    expect(readFileSync(join(dir, 'ws', 'Sample Bruno Travel', 'environments', 'local.yml'), 'utf8')).not.toContain('sample-client-secret');
    expect(stored).toEqual([{ collectionId: r.collectionId, values: [{ name: 'clientSecret', value: 'sample-client-secret', environment: 'local' }] }]);
    expect(readdirSync(source, { recursive: true }).sort()).toEqual(before);
  });

  it('refuses folders that are not .bru collections', async () => {
    await expect(service.fromFolder(join(dir, 'ws'))).rejects.toThrow(/no bruno\.json/);
    mkdirSync(join(dir, 'yml'));
    writeFileSync(join(dir, 'yml', 'opencollection.yml'), 'opencollection: 1.0.0\ninfo:\n  name: Y\n');
    await expect(service.fromFolder(join(dir, 'yml'))).rejects.toThrow(/already a YAML collection/);
  });

  it('applies each conflict policy when the target folder exists', async () => {
    const file = join(FIX, 'postman-sample.postman_collection.json');
    const first = await service.fromFile(file);
    const target = join(dir, 'ws', first.collectionName);
    await service.apply(first.planId, first.collectionName, [], 'copy');
    const login = readdirSync(target, { recursive: true }).map(String).find((f) => f.endsWith('Login.yml'))!;
    writeFileSync(join(target, login), 'edited');

    const skip = await service.fromFile(file);
    expect(skip.targetExists).toBe(true);
    expect(skip.existingFiles).toBeGreaterThan(0);
    const skipped = await service.apply(skip.planId, skip.collectionName, [], 'skip');
    expect(skipped.dir).toBe(target);
    expect(skipped.skipped).toBe(skip.existingFiles);
    expect(readFileSync(join(target, login), 'utf8')).toBe('edited');

    const replace = await service.fromFile(file);
    const replaced = await service.apply(replace.planId, replace.collectionName, [], 'replace');
    expect(replaced.dir).toBe(target);
    expect(replaced.skipped).toBe(0);
    expect(readFileSync(join(target, login), 'utf8')).not.toBe('edited');

    const copy = await service.fromFile(file);
    const copied = await service.apply(copy.planId, copy.collectionName, [], 'copy');
    expect(copied.dir).toBe(`${target} (2)`);
    expect(ws.snapshot().collections.length).toBe(2);
  });

  it('rechecks the target for a new name, and forgets a discarded preview', async () => {
    const file = join(FIX, 'insomnia-sample.json');
    const first = await service.fromFile(file);
    await service.apply(first.planId, first.collectionName, [], 'copy');
    const second = await service.fromFile(file);
    expect(service.check(second.planId, first.collectionName).targetExists).toBe(true);
    expect(service.check(second.planId, 'Another name')).toEqual({ targetExists: false, existingFiles: 0 });
    service.discard(second.planId);
    await expect(service.apply(second.planId, 'Another name', [], 'copy')).rejects.toThrow(/expired/);
    expect(existsSync(join(dir, 'ws', 'Another name'))).toBe(false);
  });

  it('exports a collection that imports back the same, without secret values', async () => {
    const preview = await service.fromFolder(join(FIX, 'bruno-sample'));
    const r = await service.apply(preview.planId, preview.collectionName, preview.findings.map((f) => f.id), 'copy');
    const secrets = stored.flatMap((s) => s.values.map((v) => v.value));
    expect(secrets.length).toBeGreaterThan(0);
    expect(await service.export(r.collectionId!, true)).toBeNull(); // save dialog cancelled
    saveTo = join(dir, 'export.yml');
    expect(await service.export(r.collectionId!, true)).toBe(saveTo);
    const text = readFileSync(saveTo, 'utf8');
    for (const value of secrets) expect(text).not.toContain(value);
    const again = await service.fromFile(saveTo);
    expect(again.format).toBe('opencollection');
    expect(again.counts).toEqual(preview.counts);
    const back = await service.apply(again.planId, 'Round trip', [], 'copy');
    expect(requests(back.collectionId)).toEqual(requests(r.collectionId));

    saveTo = join(dir, 'no-env.yml');
    await service.export(r.collectionId!, false);
    expect((await service.fromFile(saveTo)).counts.environments).toBe(0);
  });
});
