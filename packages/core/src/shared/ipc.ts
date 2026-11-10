// Typed contract between renderer and main. Keep it narrow: the renderer never touches Node, files or the network.
import type { RunnerEvent, RunnerOptions, RunnerResult } from './collection-run';
import type { Appearance, AppSettings, AuthConfig, CookieView, Environment, OAuth2TokenStatus, EnvironmentView, GitFile, HistoryEntry, HistorySummary, ImportSecretFinding, LeakFinding, OrphanedHistory, RequestDoc, ResolvedVar, RunResult, SettingsDoc, TlsSettings, WorkspaceSnapshot } from './model';

export interface SelfTestResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/** Result of any tree mutation: the new tree plus the id of the item created or changed. */
export interface MutationResult {
  snapshot: WorkspaceSnapshot;
  id?: string;
}

export interface LoadedRequest {
  id: string;
  collectionId: string;
  doc: RequestDoc;
  readOnly: boolean;
  path: string;
}

/** Sent when files change outside the app. The UI reloads clean tabs and asks before touching dirty ones. */
export interface ExternalChange {
  snapshot: WorkspaceSnapshot;
  changedRequestIds: string[];
  removedRequestIds: string[];
}

export interface EnvironmentList {
  collectionId: string;
  readOnly: boolean;
  active: string | null;
  environments: EnvironmentView[];
}

/** Preview of how a request resolves in the active environment. Secret values are masked. */
export interface RequestPreview {
  environment: string | null;
  vars: ResolvedVar[];
  /** The auth that will actually be used, after inheritance. */
  auth: AuthConfig;
  /** Where that auth comes from: 'request', a folder name, or the collection name. */
  authFrom: string;
  skipVerify: boolean;
}

export interface GitRepoStatus {
  root: string;
  /** Collection directories relative to the workspace, for matching unsaved editor drafts. */
  collectionPaths: string[];
  branch: string | null;
  upstream: string | null;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  /** Whole repository, including changes outside the collections. */
  dirty: boolean;
  blockedReason: string | null;
  files: GitFile[];
}

export interface GitCommitResult {
  ok: boolean;
  hash?: string;
  /** Plain-language reason when Git failed. */
  explanation?: string;
  /** Git's own output, shown as-is. */
  output?: string;
  /** Present (and ok false) when the leak check blocked the commit. */
  leaks?: LeakFinding[];
}

export interface GitPushResult {
  ok: boolean;
  needsUpstream?: boolean;
  explanation?: string;
  output?: string;
}

export interface ImportPreview {
  planId: string;
  /** File or folder name it came from. */
  source: string;
  format: 'postman' | 'insomnia' | 'openapi' | 'opencollection' | 'bru';
  collectionName: string;
  /** Where the new collection folder goes. */
  parentDir: string;
  issues: string[];
  counts: { folders: number; requests: number; environments: number };
  skipped: string[];
  findings: ImportSecretFinding[];
  targetExists: boolean;
  existingFiles: number;
}

export interface ImportApplyResult {
  snapshot: WorkspaceSnapshot;
  collectionId: string | null;
  dir: string;
  written: number;
  skipped: number;
  secretsStored: number;
  note?: string;
}

/** The cookie jar of a collection's active environment. */
export interface CookieJarView {
  collectionId: string;
  /** '' when no environment is selected (that has its own jar too). */
  environment: string;
  /** False when automatic cookies are turned off in Settings. */
  enabled: boolean;
  cookies: CookieView[];
}

export interface ProcessMetric {
  pid: number;
  /** Electron's process type: Browser (main), Tab (window), GPU, Utility... */
  type: string;
  name: string;
  /** Percent of one CPU core since the last sample. */
  cpu: number;
  /** Working set, in bytes. */
  memory: number;
}

export interface AppMetrics {
  processes: ProcessMetric[];
  uptimeSeconds: number;
  historyBytes: number;
  /** Heap in use by the main process (scripts run in its worker threads). */
  mainHeapBytes: number;
}

