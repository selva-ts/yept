import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HandlerRegistry } from '@yept/core/shared/handler-registry';
import type { AppSettings, RunResult } from '@yept/core/shared/model';
import type { AppHost } from '@yept/core/services/host';
import { EnvService } from '@yept/core/services/env-service';
import { SettingsService } from '@yept/core/services/settings-service';
import { CookieService } from '@yept/core/services/cookie-service';
import { RunService } from '@yept/core/services/run-service';
import { CollectionRunService } from '@yept/core/services/collection-run-service';
import { cleanRunnerOptions } from '@yept/core/shared/collection-run';
import { ImportService } from '@yept/core/services/import-service';
import type { DevToolsRunEvent } from '@yept/core/shared/ipc';
import { CookieStore } from '@yept/core/engine/cookies/cookie-store';
import { LocalStore } from '@yept/core/engine/env/local-store';
import { HistoryStore } from '@yept/core/engine/history/store';
import { cookieKey, cookieView, environment, nullableText, requestDoc, text, tlsSettings } from './validation';
import { devToolsResult, previewResult } from './body-document';
import { mediaBytes } from '@yept/core/services/media-bytes';
import type { Workspace } from '@yept/core/engine/workspace/workspace';

/** The settings VS Code owns (`yept.*`), read at each use so a change applies without a reload. */
export type Configuration = () => Partial<Pick<AppSettings, 'historyRunsPerRequest' | 'historyCapMb' | 'historyBodyLimitMb' | 'cookies'>>;

/** The stored settings with the VS Code settings on top, checked like the desktop's. Never written back. */
class ExtensionSettings extends SettingsService {
  constructor(host: Pick<AppHost, 'userDataPath'>, private readonly configuration: Configuration) {
    super(host);
  }
  override get(): AppSettings {
    return SettingsService.clean({ ...super.get(), ...this.configuration() });
  }
}

/**
 * The local files every workspace folder's services use: settings, environment selections and secrets, cookie jars
 * and the history database, each opened once. Stores open on first use, so activation reads nothing.
 */
export function createLocalStores(host: AppHost, configuration: Configuration = () => ({})) {
  const settings = new ExtensionSettings(host, configuration);
  let local: LocalStore | undefined;
  let cookies: CookieStore | undefined;
  let history: HistoryStore | undefined;
  return {
    settings,
    get local() { return local ??= new LocalStore(join(host.userDataPath(), 'local-environments.json'), host.cipher); },
    get cookies() { return cookies ??= new CookieStore(join(host.userDataPath(), 'cookies.json'), host.cipher); },
    get history() { return history ??= new HistoryStore(join(host.userDataPath(), 'history.db'), () => settings.get()); },
    close: () => history?.close()
  };
}

export type LocalStores = ReturnType<typeof createLocalStores>;

/** A response body the page was shown, which the extension may open in an editor. */
export interface ShownBody {
  runId: string;
  contentType: string;
  requestName: string;
}

/**
 * Calls back to the extension: onSave after the panel writes collection files, onEnvChange after environments or their
 * local values change, scriptsBlocked, checked at each run, while scripts may not run (an untrusted folder),
 * onHistoryChange after a run or a cleared history, openBody to show a whole response body in an editor, and onRun at the
 * start and end of each request a panel sends, for Dev Tools.
 */
export interface ServiceHooks {
  onSave?: () => void;
  onEnvChange?: () => void;
  scriptsBlocked?: () => string | undefined;
  onHistoryChange?: () => void;
  openBody?: (body: ShownBody) => Promise<void>;
  onRun?: (event: DevToolsRunEvent) => void;
}

// How many bodies the page has been shown that "Open in editor" can still find (the bodies themselves stay in the run
// service and the history database).
const SHOWN_BODIES = 200;

/**
 * The services behind the request panel for one workspace folder, and the operations its webview may call. Arguments
 * are checked first. The stores are shared and stay open when these services close.
 */
