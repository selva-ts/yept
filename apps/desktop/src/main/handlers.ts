import { promises as fs } from 'node:fs';
import { HandlerRegistry } from '@yept/core/shared/handler-registry';
import type { AppHost } from '@yept/core/services/host';
import { splitPickedFiles } from '@yept/core/engine/runner/multipart';
import { WorkspaceService } from '@yept/core/services/workspace-service';
import { RunService } from '@yept/core/services/run-service';
import { CollectionRunService } from '@yept/core/services/collection-run-service';
import { cleanRunnerOptions } from '@yept/core/shared/collection-run';
import { parseCurl, requestFromCurl } from '@yept/core/shared/curl';
import { EnvService } from '@yept/core/services/env-service';
import { SettingsService } from '@yept/core/services/settings-service';
import { GitService } from './git-service';
import { ImportService } from '@yept/core/services/import-service';
import { CookieService } from '@yept/core/services/cookie-service';
import { mediaBytes } from '@yept/core/services/media-bytes';
import type { AppMetrics, MutationResult } from '@yept/core/shared/ipc';
import { APPEARANCE_KEYS, type Appearance, type AppSettings, type CookieView, type Environment, type GitFile, type RequestDoc, type SettingsDoc, type TlsSettings } from '@yept/core/shared/model';