/** The OAuth2 token for a request's effective auth. `applies` is false when that auth isn't OAuth2 client credentials. */
export type OAuth2TokenView = { applies: false } | { applies: true; environment: string; status: OAuth2TokenStatus };

export interface YeptApi {
  versions: () => Promise<Record<string, string>>;
  notices: () => Promise<string>;
  selfTest: () => Promise<SelfTestResult[]>;

  workspace: {
    /** Shows a folder picker. Resolves null if cancelled. */
    pick: () => Promise<WorkspaceSnapshot | null>;
    /** Reopens the last workspace, if any. */
    restore: () => Promise<WorkspaceSnapshot | null>;
    createCollection: (name: string) => Promise<MutationResult>;
    deleteCollection: (id: string) => Promise<MutationResult>;
    getViewMode: () => Promise<'grid' | 'list'>;
    setViewMode: (mode: 'grid' | 'list') => Promise<void>;
    onExternalChange: (cb: (change: ExternalChange) => void) => () => void;
  };

  requests: {
    get: (id: string) => Promise<LoadedRequest>;
    save: (id: string, doc: RequestDoc) => Promise<MutationResult>;
    create: (parentId: string, name: string) => Promise<MutationResult>;
    /** Creates a request from a pasted curl command (parsed again here; files it names are never read). */
    createFromCurl: (parentId: string, name: string, command: string) => Promise<MutationResult>;
    createFolder: (parentId: string, name: string) => Promise<MutationResult>;
    rename: (id: string, name: string) => Promise<MutationResult>;
    move: (id: string, targetParentId: string) => Promise<MutationResult>;
    duplicate: (id: string) => Promise<MutationResult>;
    remove: (id: string) => Promise<MutationResult>;
    /**
     * Shows a file picker for a multipart file field. Files inside the request's collection come back relative to it
     * (saved in the request file); others come back as absolute paths kept on this computer only. Null if cancelled.
     */
    pickFiles: (id: string) => Promise<{ files: string[]; localFiles: string[] } | null>;
  };

  /** Collection and folder defaults (auth, headers, variables, scripts). */
  settings: {
    get: (id: string) => Promise<{ id: string; collectionId: string; doc: SettingsDoc; readOnly: boolean }>;
    save: (id: string, doc: SettingsDoc) => Promise<MutationResult>;
  };

  env: {
    list: (collectionId: string) => Promise<EnvironmentList>;
    setActive: (collectionId: string, name: string | null) => Promise<EnvironmentList>;
    /** Creates (previousName null), updates or renames the shared environment file. */
    save: (collectionId: string, previousName: string | null, env: Environment) => Promise<EnvironmentList>;
    remove: (collectionId: string, name: string) => Promise<EnvironmentList>;
    /** Local-only layers. null removes the value. */
    setOverride: (collectionId: string, env: string, name: string, value: string | null) => Promise<EnvironmentList>;
    setSecret: (collectionId: string, env: string, name: string, value: string | null) => Promise<EnvironmentList>;
    revealSecret: (collectionId: string, env: string, name: string) => Promise<string | null>;
    setTls: (collectionId: string, env: string, tls: TlsSettings) => Promise<EnvironmentList>;
    /** Declares `name` as a secret in the environment file (if needed) and stores `value` locally. */
    storeAsSecret: (collectionId: string, env: string, name: string, value: string) => Promise<EnvironmentList>;
    /** Sets a runtime variable of an environment for this session (not saved anywhere). */
    setRuntime: (collectionId: string, env: string, name: string, value: string) => Promise<void>;
    /** Forgets runtime and session variables (e.g. extracted tokens that aren't secrets) for an environment. */
    clearRuntime: (collectionId: string, env: string) => Promise<void>;
    preview: (requestId: string, doc: RequestDoc) => Promise<RequestPreview>;
    /** Shows a file picker for a PEM CA certificate. */
    pickCaFile: () => Promise<string | null>;
  };

