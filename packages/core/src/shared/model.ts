// Domain model shared by the engine (main process) and the UI (renderer).
// These are Yept's own types; the engine converts to and from Bruno's file model in one place
// (packages/core/src/engine/workspace/bruno-adapter.ts) so the UI never depends on @usebruno/* internals.
import { CODE_SIZE, type PaletteId, type ThemeChoice } from './appearance';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface KeyValue {
  name: string;
  value: string;
  enabled: boolean;
}

export interface Param extends KeyValue {
  type: 'query' | 'path';
}

export const BODY_MODES = ['none', 'json', 'text', 'xml', 'formUrlEncoded', 'multipartForm'] as const;
export type BodyMode = (typeof BODY_MODES)[number];

/** One part of a multipart/form-data body. */
export interface MultipartField {
  name: string;
  type: 'text' | 'file';
  /** Text fields: the value ({{variables}} allowed). '' for file fields. */
  value: string;
  /**
   * File fields: paths saved in the request file, relative to the collection folder ({{variables}} allowed).
   * Bruno allows several files per field. Absolute paths written by other tools are kept as they are.
   */
  files: string[];
  /** File fields: files outside the collection, chosen on this computer. Kept locally, never written to the request file. */
  localFiles: string[];
  /** Content type of the part; '' sends none for text and guesses from the file name for files. */
  contentType: string;
  enabled: boolean;
}

export interface RequestBody {
  mode: BodyMode;
  json: string;
  text: string;
  xml: string;
  formUrlEncoded: KeyValue[];
  multipartForm: MultipartField[];
  /**
   * A Bruno body mode Yept doesn't edit or send yet (e.g. 'file' for a binary file, 'sparql'). While it's set,
   * `mode` is 'none', the body is kept unchanged in the file and sending stops with an explanation.
   * Choosing another mode clears it, and saving then replaces the original body.
   */
  unsupported?: string;
}

export interface RequestSettings {
  encodeUrl: boolean;
  /** 0 means "use the app default". */
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  forwardAuthorizationHeader: boolean;
  /** False: stored cookies aren't added to this request (Set-Cookie responses are still stored). */
  sendCookies: boolean;
}

/**
 * Auth modes Yept edits. Other Bruno modes (wsse, oauth1, ...) and OAuth2 grant types other than client
 * credentials are shown read-only and kept unchanged on save.
 */
export const AUTH_MODES = ['inherit', 'none', 'bearer', 'basic', 'apikey', 'oauth2', 'digest', 'awsv4', 'ntlm'] as const;
export type EditableAuthMode = (typeof AUTH_MODES)[number];

/** The only OAuth2 grant type Yept can send. */
export const OAUTH2_CLIENT_CREDENTIALS = 'client_credentials';

export interface OAuth2Config {
  /** Bruno's grant type. Only client_credentials is edited and sent; other flows are kept unchanged in the file. */
  grantType: string;
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated scopes; '' sends none. */
  scope: string;
  /** How the client id and secret reach the token endpoint. */
  credentialsPlacement: 'basic_auth_header' | 'body';
  /** Where the access token goes on the request. */
  tokenPlacement: 'header' | 'url';
  /** Before the token in the Authorization header, usually 'Bearer'; '' sends the token alone. */
  tokenHeaderPrefix: string;
  /** Query parameter name when the token goes in the URL. */
  tokenQueryKey: string;
  /** Get a token automatically when there is none yet. */
  autoFetchToken: boolean;
  /** Get a new token automatically when the current one has expired or is rejected. */
  autoRefreshToken: boolean;
}

export const DEFAULT_OAUTH2: OAuth2Config = {
  grantType: OAUTH2_CLIENT_CREDENTIALS, accessTokenUrl: '', clientId: '', clientSecret: '', scope: '',
  credentialsPlacement: 'basic_auth_header', tokenPlacement: 'header', tokenHeaderPrefix: 'Bearer', tokenQueryKey: 'access_token',
  autoFetchToken: true, autoRefreshToken: true
};

