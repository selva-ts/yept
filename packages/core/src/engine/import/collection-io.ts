// Import (Postman, Insomnia, OpenAPI, bundled OpenCollection), .bru -> YAML conversion, and bundled export.
// Everything goes through one in-memory Bruno collection model, then a reviewable plan of YAML files, then a write.
// Nothing is executed on import: scripts are only converted, never run.
import { promises as fs, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { postmanToBruno, insomniaToBruno, openApiToBruno, openCollectionToBruno, brunoToOpenCollection } from '@usebruno/converters';
import { stringifyRequest, stringifyFolder, stringifyEnvironment } from '@usebruno/filestore';
import { utils as brunoUtils } from '@usebruno/common';
import { stringifyCollectionFile } from '../workspace/bruno-adapter';
import { atomicWrite } from '../fs/atomic-write';
import { looksLikeSecret, type SecretField } from '../../shared/secrets';
import { fileNameOf, isAbsolutePath } from '../../shared/multipart';

export type ImportFormat = 'postman' | 'insomnia' | 'openapi' | 'opencollection';

/** Bruno's in-memory collection model (what the converters produce and consume). Opaque outside this module. */
export interface CollectionModel {
  name: string;
  items: any[];
  environments: any[];
  root?: any;
  brunoConfig?: any;
}

export interface ImportSource {
  format: ImportFormat;
  model: CollectionModel;
  /** Converter warnings and Yept's own notes (removed duplicates, skipped request types). */
  issues: string[];
}

export interface SecretFinding {
  id: string;
  /** Request or environment name, for display. */
  where: string;
  field:
    | 'bearer token' | 'basic password' | 'api key' | 'client secret' | 'digest password' | 'ntlm password' | 'aws secret access key' | 'aws session token'
    | 'authorization header' | 'environment value';
  /** Suggested {{variable}} name. */
  variable: string;
  /** Masked preview of the value. */
  preview: string;
}

export interface PlannedFile {
  /** Relative to the target collection folder, forward slashes. */
  path: string;
  kind: 'collection' | 'folder' | 'request' | 'environment';
  name: string;
  content: string;
  exists: boolean;
}

export interface ImportPlan {
  collectionName: string;
  targetDir: string;
  targetExists: boolean;
  files: PlannedFile[];
  counts: { folders: number; requests: number; environments: number };
  skipped: string[];
}

export type ConflictPolicy = 'copy' | 'skip' | 'replace';

const sanitize = (name: string): string => {
  const s = (brunoUtils?.sanitizeName ? brunoUtils.sanitizeName(name) : name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')).trim();
  return s.replace(/[. ]+$/, '') || 'untitled';
};
const maskValue = (v: string): string => (v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`);

// ---------- 1. detect and convert ----------

function parseText(text: string, fileName: string): any {
  const t = text.replace(/^﻿/, '');
  if (/\.(ya?ml)$/i.test(fileName) || !/^\s*[[{]/.test(t)) return yaml.load(t);
  return JSON.parse(t);
}

export function detectFormat(data: any): ImportFormat | null {
  if (!data || typeof data !== 'object') return null;
  if (data.opencollection) return 'opencollection';
  if (data.openapi || data.swagger) return 'openapi';
  if (String(data.info?.schema ?? '').includes('getpostman.com') || (data.info?._postman_id && Array.isArray(data.item))) return 'postman';
  if (data._type === 'export' || data.__export_format || String(data.type ?? '').startsWith('collection.insomnia.rest')) return 'insomnia';
  return null;
}

/** Removes requests that are identical in everything but their random id (Bruno's Insomnia converter duplicates folder items). */
function dedupe(items: any[]): number {
  let removed = 0;
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'folder') {
      removed += dedupe(it.items ?? []);
      continue;
    }
    const sig = JSON.stringify(it, (k, v) => (k === 'uid' || k === 'seq' ? undefined : v));
    if (seen.has(sig)) {
      items.splice(i--, 1);
      removed++;
    } else seen.add(sig);
  }
  return removed;
}

export async function convertSource(text: string, fileName: string): Promise<ImportSource> {
  let data: any;
  try {
    data = parseText(text, fileName);
  } catch (e) {
    throw new Error(`Can't read ${fileName}: ${(e as Error).message.split('\n')[0]}`);
  }
  const format = detectFormat(data);
  if (!format) throw new Error(`${fileName} isn't a Postman collection (v2.1), an Insomnia export, an OpenAPI 3 document or an OpenCollection file.`);
  const issues: string[] = [];
  let model: CollectionModel;
  if (format === 'postman') {
    const r = await postmanToBruno(data);
    model = r.collection ?? r;
    for (const i of r.issues ?? []) issues.push(typeof i === 'string' ? i : (i.message ?? JSON.stringify(i)));
  } else if (format === 'insomnia') model = await insomniaToBruno(data);
  else if (format === 'openapi') model = await openApiToBruno(data);
  else model = openCollectionToBruno(data);
  model.items ??= [];
  model.environments ??= [];
  if (format === 'insomnia') restoreInsomniaFileFields(model.items, insomniaFileParams(data));
  if (format === 'insomnia') restoreInsomniaAuth(model.items, insomniaAuth(data));
  issues.push(...fixUploadPaths(model.items));
  const removed = dedupe(model.items);
  if (removed) issues.push(`Removed ${removed} duplicate request${removed > 1 ? 's' : ''} created by the converter (identical copies of the same request).`);
  return { format, model, issues };
}

// ---------- multipart file fields ----------

const eachRequest = (items: any[], fn: (it: any) => void): void => {
  for (const it of items) {
    if (it.type === 'folder') eachRequest(it.items ?? [], fn);
    else fn(it);
  }
};

/** Insomnia multipart file params by request name: param name -> the file path Insomnia stored. */
function insomniaFileParams(data: any): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const b = node.body;
    if (typeof node.name === 'string' && b?.mimeType === 'multipart/form-data' && Array.isArray(b.params)) {
      for (const p of b.params) {
        if (p?.type !== 'file') continue;
        if (!out.has(node.name)) out.set(node.name, new Map());
        out.get(node.name)!.set(String(p.name ?? ''), String(p.fileName ?? ''));
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(data);
  return out;
}

/** Bruno's Insomnia converter imports file params as empty text fields; turn them back into file fields. */
function restoreInsomniaFileFields(items: any[], files: Map<string, Map<string, string>>): void {
  eachRequest(items, (it) => {
    const byName = files.get(String(it.name));
    if (!byName) return;
    for (const f of it.request?.body?.multipartForm ?? []) {
      if (f.type !== 'text' || (f.value ?? '') !== '' || !byName.has(String(f.name))) continue;
      const path = byName.get(String(f.name))!;
      f.type = 'file';
      f.value = path ? [path] : [];
    }
  });
}

// ---------- Insomnia auth the converter leaves out ----------

/** Insomnia's {{ _.name }} is Bruno's {{name}}. */
const insomniaVars = (v: unknown): string => String(v ?? '').replace(/\{\{\s*_\.([^{}\s]+)\s*\}\}/g, '{{$1}}');

/** Digest, NTLM and AWS (Insomnia calls it "iam") auth by request name, in Bruno's shape. */
function insomniaAuth(data: any): Map<string, { mode: string; value: Record<string, string> }> {
  const out = new Map<string, { mode: string; value: Record<string, string> }>();
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const a = node.authentication;
    if (typeof node.name === 'string' && a && !a.disabled) {
      if (a.type === 'digest') out.set(node.name, { mode: 'digest', value: { username: insomniaVars(a.username), password: insomniaVars(a.password) } });
      if (a.type === 'ntlm') out.set(node.name, { mode: 'ntlm', value: { username: insomniaVars(a.username), password: insomniaVars(a.password), domain: insomniaVars(a.domain) } });
      if (a.type === 'iam') {
        out.set(node.name, {
          mode: 'awsv4',
          value: { accessKeyId: insomniaVars(a.accessKeyId), secretAccessKey: insomniaVars(a.secretAccessKey), sessionToken: insomniaVars(a.sessionToken), service: insomniaVars(a.service), region: insomniaVars(a.region), profileName: '' }
        });
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(data);
  return out;
}

/** Bruno's Insomnia converter imports only basic and bearer auth; the others arrive as no auth. */
function restoreInsomniaAuth(items: any[], auth: Map<string, { mode: string; value: Record<string, string> }>): void {
  eachRequest(items, (it) => {
    const a = auth.get(String(it.name));
    if (!a || !it.request || !['none', 'inherit', undefined].includes(it.request.auth?.mode)) return;
    it.request.auth = { ...it.request.auth, mode: a.mode, [a.mode]: a.value };
  });
}

/**
 * Upload paths in imported requests point at files on the exporting computer. Absolute paths are left out of the
 * shared files (each user chooses the file again on their computer); relative ones are kept, now relative to the
 * collection folder. Returns notes for the import preview.
 */
export function fixUploadPaths(items: any[]): string[] {
  const notes: string[] = [];
  let kept = 0;
  eachRequest(items, (it) => {
    for (const f of it.request?.body?.multipartForm ?? []) {
      if (f.type !== 'file') continue;
      const paths: string[] = (Array.isArray(f.value) ? f.value : f.value ? [f.value] : []).map(String);
      const absolute = paths.filter((p) => isAbsolutePath(p));
      f.value = paths.filter((p) => !isAbsolutePath(p));
      kept += f.value.length;
      for (const p of absolute) notes.push(`"${it.name}", field "${f.name}": ${fileNameOf(p)} was a path on the computer it was exported from, so it isn't saved in the shared file. Choose the file again in the Body tab.`);
    }
  });
  if (kept) notes.push(`${kept} upload file path${kept > 1 ? 's are' : ' is'} kept relative to the collection folder. Put the file${kept > 1 ? 's' : ''} there, or choose them again in the Body tab.`);
  return notes;
}

// ---------- 2. secrets found in the source ----------

const SECRETISH_NAME = /pass(word)?|secret|token|api[-_]?key|private|credential/i;

/** Credential fields in auth settings, in the order findings are numbered. */
const AUTH_SECRETS: { mode: string; key: string; kind: SecretField; field: SecretFinding['field']; variable: string }[] = [
  { mode: 'bearer', key: 'token', kind: 'token', field: 'bearer token', variable: 'accessToken' },
  { mode: 'basic', key: 'password', kind: 'password', field: 'basic password', variable: 'password' },
  { mode: 'apikey', key: 'value', kind: 'apikey', field: 'api key', variable: 'apiKey' },
  { mode: 'oauth2', key: 'clientSecret', kind: 'password', field: 'client secret', variable: 'clientSecret' },
  { mode: 'digest', key: 'password', kind: 'password', field: 'digest password', variable: 'digestPassword' },
  { mode: 'ntlm', key: 'password', kind: 'password', field: 'ntlm password', variable: 'ntlmPassword' },
  { mode: 'awsv4', key: 'secretAccessKey', kind: 'password', field: 'aws secret access key', variable: 'awsSecretAccessKey' },
  { mode: 'awsv4', key: 'sessionToken', kind: 'token', field: 'aws session token', variable: 'awsSessionToken' }
];
/** The literal credential in this auth field, or undefined when it holds none (or a {{variable}}). */
const authSecret = (a: any, s: (typeof AUTH_SECRETS)[number]): string | undefined => {
  const v = String(a?.[s.mode]?.[s.key] ?? '');
  return a?.mode === s.mode && looksLikeSecret(v, s.kind) ? v : undefined;
};

/** Literal credentials in the imported data. Each can be replaced with a {{variable}} declared secret (value not written). */
export function findSecrets(model: CollectionModel): SecretFinding[] {
  const out: SecretFinding[] = [];
  let n = 0;
  const visit = (items: any[]): void => {
    for (const it of items) {
      if (it.type === 'folder') {
        visit(it.items ?? []);
        continue;
      }
      const a = it.request?.auth;
      const name = String(it.name);
      for (const s of AUTH_SECRETS) {
        const v = authSecret(a, s);
        if (v !== undefined) out.push({ id: `s${n++}`, where: name, field: s.field, variable: s.variable, preview: maskValue(v) });
      }
      for (const h of it.request?.headers ?? []) {
        if (String(h.name).toLowerCase() === 'authorization' && looksLikeSecret(String(h.value ?? ''), 'header')) out.push({ id: `s${n++}`, where: name, field: 'authorization header', variable: 'accessToken', preview: maskValue(String(h.value)) });
      }
    }
  };
  visit(model.items);
  for (const env of model.environments) {
    for (const v of env.variables ?? []) {
      if (!v.secret && v.value && SECRETISH_NAME.test(String(v.name))) out.push({ id: `s${n++}`, where: `environment "${env.name}"`, field: 'environment value', variable: String(v.name), preview: maskValue(String(v.value)) });
    }
  }
  return out;
}

/**
 * Applies the chosen secret fixes to the model: literals become {{variable}} references, variables are declared secret
 * in every environment (no value), and the original values are returned so the caller can store them as local secrets.
 */
export function applySecretFixes(model: CollectionModel, fixIds: Set<string>): { name: string; value: string; environment: string | null }[] {
  const values: { name: string; value: string; environment: string | null }[] = [];
  const declared = new Set<string>();
  let n = 0;
  const visit = (items: any[]): void => {
    for (const it of items) {
      if (it.type === 'folder') {
        visit(it.items ?? []);
        continue;
      }
      const a = it.request?.auth;
      const take = (variable: string, value: string): string => {
        declared.add(variable);
        values.push({ name: variable, value, environment: null });
        return `{{${variable}}}`;
      };
      for (const s of AUTH_SECRETS) {
        const v = authSecret(a, s);
        if (v !== undefined && fixIds.has(`s${n++}`)) a[s.mode][s.key] = take(s.variable, v);
      }
      for (const h of it.request?.headers ?? []) {
        if (String(h.name).toLowerCase() === 'authorization' && looksLikeSecret(String(h.value ?? ''), 'header') && fixIds.has(`s${n++}`)) {
          const m = /^(bearer|basic)\s+(.*)$/i.exec(String(h.value));
          h.value = m ? `${m[1]} ${take('accessToken', m[2])}` : take('accessToken', String(h.value));
        }
      }
    }
  };
  visit(model.items);
  for (const env of model.environments) {
    for (const v of env.variables ?? []) {
      if (!v.secret && v.value && SECRETISH_NAME.test(String(v.name)) && fixIds.has(`s${n++}`)) {
        values.push({ name: String(v.name), value: String(v.value), environment: String(env.name) });
        v.secret = true;
        v.value = '';
      }
    }
  }
  if (declared.size) {
    if (!model.environments.length) model.environments.push({ name: 'local', variables: [] });
    for (const env of model.environments) {
      env.variables ??= [];
      for (const name of declared) if (!env.variables.some((v: any) => v.name === name)) env.variables.push({ name, value: '', enabled: true, secret: true, type: 'text' });
    }
  }
  return values;
}

// ---------- 3. plan ----------

export function buildPlan(model: CollectionModel, parentDir: string, collectionName = model.name): ImportPlan {
  const targetDir = join(parentDir, sanitize(collectionName || 'Imported collection'));
  const files: PlannedFile[] = [];
  const skipped: string[] = [];
  const counts = { folders: 0, requests: 0, environments: 0 };
  const add = (path: string, kind: PlannedFile['kind'], name: string, content: string): void => {
    files.push({ path, kind, name, content, exists: existsSync(join(targetDir, path)) });
  };
  const unique = (taken: Set<string>, base: string, ext: string): string => {
    let candidate = `${base}${ext}`;
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base} (${i})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  };

  const config = { ...(model.brunoConfig ?? {}), name: collectionName, opencollection: '1.0.0', ignore: model.brunoConfig?.ignore ?? ['node_modules', '.git'] };
  delete config.proxy;
  add('opencollection.yml', 'collection', collectionName, stringifyCollectionFile({ name: collectionName, root: model.root ?? null, config, hadProxy: false }));

  const walk = (items: any[], rel: string): void => {
    const taken = new Set<string>(['folder.yml']);
    items.forEach((it, i) => {
      if (it.type === 'folder') {
        const dir = unique(taken, sanitize(String(it.name)), '');
        const folderRel = rel ? `${rel}/${dir}` : dir;
        const root = { ...(it.root ?? {}), meta: { ...(it.root?.meta ?? {}), name: String(it.name), seq: Number(it.seq ?? i + 1) } };
        root.request ??= { auth: { mode: 'inherit' } };
        add(`${folderRel}/folder.yml`, 'folder', String(it.name), stringifyFolder(root, { format: 'yml' }));
        counts.folders++;
        walk(it.items ?? [], folderRel);
        return;
      }
      if (it.type !== 'http-request') {
        skipped.push(`${it.name} (${String(it.type).replace('-request', '')}: only HTTP requests are supported)`);
        return;
      }
      const file = unique(taken, sanitize(String(it.name)), '.yml');
      add(rel ? `${rel}/${file}` : file, 'request', String(it.name), stringifyRequest({ ...it, seq: Number(it.seq ?? i + 1) }, { format: 'yml' }));
      counts.requests++;
    });
  };
  walk(model.items, '');

  const envTaken = new Set<string>();
  for (const env of model.environments) {
    const file = unique(envTaken, sanitize(String(env.name)), '.yml');
    const variables = (env.variables ?? []).map((v: any) => ({ name: String(v.name), value: v.secret ? '' : String(v.value ?? ''), enabled: v.enabled !== false, secret: !!v.secret, type: 'text' }));
    add(`environments/${file}`, 'environment', String(env.name), stringifyEnvironment({ name: String(env.name), variables }, { format: 'yml' }));
    counts.environments++;
  }
  return { collectionName, targetDir, targetExists: existsSync(targetDir), files, counts, skipped };
}

// ---------- 4. write ----------

/**
 * Writes the plan. When the target folder exists: 'copy' imports into a new folder ("Name (2)"), 'skip' keeps
 * existing files and writes only new ones, 'replace' overwrites files with the same path. Never deletes anything.
 */
export async function writePlan(plan: ImportPlan, policy: ConflictPolicy): Promise<{ dir: string; written: number; skipped: number }> {
  let dir = plan.targetDir;
  if (plan.targetExists && policy === 'copy') {
    for (let i = 2; existsSync(dir); i++) dir = `${plan.targetDir} (${i})`;
  }
  let written = 0;
  let skipped = 0;
  for (const f of plan.files) {
    const target = join(dir, ...f.path.split('/'));
    if (existsSync(target) && policy === 'skip') {
      skipped++;
      continue;
    }
    await fs.mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, f.content);
    written++;
  }
  return { dir, written, skipped };
}

// ---------- 5. export ----------

/** A single-file, bundled OpenCollection YAML of the collection. Secret values are never part of the model. */
export function exportBundled(model: CollectionModel, includeEnvironments: boolean): string {
  const oc = brunoToOpenCollection({ ...model, environments: includeEnvironments ? model.environments : [] });
  oc.bundled = true;
  if (!includeEnvironments && oc.config) delete oc.config.environments;
  return yaml.dump(oc, { lineWidth: -1, noRefs: true });
}