  history: {
    /** Newest first. */
    list: (requestId: string) => Promise<HistorySummary[]>;
    get: (runId: string) => Promise<HistoryEntry>;
    remove: (runId: string) => Promise<void>;
    clear: (requestId: string) => Promise<void>;
    /** History whose request no longer exists in the open workspace. */
    orphans: () => Promise<OrphanedHistory[]>;
    reattach: (fromRequestId: string, toRequestId: string) => Promise<void>;
    /** Shows a save dialog; resolves the saved path or null. */
    export: (runIds: string[], includeBodies: boolean, suggestedName: string) => Promise<string | null>;
  };

  git: {
    status: () => Promise<{ repos: GitRepoStatus[]; collectionsOutsideGit: string[] }>;
    diff: (root: string, file: GitFile) => Promise<{ before: string; after: string }>;
    /** overrideLeaksFor: the first flagged file's name, typed by the user to commit despite findings. */
    commit: (root: string, files: GitFile[], message: string, overrideLeaksFor?: string) => Promise<GitCommitResult>;
    push: (root: string, setUpstream: boolean) => Promise<GitPushResult>;
    fetch: (root: string) => Promise<GitPushResult>;
    pull: (root: string) => Promise<GitPushResult>;
    sync: (root: string) => Promise<GitPushResult>;
    switchBranch: (root: string, branch: string) => Promise<GitPushResult>;
    createBranch: (root: string, branch: string) => Promise<GitPushResult>;
    stage: (root: string, files: GitFile[]) => Promise<GitPushResult>;
    unstage: (root: string, files: GitFile[]) => Promise<GitPushResult>;
    discard: (root: string, files: GitFile[]) => Promise<GitPushResult>;
  };

  importer: {
    /** Shows a file picker and analyses the file. Resolves null if cancelled. */
    pick: () => Promise<ImportPreview | null>;
    /** Converting a .bru collection to YAML (a copy next to it). */
    fromBru: (collectionId: string) => Promise<ImportPreview>;
    check: (planId: string, name: string) => Promise<{ targetExists: boolean; existingFiles: number }>;
    apply: (planId: string, name: string, fixIds: string[], policy: 'copy' | 'skip' | 'replace') => Promise<ImportApplyResult>;
    /** Bundled single-file OpenCollection YAML via a save dialog. */
    export: (collectionId: string, includeEnvironments: boolean) => Promise<string | null>;
  };

  appSettings: {
    get: () => Promise<{ settings: AppSettings; historyRuns: number; historyBytes: number }>;
    set: (settings: AppSettings) => Promise<{ settings: AppSettings; historyRuns: number; historyBytes: number }>;
    /** Saves and applies appearance settings (light/dark, theme, fonts) immediately. */
    setAppearance: (change: Partial<Appearance>) => Promise<{ settings: AppSettings; historyRuns: number; historyBytes: number }>;
  };

  runs: {
    /** Runs the draft in the collection's active environment and records it in history. */
    start: (runId: string, requestId: string, doc: RequestDoc) => Promise<{ result: RunResult; historyError?: string }>;
    cancel: (runId: string) => Promise<void>;
    /** Shows a save dialog and writes the raw response bytes. Resolves the saved path, or null if cancelled. */
    saveBody: (runId: string, suggestedName: string) => Promise<string | null>;
    /**
     * The response body as base64, for the image and PDF preview: the bytes as received for recent runs, else the stored
     * history body. Refused above MEDIA_PREVIEW_MAX_BYTES.
     */
    bodyBytes: (runId: string) => Promise<string>;
    /** The request as a cURL command with secrets and cookies included. Only for recent runs of this session. */
    curlWithSecrets: (runId: string) => Promise<string>;
    /** The raw HTTP request head of the last request sent, with secrets and cookies. Only for recent runs of this session. */
    rawWithSecrets: (runId: string) => Promise<string>;
    /** Explicit reveal of one recorded cookie value, in memory for the last 50 sends only. */
    cookieValue: (runId: string, index: number) => Promise<string>;
  };