export function createHandlers(host: AppHost): { handlers: HandlerRegistry; close: () => Promise<void>; settings: () => AppSettings } {
  const handlers = new HandlerRegistry();
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void => handlers.register(channel, fn);
  const workspaces = new WorkspaceService(host, (change) => host.emit('workspace:external-change', change));
  const ws = () => workspaces.workspace;
  const env = new EnvService(ws, host);
  const appSettings = new SettingsService(host);
  const cookies = new CookieService(ws, env, appSettings, host);
  const runs = new RunService(env, appSettings, cookies, host);
  const runner = new CollectionRunService(ws, runs, (e) => host.emit('runner:event', e), host);
  const gitService = new GitService(ws, env, (path) => host.trash(path), () => workspaces.refreshAfterGit(), (fn) => workspaces.duringGit(fn));
  const importer = new ImportService(ws, env, host);
  const mutate = async (fn: () => Promise<string | void>): Promise<MutationResult> => {
    const id = await fn();
    return { snapshot: ws().snapshot(), id: id ?? undefined };
  };

  handle('app:versions', () => host.versions());
  handle('app:notices', () => host.notices());
  handle('app:self-test', () => host.selfTest());

  handle('workspace:pick', async () => {
    const r = await host.openDialog({ title: 'Open a folder with Bruno collections', properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : workspaces.open(r.filePaths[0]);
  });
  handle('workspace:restore', () => workspaces.restore());
  handle('workspace:create-collection', (name: string) => mutate(() => ws().createCollection(name)));
  handle('workspace:delete-collection', (id: string) => mutate(() => ws().deleteCollection(id)));
  handle('workspace:get-view-mode', () => workspaces.getViewMode());
  handle('workspace:set-view-mode', (mode: 'grid' | 'list') => workspaces.setViewMode(mode));

  handle('requests:get', (id: string) => ({ id, collectionId: ws().collectionIdOf(id), ...ws().getRequest(id) }));
  handle('requests:save', (id: string, doc: RequestDoc) => mutate(async () => { await ws().saveRequest(id, doc); return id; }));
  handle('requests:create', (parentId: string, name: string) => mutate(() => ws().createRequest(parentId, name)));
  handle('requests:create-from-curl', (parentId: string, name: string, command: string) => {
    const parsed = parseCurl(command);
    return mutate(() => ws().createRequest(parentId, name, (doc) => requestFromCurl(doc, parsed)));
  });
  handle('requests:create-folder', (parentId: string, name: string) => mutate(() => ws().createFolder(parentId, name)));
  handle('requests:rename', (id: string, name: string) => mutate(() => ws().rename(id, name)));
  handle('requests:move', (id: string, target: string) => mutate(() => ws().move(id, target)));
  handle('requests:duplicate', (id: string) => mutate(() => ws().duplicate(id)));
  handle('requests:remove', (id: string) => mutate(() => ws().delete(id)));
  handle('requests:pick-files', async (id: string) => {
    const { collectionDir } = await ws().requestContext(id);
    const opts = { title: 'Choose files to upload', defaultPath: collectionDir, properties: ['openFile' as const, 'multiSelections' as const] };
    const r = await host.openDialog(opts);
    return r.canceled || !r.filePaths.length ? null : splitPickedFiles(collectionDir, r.filePaths);
  });

  handle('settings:get', (id: string) => ({ id, collectionId: ws().collectionIdOf(id), ...ws().getSettings(id) }));
  handle('settings:save', (id: string, doc: SettingsDoc) => mutate(async () => { await ws().saveSettings(id, doc); return id; }));

  handle('env:list', (collectionId: string) => env.list(collectionId));
  handle('env:set-active', (collectionId: string, name: string | null) => env.setActive(collectionId, name));
  handle('env:save', (collectionId: string, previous: string | null, e: Environment) => env.save(collectionId, previous, e));
  handle('env:remove', (collectionId: string, name: string) => env.remove(collectionId, name));
  handle('env:set-override', (c: string, e: string, n: string, v: string | null) => env.setOverride(c, e, n, v));
  handle('env:set-secret', (c: string, e: string, n: string, v: string | null) => env.setSecret(c, e, n, v));
  handle('env:reveal-secret', (c: string, e: string, n: string) => env.revealSecret(c, e, n));
  handle('env:set-tls', (c: string, e: string, tls: TlsSettings) => env.setTls(c, e, tls));
  handle('env:store-as-secret', (c: string, e: string, n: string, v: string) => env.storeAsSecret(c, e, n, v));
  handle('env:set-runtime', (c: string, e: string, n: string, v: string) => env.setRuntime(c, e, n, v));
  handle('env:clear-runtime', (c: string, e: string) => env.clearRuntime(c, e));
  handle('env:preview', async (requestId: string, doc: RequestDoc) => env.requestPreview(await ws().requestContext(requestId), doc));
  handle('env:pick-ca-file', async () => {
    const opts = { title: 'Choose a CA certificate (PEM)', properties: ['openFile' as const], filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }] };
    const r = await host.openDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle('runs:start', async (runId: string, requestId: string, doc: RequestDoc) => {
    const { path } = ws().getRequest(requestId);
    return runs.start(runId, { requestId, requestName: doc.name, requestPath: path, ctx: await ws().requestContext(requestId) }, doc);
  });
  handle('runs:cookie-value', (runId: string, index: number) => runs.cookieValue(runId, index));
  handle('runner:start', (runnerId: string, nodeId: string, options: unknown) => runner.start(runnerId, nodeId, cleanRunnerOptions(options)));
  handle('runner:cancel', (runnerId: string) => runner.cancel(runnerId));
  handle('runner:pick-data-file', () => runner.pickDataFile());
  handle('runner:export-report', (runnerId: string, format: unknown) => runner.exportReport(runnerId, format === 'html' ? 'html' : 'junit'));
  handle('oauth2:token', async (requestId: string, doc: RequestDoc, action: 'status' | 'fetch' | 'forget') => runs.oauth2Token(await ws().requestContext(requestId), doc, action));

  handle('history:list', (requestId: string) => runs.history.list(requestId));
  handle('history:get', (runId: string) => {
    const e = runs.history.get(runId);
    if (!e) throw new Error('This history entry no longer exists');
    return e;
  });
  handle('history:remove', (runId: string) => runs.history.deleteRun(runId));
  handle('history:clear', (requestId: string) => runs.history.deleteRequestHistory(requestId));
  handle('history:orphans', () => runs.history.orphans(ws().collectionDirs(), ws().liveRequestIds()));
  handle('history:reattach', (from: string, to: string) => runs.history.reattach(from, to));
  handle('history:export', async (runIds: string[], includeBodies: boolean, suggestedName: string) => {
    const opts = { title: 'Export history', defaultPath: suggestedName, filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = await host.saveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, JSON.stringify(runs.history.export(runIds, includeBodies), null, 2));
    return r.filePath;
  });

  handle('git:status', () => gitService.status());
  handle('git:diff', (root: string, file: GitFile) => gitService.diff(root, file));
  handle('git:commit', (root: string, files: GitFile[], message: string, override?: string) => gitService.commit(root, files, message, override));
  handle('git:push', (root: string, setUpstream: boolean) => gitService.push(root, setUpstream));
  handle('git:fetch', (root: string) => gitService.action(root, 'fetch'));
  handle('git:pull', (root: string) => gitService.action(root, 'pull'));
  handle('git:sync', (root: string) => gitService.action(root, 'sync'));
  handle('git:switch', (root: string, branch: string) => gitService.action(root, 'switch', branch));
  handle('git:create-branch', (root: string, branch: string) => gitService.action(root, 'create', branch));
  handle('git:stage', (root: string, files: GitFile[]) => gitService.files(root, 'stage', files));
  handle('git:unstage', (root: string, files: GitFile[]) => gitService.files(root, 'unstage', files));
  handle('git:discard', (root: string, files: GitFile[]) => gitService.files(root, 'discard', files));

  handle('import:pick', () => importer.pick());
  handle('import:from-bru', (collectionId: string) => importer.fromBru(collectionId));
  handle('import:check', (planId: string, name: string) => importer.check(planId, name));
  handle('import:apply', (planId: string, name: string, fixIds: string[], policy: 'copy' | 'skip' | 'replace') => importer.apply(planId, name, fixIds, policy));
  handle('import:export', (collectionId: string, includeEnvironments: boolean) => importer.export(collectionId, includeEnvironments));

  const settingsView = () => ({ settings: appSettings.get(), historyRuns: runs.history.stats().runs, historyBytes: runs.history.stats().bytes });
  handle('app-settings:get', () => settingsView());
  const applyAppearance = (s: AppSettings): void => host.applyAppearance(s);
  handle('app-settings:set', (s: AppSettings) => {
    applyAppearance(appSettings.set(s));
    runs.history.prune();
    return settingsView();
  });
  // Applies at once, without Save. Only appearance keys are taken from the change.
  handle('app-settings:set-appearance', (change: Partial<Appearance>) => {
    const next = { ...appSettings.get() } as Record<string, unknown>;
    for (const k of APPEARANCE_KEYS) if (change && k in change) next[k] = change[k];
    applyAppearance(appSettings.set(next as unknown as AppSettings));
    return settingsView();
  });
  handle('runs:cancel', (runId: string) => runs.cancel(runId));
  handle('runs:save-body', async (runId: string, suggestedName: string) => {
    const body = runs.body(runId);
    if (!body) throw new Error('This response is no longer available to save. Send the request again.');
    const opts = { title: 'Save response body', defaultPath: suggestedName };
    const r = await host.saveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, body);
    return r.filePath;
  });
  handle('runs:body-bytes', (runId: string) => mediaBytes(runs.body(runId)));

  handle('runs:curl-with-secrets', (runId: string, language?: unknown) => runs.curlWithSecrets(runId, language ?? 'curl'));
  handle('runs:raw-with-secrets', (runId: string) => runs.rawWithSecrets(runId));

  type CookieKey = Pick<CookieView, 'domain' | 'path' | 'name'>;
  handle('cookies:list', (collectionId: string) => cookies.view(collectionId));
  handle('cookies:upsert', (collectionId: string, cookie: CookieView, previous?: CookieKey) => cookies.upsert(collectionId, cookie, previous));
  handle('cookies:remove', (collectionId: string, cookie: CookieKey) => cookies.remove(collectionId, cookie));
  handle('cookies:clear', (collectionId: string, domain?: string) => cookies.clear(collectionId, domain));

  handle('app:metrics', (): AppMetrics => ({
    processes: host.metrics(),
    uptimeSeconds: Math.round(process.uptime()),
    historyBytes: runs.history.stats().bytes,
    mainHeapBytes: process.memoryUsage().heapUsed
  }));

  handle('clipboard:write', (text: string) => host.writeClipboard(text));

  return { handlers, close: () => runs.close(), settings: () => appSettings.get() };
}
