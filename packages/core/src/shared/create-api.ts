import type { YeptApi, HostEvents } from './ipc';

/** Sends one operation to the host and resolves its result. Arguments go to the transport exactly as the caller gave them. */
export type Invoke = (channel: string, ...args: unknown[]) => Promise<any>;
/** Listens for one host event; returns the function that stops listening. */
export type Subscribe = <K extends keyof HostEvents>(channel: K, cb: (event: HostEvents[K]) => void) => () => void;

/** The UI's API over any transport: each method names one host channel. */
export function createApi(invoke: Invoke, subscribe: Subscribe): YeptApi {
  return {
    versions: () => invoke('app:versions'),
    notices: () => invoke('app:notices'),
    selfTest: () => invoke('app:self-test'),
    workspace: {
      pick: () => invoke('workspace:pick'),
      restore: () => invoke('workspace:restore'),
      createCollection: (name) => invoke('workspace:create-collection', name),
      deleteCollection: (id) => invoke('workspace:delete-collection', id),
      getViewMode: () => invoke('workspace:get-view-mode'),
      setViewMode: (mode) => invoke('workspace:set-view-mode', mode),
      onExternalChange: (cb) => subscribe('workspace:external-change', cb)
    },
    requests: {
      get: (id) => invoke('requests:get', id),
      save: (id, doc) => invoke('requests:save', id, doc),
      create: (parentId, name) => invoke('requests:create', parentId, name),
      createFromCurl: (parentId, name, command) => invoke('requests:create-from-curl', parentId, name, command),
      createFolder: (parentId, name) => invoke('requests:create-folder', parentId, name),
      rename: (id, name) => invoke('requests:rename', id, name),
      move: (id, target) => invoke('requests:move', id, target),
      duplicate: (id) => invoke('requests:duplicate', id),
      remove: (id) => invoke('requests:remove', id),
      pickFiles: (id) => invoke('requests:pick-files', id)
    },
    settings: {
      get: (id) => invoke('settings:get', id),
      save: (id, doc) => invoke('settings:save', id, doc)
    },
    env: {
      list: (c) => invoke('env:list', c),
      setActive: (c, n) => invoke('env:set-active', c, n),
      save: (c, p, e) => invoke('env:save', c, p, e),
      remove: (c, n) => invoke('env:remove', c, n),
      setOverride: (c, e, n, v) => invoke('env:set-override', c, e, n, v),
      setSecret: (c, e, n, v) => invoke('env:set-secret', c, e, n, v),
      revealSecret: (c, e, n) => invoke('env:reveal-secret', c, e, n),
      setTls: (c, e, t) => invoke('env:set-tls', c, e, t),
      storeAsSecret: (c, e, n, v) => invoke('env:store-as-secret', c, e, n, v),
      clearRuntime: (c, e) => invoke('env:clear-runtime', c, e),
      preview: (id, doc) => invoke('env:preview', id, doc),
      pickCaFile: () => invoke('env:pick-ca-file')
    },
    history: {
      list: (requestId) => invoke('history:list', requestId),
      get: (runId) => invoke('history:get', runId),
      remove: (runId) => invoke('history:remove', runId),
      clear: (requestId) => invoke('history:clear', requestId),
      orphans: () => invoke('history:orphans'),
      reattach: (from, to) => invoke('history:reattach', from, to),
      export: (runIds, includeBodies, name) => invoke('history:export', runIds, includeBodies, name)
    },
    git: {
      status: () => invoke('git:status'),
      diff: (root, file) => invoke('git:diff', root, file),
      commit: (root, files, message, override) => invoke('git:commit', root, files, message, override),
      push: (root, setUpstream) => invoke('git:push', root, setUpstream),
      fetch: (root) => invoke('git:fetch', root),
      pull: (root) => invoke('git:pull', root),
      sync: (root) => invoke('git:sync', root),
      switchBranch: (root, branch) => invoke('git:switch', root, branch),
      createBranch: (root, branch) => invoke('git:create-branch', root, branch),
      stage: (root, files) => invoke('git:stage', root, files),
      unstage: (root, files) => invoke('git:unstage', root, files),
      discard: (root, files) => invoke('git:discard', root, files)
    },
    importer: {
      pick: () => invoke('import:pick'),
      fromBru: (collectionId) => invoke('import:from-bru', collectionId),
      check: (planId, name) => invoke('import:check', planId, name),
      apply: (planId, name, fixIds, policy) => invoke('import:apply', planId, name, fixIds, policy),
      export: (collectionId, includeEnvironments) => invoke('import:export', collectionId, includeEnvironments)
    },
    appSettings: {
      get: () => invoke('app-settings:get'),
      set: (s) => invoke('app-settings:set', s),
      setAppearance: (change) => invoke('app-settings:set-appearance', change)
    },
    runs: {
      start: (runId, requestId, doc) => invoke('runs:start', runId, requestId, doc),
      cancel: (runId) => invoke('runs:cancel', runId),
      saveBody: (runId, name) => invoke('runs:save-body', runId, name),
      curlWithSecrets: (runId, language) => invoke('runs:curl-with-secrets', runId, language),
      rawWithSecrets: (runId) => invoke('runs:raw-with-secrets', runId),
      cookieValue: (runId, index) => invoke('runs:cookie-value', runId, index)
    },
    runner: {
      start: (runnerId, nodeId, options) => invoke('runner:start', runnerId, nodeId, options),
      cancel: (runnerId) => invoke('runner:cancel', runnerId),
      onEvent: (cb) => subscribe('runner:event', cb),
      pickDataFile: () => invoke('runner:pick-data-file'),
      exportReport: (runnerId, format) => invoke('runner:export-report', runnerId, format)
    },
    oauth2: {
      token: (requestId, doc, action) => invoke('oauth2:token', requestId, doc, action)
    },
    cookies: {
      list: (c) => invoke('cookies:list', c),
      upsert: (c, cookie, previous) => invoke('cookies:upsert', c, cookie, previous),
      remove: (c, cookie) => invoke('cookies:remove', c, cookie),
      clear: (c, domain) => invoke('cookies:clear', c, domain)
    },
    metrics: () => invoke('app:metrics'),
    clipboard: {
      write: (text) => invoke('clipboard:write', text)
    }
  };
}