/** AWS Signature Version 4. */
export interface AwsV4Config {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials only; '' sends none. */
  sessionToken: string;
  /** e.g. 'execute-api', 's3'. */
  service: string;
  /** e.g. 'eu-west-1'. */
  region: string;
  /** Bruno's AWS profile name. Yept doesn't read AWS profiles: it's kept unchanged in the file. */
  profileName: string;
}

export interface AuthConfig {
  /** One of AUTH_MODES, or another Bruno mode kept as-is. */
  mode: string;
  bearer: { token: string };
  basic: { username: string; password: string };
  apikey: { key: string; value: string; placement: 'header' | 'queryparams' };
  oauth2: OAuth2Config;
  digest: { username: string; password: string };
  awsv4: AwsV4Config;
  /** Bruno's NTLM has no workstation field; Yept sends none. */
  ntlm: { username: string; password: string; domain: string };
}

export const EMPTY_AWSV4: AwsV4Config = { accessKeyId: '', secretAccessKey: '', sessionToken: '', service: '', region: '', profileName: '' };

/** Auth with nothing set: the starting point for code that builds an AuthConfig. */
export const emptyAuth = (): AuthConfig => ({
  mode: 'none',
  bearer: { token: '' },
  basic: { username: '', password: '' },
  apikey: { key: '', value: '', placement: 'header' },
  oauth2: { ...DEFAULT_OAUTH2 },
  digest: { username: '', password: '' },
  awsv4: { ...EMPTY_AWSV4 },
  ntlm: { username: '', password: '', domain: '' }
});

/** True when Yept can edit and send this auth (OAuth2 only with client credentials). */
export function isEditableAuth(auth: AuthConfig): boolean {
  return (AUTH_MODES as readonly string[]).includes(auth.mode) && (auth.mode !== 'oauth2' || auth.oauth2.grantType === OAUTH2_CLIENT_CREDENTIALS);
}

/** What the Auth tab shows about the cached OAuth2 token. The token itself never leaves the main process. */
export interface OAuth2TokenStatus {
  state: 'none' | 'valid' | 'expired';
  /** ISO time; absent when the server gave no expiry. */
  expiresAt?: string;
  obtainedAt?: string;
  tokenType?: string;
  /** Scope granted by the server, when it says. */
  scope?: string;
}

/** How a run got its OAuth2 token. */
export interface OAuth2Use {
  token: 'cached' | 'fetched' | 'renewed';
  expiresAt?: string;
  /** The server rejected the token with 401: the run retried once with a new token (safe methods only). */
  retried?: boolean;
  /** Shown to the user, e.g. why a request wasn't re-sent after a 401. */
  note?: string;
}

export interface Scripts {
  /** Runs before the request is sent. */
  req: string;
  /** Runs after the response arrives. */
  res: string;
}

export interface RequestVars {
  /** Pre-request variables: static values (may contain {{vars}}). */
  req: KeyValue[];
  /** Post-response variables: expressions such as res.body.access_token. This is how tokens are extracted. */
  res: KeyValue[];
}

/** The editable part of a saved HTTP request. Fields Yept doesn't edit yet are preserved on save. */
export interface RequestDoc {
  name: string;
  method: HttpMethod;
  url: string;
  params: Param[];
  headers: KeyValue[];
  body: RequestBody;
  auth: AuthConfig;
  vars: RequestVars;
  script: Scripts;
  /** JavaScript tests run after the response: test("name", () => expect(res.status).to.equal(200)). */
  tests: string;
  /** Declarative assertions: name = expression (res.status), value = "operator value" (eq 200). */
  assertions: KeyValue[];
  docs: string;
  settings: RequestSettings;
}

/** Defaults set on a collection or folder and inherited by the requests inside it. */
export interface SettingsDoc {
  name: string;
  headers: KeyValue[];
  auth: AuthConfig;
  /** Collection or folder variables (static values). */
  vars: KeyValue[];
  script: Scripts;
  /** Tests run for every request inside. */
  tests: string;
  docs: string;
}

