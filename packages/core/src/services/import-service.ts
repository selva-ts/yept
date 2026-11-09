// Import, .bru -> YAML conversion and export, shared by the desktop app and the VS Code extension. Plans stay in the
// host process; the UI only sees summaries, never file contents or secret values.
import type { AppHost } from './host';
import { promises as fs, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applySecretFixes, buildPlan, convertSource, exportBundled, findSecrets, fixUploadPaths, writePlan, type CollectionModel, type ConflictPolicy } from '../engine/import/collection-io';
import { canonical } from '../engine/git/git';
import { IdentityStore } from '../engine/identity/identity-store';
import { Workspace } from '../engine/workspace/workspace';
import type { EnvService } from './env-service';
import type { ImportApplyResult, ImportPreview } from '../shared/ipc';

interface Pending {
  /** Untouched model, re-parsed for every apply so fixes never stack. */
  modelJson: string;
  parentDir: string;
  preview: ImportPreview;
}

const BRU_NOTE = 'Bruno .bru files are converted to OpenCollection YAML in a new folder. The original folder is not changed; delete it yourself once the copy works.';

export class ImportService {
  private pending = new Map<string, Pending>();

  constructor(private ws: () => Workspace, private env: EnvService, private host: Pick<AppHost, 'openDialog' | 'saveDialog'>) {}

  /** Where new collections go: the workspace folder, unless that folder is itself a collection. */
  private parentDir(): string {
    const root = this.ws().root;
    return existsSync(join(root, 'opencollection.yml')) || existsSync(join(root, 'bruno.json')) ? dirname(root) : root;
  }

  private store(model: CollectionModel, parentDir: string, base: Omit<ImportPreview, 'planId' | 'findings' | 'counts' | 'skipped' | 'targetExists' | 'existingFiles'>): ImportPreview {
    const planId = randomUUID();
    const plan = buildPlan(structuredClone(model), parentDir, base.collectionName);
    const preview: ImportPreview = {
      ...base,
      planId,
      findings: findSecrets(model),
      counts: plan.counts,
      skipped: plan.skipped,
      targetExists: plan.targetExists,
      existingFiles: plan.files.filter((f) => f.exists).length
    };
    this.pending.set(planId, { modelJson: JSON.stringify(model), parentDir, preview });
    return preview;
  }

  async pick(): Promise<ImportPreview | null> {
    const opts = {
      title: 'Import a collection',
      properties: ['openFile' as const],
      filters: [
        { name: 'Postman, Insomnia, OpenAPI, OpenCollection', extensions: ['json', 'yaml', 'yml'] },
        { name: 'All files', extensions: ['*'] }
      ]
    };
    const r = await this.host.openDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    return this.fromFile(r.filePaths[0]);
  }

  async fromFile(file: string): Promise<ImportPreview> {
    const src = await convertSource(await fs.readFile(file, 'utf8'), basename(file));
    return this.store(src.model, this.parentDir(), {
      source: basename(file),
      format: src.format,
      collectionName: src.model.name || basename(file).replace(/\.[^.]+$/, ''),
      parentDir: this.parentDir(),
      issues: src.issues
    });
  }

  /** Converting a read-only .bru collection: a YAML copy next to it; the original is left alone. */
  fromBru(collectionId: string): ImportPreview {
    const m = this.ws().collectionModel(collectionId);
    if (m.format !== 'bru') throw new Error('This collection is already YAML');
    const parent = dirname(m.dir);
    const uploadNotes = fixUploadPaths(m.items);
    return this.store({ name: m.name, items: m.items, environments: m.environments, root: m.root, brunoConfig: { ...m.brunoConfig, name: `${m.name} (YAML)` } }, parent, {
      source: basename(m.dir),
      format: 'bru',
      collectionName: `${m.name} (YAML)`,
      parentDir: parent,
      issues: [BRU_NOTE, ...uploadNotes]
    });
  }