  /** Collection runner: the saved requests under a collection or folder, in tree order, one at a time. */
  runner: {
    /** Resolves when the run ends; progress arrives through onEvent. One run at a time. */
    start: (runnerId: string, nodeId: string, options: RunnerOptions) => Promise<RunnerResult>;
    cancel: (runnerId: string) => Promise<void>;
    onEvent: (cb: (e: RunnerEvent) => void) => () => void;
  };

  oauth2: {
    /** Status of the token for the draft's effective auth in the active environment; 'fetch' gets a new one, 'forget' drops it. */
    token: (requestId: string, doc: RequestDoc, action: 'status' | 'fetch' | 'forget') => Promise<OAuth2TokenView>;
  };

  cookies: {
    /** The jar of the collection's active environment. */
    list: (collectionId: string) => Promise<CookieJarView>;
    /** Adds or replaces a cookie; `previous` names the one being edited. */
    upsert: (collectionId: string, cookie: CookieView, previous?: Pick<CookieView, 'domain' | 'path' | 'name'>) => Promise<CookieJarView>;
    remove: (collectionId: string, cookie: Pick<CookieView, 'domain' | 'path' | 'name'>) => Promise<CookieJarView>;
    /** Clears one domain, or the whole jar when domain is omitted. */
    clear: (collectionId: string, domain?: string) => Promise<CookieJarView>;
  };

  /** Process CPU and memory for the Performance tab. */
  metrics: () => Promise<AppMetrics>;

  clipboard: {
    write: (text: string) => Promise<void>;
  };
}

/**
 * A request panel's send, for the VS Code extension's Dev Tools view: its start (as the desktop's Dev tools records it)
 * and its end. Collection runs reach that view as runner events.
 */
export type DevToolsRunEvent =
  | { type: 'start'; runId: string; requestId: string; requestName: string; collectionId: string; environment: string; method: string; url: string }
  | { type: 'end'; runId: string; collectionId: string; result: RunResult | null; error?: string };

/** Events the host pushes to the UI, by channel. */
export interface HostEvents {
  'workspace:external-change': ExternalChange;
  'runner:event': RunnerEvent;
  /** Asks the UI to open the environment editor for a collection (sent by the VS Code extension's commands). */
  'environments:manage': { collectionId: string };
  /**
   * Asks the UI to show a past run, or to put its request into the unsaved draft (sent by the VS Code extension's History
   * view). 'show' is Dev Tools' "Open request": the latest run when it is that one, else the run from history.
   */
  'history:entry': { runId: string; action: 'open' | 'restore' | 'show' };
  /** A request panel's send, for the VS Code extension's Dev Tools view. */
  'devtools:run': DevToolsRunEvent;
  /** The request and collection of the VS Code panel last focused, with its workspace folder's tree, for Dev Tools. */
  'devtools:context': { snapshot: WorkspaceSnapshot | null; requestId: string | null; collectionId: string | null };
  /** Asks the VS Code extension's Dev Tools view to select a run in its Network tab. */
  'devtools:select': { runId: string };
  /** The requests with unsaved edits in the VS Code extension's request panels, for its collection runner. */
  'panels:unsaved': { requestIds: string[] };
  /** Asks the VS Code extension's runner panel to show another collection or folder. */
  'runner:open': { nodeId: string };
}

const HOST_EVENT_CHANNELS: Record<keyof HostEvents, true> = {
  'workspace:external-change': true, 'runner:event': true, 'environments:manage': true, 'history:entry': true,
  'devtools:run': true, 'devtools:context': true, 'devtools:select': true, 'panels:unsaved': true, 'runner:open': true
};
export const HOST_EVENTS = Object.keys(HOST_EVENT_CHANNELS) as (keyof HostEvents)[];

/** Prefix on error messages that cross IPC (Electron strips custom error classes). */
export const IPC_ERROR_PREFIX = 'YeptError: ';