export interface EnvVariable {
  name: string;
  /** Shared value from the environment file. Always '' for secrets. */
  value: string;
  secret: boolean;
  enabled: boolean;
}

export interface Environment {
  name: string;
  variables: EnvVariable[];
}

/** What the environment editor shows for one variable: shared file value plus this machine's local layers. */
export interface EnvVariableView extends EnvVariable {
  /** Local override (this machine only), if set. */
  override?: string;
  /** True if a local secret value is stored. The value itself is only sent on an explicit reveal. */
  hasSecret: boolean;
}

export interface EnvironmentView {
  name: string;
  /** Path of the shared file, relative to the workspace. */
  path: string;
  variables: EnvVariableView[];
  tls: TlsSettings;
}

/** Local, per-machine TLS settings for one environment (never committed). */
export interface TlsSettings {
  /** Skips certificate checks. Shown as a warning next to the environment switcher. */
  skipVerify: boolean;
  /** Extra CA certificate file (PEM) to trust, e.g. a company root. */
  caFile: string;
}

export type VarSource = 'collection' | 'environment' | 'override' | 'secret' | 'folder' | 'request' | 'runtime' | 'session';

/** A resolved variable for previews. Secret values are masked. */
export interface ResolvedVar {
  name: string;
  value: string;
  source: VarSource;
  secret: boolean;
}

export type NodeKind = 'collection' | 'folder' | 'request';

export interface TreeNode {
  /** Stable id. Requests use the identity index; folders and collections use their path. */
  id: string;
  kind: NodeKind;
  name: string;
  /** Path relative to the workspace root, forward slashes. */
  path: string;
  method?: HttpMethod;
  /** .bru collections open read-only. */
  readOnly?: boolean;
  children?: TreeNode[];
}

export interface WorkspaceSnapshot {
  root: string;
  collections: TreeNode[];
  /** Files that could not be parsed, with the reason. Shown to the user, never silently dropped. */
  problems: { path: string; message: string }[];
}

export type Outcome = 'http' | 'network' | 'timeout' | 'cancelled' | 'prepare_error';

export interface TimelineEntry {
  atMs: number;
  label: string;
  detail?: string;
}

/** Bodies longer than this (in characters) are shown as raw text, not formatted, and the extension sends only this much to its page. */
export const LARGE_BODY_CHARS = 2 * 1024 * 1024;

export interface RunResult {
  runId: string;
  outcome: Outcome;
  /** Only for outcome 'http'. */
  status?: number;
  statusText?: string;
  durationMs: number;
  sizeBytes: number;
  headers: [string, string][];
  body: {
    text: string;
    contentType: string;
    /** True when the body exceeded the processing limit and reading stopped. */
    truncated: boolean;
    /** True when the body isn't valid UTF-8 text (shown as a size summary, saved to file as bytes). */
    binary: boolean;
    /**
     * True when `text` holds only the first LARGE_BODY_CHARS characters of the body. The host keeps the whole body and
     * can open it elsewhere (the VS Code extension opens it in an editor). Never set on the desktop.
     */
    preview?: boolean;
  };
  /** For every outcome except 'http'. */
  error?: { message: string; code?: string };
  /** What was sent, with secret values masked. */
  request: { method: HttpMethod; url: string; headers: [string, string][] };
  timeline: TimelineEntry[];
  /** Environment used for this run ('' when none). */
  environment: string;
  /** Errors from scripts or post-response variables. A failing script never turns into a pass. */
  scriptErrors: { stage: ScriptStage; message: string }[];
  /** Token/variable extraction results from post-response variables. */
  extractions: ExtractionResult[];
  /** console.* output from scripts, in order. */
  console: { stage: ScriptStage; level: string; text: string }[];
  /** Results of assertions, then tests (collection, folders, request). */
  tests: TestResult[];
  /** 'none' = nothing to run; 'not-run' = there were tests but they couldn't run (see testsNote). Never shown as passed. */
  testsState: 'ran' | 'none' | 'not-run';
  testsNote?: string;
  /** What was sent: masked request body. For multipart, a summary of the parts (never file contents). */
  requestBody?: string;
  /** Multipart parts as sent, text values masked, for the Network tab and Copy as cURL. File contents are never kept. */
  multipart?: MultipartPartSummary[];
  /** Every request on the wire, redirects first and the final one last. Absent when nothing was sent, and for older history. */
  hops?: NetworkHop[];
  /** Where the Cookie header came from. Absent for older history. */
  cookies?: CookieUse;
  /** Cookie metadata per hop, without values. Absent for older history; [] means none recorded. */
  cookieDetails?: RunCookie[];
  /** Set when the request used OAuth2 and a token was obtained. */
  oauth2?: OAuth2Use;
  /** Requests the scripts sent with bru.sendRequest, in order, for Dev tools. Not kept in history (the timeline lists them). */
  scriptRequests?: ScriptRequest[];
}