  /**
   * A Bruno .bru collection folder anywhere on disk (it need not be open): read once, then converted into the workspace
   * folder like a file import. The folder itself is never written to.
   */
  async fromFolder(dir: string): Promise<ImportPreview> {
    if (existsSync(join(dir, 'opencollection.yml'))) throw new Error('This folder is already a YAML collection. Open it instead of importing it.');
    if (!existsSync(join(dir, 'bruno.json'))) throw new Error('This folder has no bruno.json, so it is not a Bruno collection.');
    // A throwaway identity index: ids made here are never used after the preview.
    const identity = new IdentityStore(':memory:');
    try {
      const source = new Workspace(dir, identity, { trash: async () => { throw new Error('Importing never deletes files'); } });
      const snapshot = await source.load();
      const found = snapshot.collections.find((c) => resolve(dir, c.path) === resolve(dir));
      if (!found) throw new Error('No collection was found in this folder.');
      const m = source.collectionModel(found.id);
      const uploadNotes = fixUploadPaths(m.items);
      const problems = snapshot.problems.map((p) => `Could not read ${p.path || basename(dir)}: ${p.message}`);
      return this.store({ name: m.name, items: m.items, environments: m.environments, root: m.root, brunoConfig: { ...m.brunoConfig } }, this.parentDir(), {
        source: basename(dir),
        format: 'bru',
        collectionName: m.name,
        parentDir: this.parentDir(),
        issues: [BRU_NOTE, ...problems, ...uploadNotes]
      });
    } finally {
      identity.close();
    }
  }

  /** Recomputes whether the target exists for a new name (the user can rename before importing). */
  check(planId: string, name: string): { targetExists: boolean; existingFiles: number } {
    const p = this.mustPending(planId);
    const plan = buildPlan(JSON.parse(p.modelJson), p.parentDir, name);
    return { targetExists: plan.targetExists, existingFiles: plan.files.filter((f) => f.exists).length };
  }

  /** Forgets a preview the user cancelled. Nothing was written for it. */
  discard(planId: string): void {
    this.pending.delete(planId);
  }

  async apply(planId: string, name: string, fixIds: string[], policy: ConflictPolicy): Promise<ImportApplyResult> {
    const p = this.mustPending(planId);
    const model: CollectionModel = JSON.parse(p.modelJson);
    model.name = name;
    if (model.brunoConfig) model.brunoConfig.name = name;
    const values = applySecretFixes(model, new Set(fixIds));
    const plan = buildPlan(model, p.parentDir, name);
    const out = await writePlan(plan, policy);
    const snapshot = await this.ws().load();
    const created = snapshot.collections.find((c) => canonical(join(this.ws().root, c.path)).toLowerCase() === canonical(out.dir).toLowerCase());
    if (created && values.length) this.env.storeImportedSecrets(created.id, values);
    this.pending.delete(planId);
    return {
      snapshot,
      collectionId: created?.id ?? null,
      dir: out.dir,
      written: out.written,
      skipped: out.skipped,
      secretsStored: created ? values.length : 0,
      note: created ? undefined : `Imported into ${out.dir}, which is outside the open folder. Open that folder to see it.`
    };
  }

  async export(collectionId: string, includeEnvironments: boolean): Promise<string | null> {
    const m = this.ws().collectionModel(collectionId);
    const text = exportBundled({ name: m.name, items: m.items, environments: m.environments, root: m.root, brunoConfig: m.brunoConfig }, includeEnvironments);
    const opts = { title: 'Export collection', defaultPath: `${m.name}.yml`, filters: [{ name: 'OpenCollection YAML', extensions: ['yml', 'yaml'] }] };
    const r = await this.host.saveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, text, 'utf8');
    return r.filePath;
  }

  private mustPending(planId: string): Pending {
    const p = this.pending.get(planId);
    if (!p) throw new Error('This import has expired. Start it again.');
    return p;
  }
}