export function createRequestServices(host: AppHost, workspace: Workspace, stores: LocalStores, hooks: ServiceHooks = {}) {
  const ws = () => workspace;
  const env = new EnvService(ws, host, stores.local);
  const settings = stores.settings;
  const cookies = new CookieService(ws, env, settings, host, stores.cookies);
  const runs = new RunService(env, settings, cookies, host, stores.history, { scriptsBlocked: hooks.scriptsBlocked });
  // Runner progress goes to every page; results are cut to what Dev Tools shows.
  const runner = new CollectionRunService(ws, runs, (e) => host.emit('runner:event', e.type === 'step-end' && e.result ? { ...e, result: devToolsResult(e.result) } : e), host);
  // Import and export run from the extension's commands, not from a page.
  const importer = new ImportService(ws, env, host);
  const handlers = new HandlerRegistry();
  const active = new Set<string>();

  const request = (id: unknown): string => {
    text(id);
    ws().getRequest(id);
    return id;
  };
  const collection = (id: unknown): string => {
    text(id);
    ws().collectionDir(id);
    return id;
  };
  const history = (id: unknown) => {
    text(id);
    const entry = runs.history.get(id);
    if (!entry || !ws().liveRequestIds().has(entry.summary.requestId)) throw new Error('History entry not found');
    return entry;
  };
  // count: the number of arguments, or the fewest and most when trailing ones are optional (left out when undefined).
  const handle = (channel: string, count: number | [number, number], fn: (...args: any[]) => unknown): void => handlers.register(channel, (...args: unknown[]) => {
    const [min, max] = typeof count === 'number' ? [count, count] : count;
    if (args.length < min || args.length > max) throw new Error('Invalid argument count');
    return fn(...args);
  });

  // Results go to the page with large bodies cut to a preview; the run ids of text bodies are kept for "Open in editor".
  const shownBodies = new Map<string, ShownBody>();
  // Every run the page was shown, text or binary, for "Save to file" and the image and PDF preview.
  const shownRuns = new Set<string>();
  const shown = <T extends RunResult>(runId: string, result: T, requestName: string): T => {
    shownRuns.delete(runId);
    shownRuns.add(runId);
    while (shownRuns.size > SHOWN_BODIES) shownRuns.delete(shownRuns.keys().next().value!);
    if (!result.body.binary) {
      shownBodies.delete(runId);
      shownBodies.set(runId, { runId, contentType: result.body.contentType, requestName });
      while (shownBodies.size > SHOWN_BODIES) shownBodies.delete(shownBodies.keys().next().value!);
    }
    return previewResult(result);
  };

  const changed = <T>(result: T): T => {
    hooks.onEnvChange?.();
    return result;
  };

  handle('app:versions', 0, () => host.versions());
  handle('clipboard:write', 1, (value) => {
    text(value);
    return host.writeClipboard(value);
  });

  handle('requests:get', 1, (id) => ({ id: request(id), collectionId: ws().collectionIdOf(id), ...ws().getRequest(id) }));
  handle('requests:save', 2, async (id, doc) => {
    request(id);
    requestDoc(doc);
    await ws().saveRequest(id, doc);
    hooks.onSave?.();
    return { snapshot: ws().snapshot(), id };
  });

  handle('env:list', 1, (id) => env.list(collection(id)));
  handle('env:set-active', 2, (id, name) => {
    collection(id);
    if (name !== null) {
      text(name);
      if (!ws().getEnvironment(id, name)) throw new Error('Environment not found');
    }
    return changed(env.setActive(id, name));
  });
  handle('env:preview', 2, async (id, doc) => {
    request(id);
    requestDoc(doc);
    return env.requestPreview(await ws().requestContext(id), doc);
  });
  // An environment named by the panel must exist in that collection; local values are never kept for unknown ones.
  const existing = (id: unknown, name: unknown): string => {
    const collectionId = collection(id);
    text(name);
    if (!ws().getEnvironment(collectionId, name)) throw new Error('Environment not found');
    return name;
  };
  handle('env:save', 3, async (id, previous, doc) => {
    const collectionId = collection(id);
    nullableText(previous);
    if (previous !== null) existing(collectionId, previous);
    environment(doc);
    const list = await env.save(collectionId, previous, doc);
    hooks.onSave?.();
    return changed(list);
  });
  handle('env:remove', 2, async (id, name) => {
    const list = await env.remove(id, existing(id, name));
    hooks.onSave?.();
    return changed(list);
  });
  handle('env:set-override', 4, (id, name, variable, value) => {
    text(variable);
    nullableText(value);
    return changed(env.setOverride(id, existing(id, name), variable, value));
  });
  handle('env:set-secret', 4, (id, name, variable, value) => {
    text(variable);
    nullableText(value);
    return changed(env.setSecret(id, existing(id, name), variable, value));
  });
  handle('env:reveal-secret', 3, (id, name, variable) => {
    text(variable);
    return env.revealSecret(id, existing(id, name), variable);
  });
  handle('env:set-tls', 3, (id, name, tls) => {
    tlsSettings(tls);
    return changed(env.setTls(id, existing(id, name), tls));
  });
  handle('env:store-as-secret', 4, async (id, name, variable, value) => {
    text(variable);
    text(value);
    const list = await env.storeAsSecret(id, existing(id, name), variable, value);
    hooks.onSave?.();
    return changed(list);
  });
  handle('env:set-runtime', 4, (id, name, variable, value) => {
    text(variable);
    text(value);
    env.setRuntime(id, existing(id, name), variable, value);
    hooks.onEnvChange?.();
  });
  handle('env:clear-runtime', 2, (id, name) => { env.clearRuntime(id, existing(id, name)); });
  handle('env:pick-ca-file', 0, async () => {
    const result = await host.openDialog({ title: 'Choose a CA certificate (PEM)', properties: ['openFile'], filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle('runs:start', 3, async (runId, id, doc) => {
    text(runId);
    if (!/^[0-9a-f-]{36}$/i.test(runId) || active.has(runId) || runs.history.get(runId)) throw new Error('Invalid or duplicate run id');
    request(id);
    requestDoc(doc);
    active.add(runId);
    const collectionId = ws().collectionIdOf(id);
    // Dev Tools records the send as the desktop's does: the draft's method and URL, in the collection's active environment.
    hooks.onRun?.({ type: 'start', runId, requestId: id, requestName: doc.name, collectionId, environment: env.active(collectionId) ?? '', method: doc.method, url: doc.url });
    try {
      const out = await runs.start(runId, { requestId: id, requestName: doc.name, requestPath: ws().getRequest(id).path, ctx: await ws().requestContext(id) }, doc);
      hooks.onRun?.({ type: 'end', runId, collectionId, result: devToolsResult(out.result) });
      return { ...out, result: shown(runId, out.result, doc.name) };
    } catch (error) {
      hooks.onRun?.({ type: 'end', runId, collectionId, result: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      active.delete(runId);
      hooks.onHistoryChange?.();
    }
  });
  handle('runs:cancel', 1, (id) => {
    text(id);
    if (!active.has(id)) throw new Error('Run not active');
    runs.cancel(id);
  });
  handle('runs:curl-with-secrets', [1, 2], (id, language) => {
    text(id);
    return runs.curlWithSecrets(id, language ?? 'curl');
  });
  handle('runs:raw-with-secrets', 1, (id) => {
    text(id);
    return runs.rawWithSecrets(id);
  });
  handle('runs:cookie-value', 2, (id, index) => {
    history(id);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid cookie index');
    return runs.cookieValue(id, index);
  });
  // Opens the whole body of a run the page has shown in a read-only editor. The body never crosses to the page.
  handle('runs:open-body', 1, async (id) => {
    text(id);
    const body = shownBodies.get(id);
    if (!body || !runs.body(id)) throw new Error('This response body is no longer available. Send the request again.');
    if (!hooks.openBody) throw new Error('Opening a body in an editor is not available here');
    await hooks.openBody(body);
  });
  // A run the page was shown, or a stored run of a request in this folder; its body stays here until saved or previewed.
  const shownBody = (id: unknown): Buffer | undefined => {
    text(id);
    if (!shownRuns.has(id)) history(id);
    return runs.body(id);
  };
  handle('runs:save-body', 2, async (id, suggestedName) => {
    text(suggestedName);
    const body = shownBody(id);
    if (!body) throw new Error('This response is no longer available to save. Send the request again.');
    const result = await host.saveDialog({ title: 'Save response body', defaultPath: basename(suggestedName.replace(/\\/g, '/')) || 'response.bin' });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, body);
    return result.filePath;
  });
  handle('runs:body-bytes', 1, (id) => mediaBytes(shownBody(id)));
  handle('oauth2:token', 3, async (id, doc, action) => {
    request(id);
    requestDoc(doc);
    if (!['status', 'fetch', 'forget', 'cancel'].includes(action)) throw new Error('Invalid token action');
    return runs.oauth2Token(id, await ws().requestContext(id), doc, action);
  });

  // The collection runner: the saved requests under a collection or folder, one at a time, one run at a time.
  handle('runner:start', 3, async (runnerId, nodeId, options) => {
    text(runnerId);
    text(nodeId);
    try {
      return await runner.start(runnerId, nodeId, cleanRunnerOptions(options));
    } finally {
      // Each request is in history, and extracted tokens, script variables and cookies may have changed.
      hooks.onHistoryChange?.();
      hooks.onEnvChange?.();
    }
  });
  handle('runner:cancel', 1, (runnerId) => {
    text(runnerId);
    runner.cancel(runnerId);
  });
  // A data file is read on the extension's side, from a file chosen in VS Code's open dialog; the page gets its summary.
  handle('runner:pick-data-file', 0, () => runner.pickDataFile());
  handle('runner:export-report', 2, (runnerId, format) => {
    text(runnerId);
    if (format !== 'junit' && format !== 'html') throw new Error('Invalid report format');
    return runner.exportReport(runnerId, format);
  });

  handle('cookies:list', 1, (id) => cookies.view(collection(id)));
  handle('cookies:upsert', [2, 3], (id, cookie, previous) => {
    cookieView(cookie);
    if (previous != null) cookieKey(previous);
    return cookies.upsert(collection(id), cookie, previous ?? undefined);
  });
  handle('cookies:remove', 2, (id, cookie) => {
    cookieKey(cookie);
    return cookies.remove(collection(id), cookie);
  });
  handle('cookies:clear', [1, 2], (id, domain) => {
    if (domain != null) text(domain);
    return cookies.clear(collection(id), domain ?? undefined);
  });
  handle('history:list', 1, (id) => runs.history.list(request(id)));
  handle('history:get', 1, (id) => {
    const entry = history(id);
    return { ...entry, result: shown(entry.summary.runId, entry.result, entry.summary.requestName) };
  });
  handle('history:clear', 1, (id) => {
    runs.history.deleteRequestHistory(request(id));
    hooks.onHistoryChange?.();
  });

  return { handlers, runs, importer, close: () => runs.close() };
}