/** A request a script sent with bru.sendRequest. Its result is masked like the run's own. */
export interface ScriptRequest {
  stage: ScriptStage;
  /** Milliseconds since the epoch. */
  startedAt: number;
  result: RunResult;
}

/** One multipart part as sent. Files are described by name, path and size only. */
export interface MultipartPartSummary {
  name: string;
  type: 'text' | 'file';
  /** Text parts. */
  value?: string;
  /** File parts: the file name sent, and the full path it was read from on this computer. */
  fileName?: string;
  path?: string;
  size?: number;
  /** '' when the part had no Content-Type (text parts without one). */
  contentType: string;
}

/** Cookies on one recorded exchange, not the current contents of the jar. Values stay in main-process memory. */
export interface RunCookie {
  hop: number;
  direction: 'sent' | 'received';
  name: string;
  source?: 'jar' | 'request';
  /** Received Set-Cookie attributes, with default domain/path resolved against that response's URL. */
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

/** Milliseconds per phase of one request. A phase is absent when it didn't happen (reused connection, IP address, plain HTTP). */
export interface PhaseTimings {
  dns?: number;
  connect?: number;
  tls?: number;
  /** Request sent until the first response byte. */
  wait?: number;
  /** First to last body byte (final request only). */
  download?: number;
  total: number;
  /** True when a kept-alive connection was reused. */
  reused: boolean;
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
}

export interface ConnectionInfo {
  remoteAddress?: string;
  remotePort?: number;
  httpVersion?: string;
  /** Proxy host:port when the request went through one. */
  proxy?: string;
  tls?: { protocol: string; cipher: string; certificate?: CertificateInfo };
}

/** One request on the wire. Header values are masked like RunResult.request. */
export interface NetworkHop {
  method: string;
  url: string;
  /** Absent when no response arrived. */
  status?: number;
  statusText?: string;
  requestHeaders: [string, string][];
  responseHeaders: [string, string][];
  timings: PhaseTimings;
  connection: ConnectionInfo;
}

/** One stored cookie, as the Cookies tab shows and edits it. */
export interface CookieView {
  name: string;
  value: string;
  /** Without a leading dot. */
  domain: string;
  path: string;
  /** ISO date; null for a session cookie (cleared when Yept closes). */
  expires: string | null;
  secure: boolean;
  httpOnly: boolean;
  /** 'strict', 'lax', 'none' or '' when not set. */
  sameSite: string;
  /** True: sent to exactly this host. False: also to its subdomains. */
  hostOnly: boolean;
}

export interface CookieUse {
  /** jar: added from the cookie jar; request: the request's own Cookie header; none: no Cookie header. */
  source: 'jar' | 'request' | 'none';
  /** Names of cookies sent from the jar on the first request. */
  sent: string[];
  /** Names of cookies stored from responses (all hops). */
  stored: string[];
}

export type ScriptStage = 'pre-request' | 'post-response vars' | 'post-response' | 'tests';

export interface TestResult {
  name: string;
  kind: 'test' | 'assertion';
  /** error = the test couldn't be evaluated (syntax error, unknown matcher, timeout), which is never a pass. */
  status: 'passed' | 'failed' | 'error';
  message?: string;
  /** Where it was defined: 'request', a folder name, or the collection name. */
  source: string;
}

// ---------- history ----------

export interface HistorySummary {
  runId: string;
  requestId: string;
  startedAt: string;
  environment: string;
  method: HttpMethod;
  /** Redacted. */
  url: string;
  outcome: Outcome;
  status?: number;
  durationMs: number;
  sizeBytes: number;
  passed: number;
  failed: number;
  errors: number;
  testsState: RunResult['testsState'];
  bodyTruncated: boolean;
  bodyOmitted: boolean;
  /** Request name and path when it ran (shown for orphaned history). */
  requestName: string;
  requestPath: string;
}

export interface HistoryEntry {
  summary: HistorySummary;
  /** The stored result, redacted, with the stored (possibly truncated) body. */
  result: RunResult;
  /** The request as it was sent (redacted), for "Restore request". */
  doc: RequestDoc;
}

export interface OrphanedHistory {
  requestId: string;
  requestName: string;
  requestPath: string;
  runs: number;
  lastRun: string;
}

export type { ThemeChoice, PaletteId };

export interface AppSettings {
  /** Light/dark appearance; 'system' follows Windows. */
  theme: ThemeChoice;
  /** Built-in colour theme. */
  palette: PaletteId;
  /** Installed font family for the interface; '' uses the default. */
  uiFont: string;
  /** Installed font family for code, editors and raw views; '' uses the default. */
  codeFont: string;
  /** Code editor font size in px. */
  codeFontSize: number;
  /** Runs kept per request. */
  historyRunsPerRequest: number;
  /** Total history size cap, in MB (default 500). */
  historyCapMb: number;
  /** Response body bytes stored per run, in MB (default 2). Larger bodies are stored truncated and labelled. */
  historyBodyLimitMb: number;
  /** Store Set-Cookie responses and send matching cookies automatically. */
  cookies: boolean;
}

/** The settings that apply at once, without Save: light/dark, theme and fonts. */
export type Appearance = Pick<AppSettings, 'theme' | 'palette' | 'uiFont' | 'codeFont' | 'codeFontSize'>;
export const APPEARANCE_KEYS = ['theme', 'palette', 'uiFont', 'codeFont', 'codeFontSize'] as const satisfies readonly (keyof Appearance)[];

export const DEFAULT_APP_SETTINGS: AppSettings = { theme: 'system', palette: 'blue', uiFont: '', codeFont: '', codeFontSize: CODE_SIZE.default, historyRunsPerRequest: 20, historyCapMb: 500, historyBodyLimitMb: 2, cookies: true };

export interface ExtractionResult {
  variable: string;
  expression: string;
  ok: boolean;
  /** Where the value went: the environment's local secrets, or its runtime variables. */
  target: 'secret' | 'runtime';
  /** Why it failed (non-2xx response, empty value, script error). The variable is cleared on failure. */
  message?: string;
}

// ---------- git and import ----------

export interface GitFile {
  /** Repo-relative, forward slashes. */
  path: string;
  /** Previous path for renames. */
  from?: string;
  /** Two-letter porcelain code: index then worktree, e.g. 'M.', '.M', '??'. */
  code: string;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
}

export interface LeakFinding {
  path: string;
  line: number;
  kind: 'jwt' | 'bearer' | 'credential-field' | 'secret-with-value' | 'local-secret';
  /** Why it was flagged, in plain words. */
  reason: string;
  /** The line with the suspicious value masked. */
  excerpt: string;
}

export interface ImportSecretFinding {
  id: string;
  where: string;
  field:
    | 'bearer token' | 'basic password' | 'api key' | 'client secret' | 'digest password' | 'ntlm password' | 'aws secret access key' | 'aws session token'
    | 'authorization header' | 'environment value';
  variable: string;
  preview: string;
}
