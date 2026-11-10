# Architecture

Yept is an Electron desktop app. Collections are plain Bruno OpenCollection YAML files in a folder (usually a Git repository). Everything personal — secrets, local overrides, TLS settings, response history, preferences — stays on the user's computer.

## Processes and code layout

| Layer | Path | Role |
|---|---|---|
| Engine | `packages/core/src/engine` | Plain Node, no Electron: workspace and files, request identity, variables and environments, runner, sandbox, history, Git, leak check, import/export. Unit-tested on its own. |
| Shared | `packages/core/src/shared` | Types and pure helpers used on both sides (model, IPC contract and host events, the API's channel map, the transport-neutral handler registry, the webview message protocol, variable syntax, secret detection, URL params). |
| UI | `packages/ui/src` | Shared React components, Zustand state, Monaco editors, workers and CSS with theme tokens, the collection runner and Dev Tools. |
| Services | `packages/core/src/services` | Host-neutral workspace, environments, settings, cookies, runs, collection runs and import/export; shared by desktop and extension. |
| Application | `apps/desktop/src/main` | Desktop handlers and the Git service. |
| Desktop host | `apps/desktop/src/host` | Electron bootstrap, window and menu, IPC binding, dialogs, trash, clipboard, safeStorage, theme, metrics and packaging self-tests. All Electron imports, including the icon helper, live here. |
| Preload | `apps/desktop/src/host/preload` | Exposes one typed API object, `window.yept`, through `contextBridge`: the shared `createApi` over `ipcRenderer`. |
| Desktop renderer | `apps/desktop/src/renderer` | App entry, home, tabs, collection tree, Git panel and app settings. |
| VS Code scaffold | `apps/vscode` | esbuild extension host, Vite webview shell, the webview message transport and extension-host checks. The shared request editor and response pane, collection runner and Dev Tools, with host-side execution and local history. |

The npm workspaces are `@yept/core`, `@yept/ui` and `@yept/desktop`. Cross-workspace imports use `@yept/core/*` and `@yept/ui/*`; `@shared/*` points to the core shared modules. TypeScript, Vite and Vitest resolve the same source paths. The root package owns the existing commands, Electron entry (`out/main/index.js`) and production dependencies for packaging; workspace manifests declare the dependencies their sources use. Vite bundles the workspace sources into the existing `out/main`, `out/preload` and `out/renderer` layout.

The `yept-vscode` workspace bundles a VS Code host adapter and a shared React request panel. Its Collections view discovers collections in each local workspace folder and **Yept: Open Request** offers requests by collection and path. Each request opens in its own webview panel (kept while hidden), with the selected id escaped into its HTML. The page reports the request's name and unsaved draft to the extension, which marks the tab title and, since a webview panel can't refuse to close, asks to save after a dirty panel closes, reopening it with the draft on Cancel. The page also reports the past run it shows. A History view lists the runs of the active panel's request from the history database, and sends its Open and Restore to that panel as a `history:entry` event. Results reach the page with text bodies over `LARGE_BODY_CHARS` (2 MB) cut to a preview (`body.preview`). The whole body opens from the host as a read-only `yept-body:` document. Validated webview handlers use the same services as desktop; local state stays under `globalStorageUri`. Local secrets are encrypted with AES-256-GCM under a random key kept in VS Code's secret storage; automatic cookies follow the `yept.cookies.automatic` setting. In untrusted folders the run service tells the runner that scripts are blocked: requests are sent, and scripts, vars, assertions and tests are reported as not run.

The collection run service is in core (`packages/core/src/services/collection-run-service.ts`), so the desktop and the extension run collections the same way. **Run Collection** and **Run Folder** in the tree open one runner panel. It shows the shared runner view (`packages/ui/src/components/RunnerDialog.tsx`), and progress reaches it as `runner:event`. A Dev Tools webview view in the bottom panel shows the shared Console, Network and Cookies tabs, without Performance. Request panels report each send to it as `devtools:run`, and runner steps arrive as `runner:event`. The host keeps this session's last 500 sends in memory, with bodies cut to the 64 KB that Network shows. It sends them when the view first loads, so earlier sends appear, as on the desktop.

The import service is in core too (`packages/core/src/services/import-service.ts`), so both apps import and export the same way. The extension's **Import Collection**, **Export Collection** and **Paste cURL** are VS Code commands, not pages. Import shows the service's preview in a modal, then the same credential and conflict choices as the desktop dialog. It also takes a `.bru` collection folder from anywhere on disk. The import runs in turn with the tree's reloads, so a reload never sees a half-loaded workspace. Paste cURL uses the shared parser in `packages/core/src/shared/curl.ts`. See [extension development](../apps/vscode/CONTRIBUTING.md).

The extension leaves Git to VS Code's Source Control and adds only the leak check, with the desktop's scanner (`packages/core/src/engine/guard/leak-scan.ts`). `apps/vscode/src/leak-diagnostics.ts` scans each workspace folder's collection files and publishes findings as Problems warnings. The tree's `onDidChangeFiles` event and environment changes schedule a debounced rescan. The scanner gives a line and a masked excerpt, and `apps/vscode/src/leak-check.ts` finds the value's columns from where the mask starts. The optional pre-commit hook runs `apps/vscode/src/leak-checker.ts`, bundled to `dist/yept-leak-check.cjs` and copied next to the hook, so it needs neither the extension nor a path that changes with each version. It reads staged files with `git cat-file`. Without `node` on PATH it uses the VS Code executable with `ELECTRON_RUN_AS_NODE=1`.

`createHandlers` (`apps/desktop/src/main/handlers.ts`) constructs the application services using an `AppHost` and returns a `HandlerRegistry` (`packages/core/src/shared/handler-registry.ts`). The registry dispatches named operations without Electron, rejects unknown channels and preserves domain errors. `apps/desktop/src/host/ipc.ts` binds those operations to `ipcMain`, adds the existing `YeptError:` prefix on failure and can detach its bindings. Workspace-change and collection-run events pass through the host's typed event sink to the current window. The event names and payload types (`HostEvents`) live in the shared IPC contract.

### One API, two transports

`createApi(invoke, subscribe)` (`packages/core/src/shared/create-api.ts`) builds the `YeptApi` object from two functions: `invoke(channel, ...args)` returns a promise and `subscribe(channel, callback)` returns an unsubscribe function. It holds the only method-to-channel map. The desktop preload supplies `ipcRenderer.invoke` and `ipcRenderer.on`; channel names and arguments are the ones the desktop has always sent.

In the extension, the same object travels over webview messages (`packages/core/src/shared/webview-protocol.ts`). The webview sends `{ id, channel, args }`; the host answers `{ id, result }` or `{ id, error }` and pushes `{ event, payload }` for the channels in `HostEvents` only. `apps/vscode/src/webview/bridge.ts` installs `window.yept` before any UI module loads, because `packages/ui/src/api.ts` reads it at load. `apps/vscode/src/webview-binding.ts` binds one webview to a `HandlerRegistry`: it ignores malformed messages (not a plain object with a string or finite-number id, a string channel and an args array), answers channels that weren't registered when it was bound with an error, and sends a thrown error as `YeptError:` plus its message, with no stack trace, as the desktop does. The UI's `errorMessage` therefore shows the same text in both apps.

VS Code serialises webview messages as JSON in both directions (array buffers and typed arrays are carried separately), unlike Electron's structured clone. An `undefined` array item becomes `null`, so the webview client leaves trailing `undefined` arguments out: an omitted optional argument such as the domain of `cookies.clear` or the override of `git.commit` arrives omitted. `undefined` object fields are dropped, and a missing `result` means `undefined`. The API's types carry no `Date`, `Map`, `Set` or typed arrays today.

`AppHost` supplies dialogs, clipboard, trash, web links, data paths, versions, notices, self-tests, the sandbox worker path, appearance and process metrics. Services accept only the capabilities they use. The desktop cipher still uses synchronous `safeStorage` with base64 ciphertext; local environments, cookies, settings, preferences, identity and history retain their filenames and formats. Profile migration stays in the Electron bootstrap before the host and services are constructed.

The renderer runs with `contextIsolation`, `sandbox`, no `nodeIntegration` and a strict Content Security Policy. All file, network and Git work happens in the main process.

Nothing opens inside the app: main cancels every navigation of the window (`will-navigate`) and denies every new window (`setWindowOpenHandler`). A URL asked for that way reaches the operating system only if it is `http:` or `https:`: `apps/desktop/src/main/external-links.ts` is the one path to `shell.openExternal`, and it hands over the URL as parsed. `file:`, UNC paths, `javascript:`, `data:`, `mailto:`, `ms-*` and other registered protocol handlers are dropped without a message, because nothing in the app needs them and response HTML is untrusted.

## Built on Bruno's packages

Yept uses Bruno's published npm packages (MIT) rather than forking the Bruno app:

| Package | Used for |
|---|---|
| `@usebruno/filestore` | Parsing and writing OpenCollection YAML (and reading `.bru`). |
| `@usebruno/js` | The QuickJS script sandbox, `bru`/`res`/`req` objects, Chai `expect`, assertions. |
| `@usebruno/common` | Interpolation helpers. |
| `@usebruno/converters` | Postman, Insomnia, OpenAPI and `.bru` import. |

Versions are pinned exactly and each package is wrapped in a thin adapter, because these packages are built mainly for Bruno's own monorepo and change between releases.

`@usebruno/js` also requires `@usebruno/requests`, without declaring it, for `bru.sendRequest` and `bru.cookies`. That package pulls in the AWS, Azure, GCP and gRPC SDKs, so `shims/usebruno-requests` is a small local stand-in. `bru.cookies` goes through it to the request's cookie jar (see Cookies); `bru.sendRequest` goes through it to Yept's runner (see Requests sent by scripts).

The request pipeline (prepare → interpolate → scripts → send → variables → tests) is not a library in Bruno, so Yept has its own runner, modelled on Bruno CLI's.

## Workspace, files and identity

- **Workspace:** a folder searched up to four levels deep for collections. `opencollection.yml` collections are editable; `bruno.json` (`.bru`) collections open read-only and can be converted to a YAML copy. Files that can't be parsed are listed, never dropped.
- **Writes** are atomic (temporary file + rename). Saving an unedited request rewrites the exact same bytes; fields the UI doesn't edit (scripts, assertions, unknown keys) are kept.
- **File watching** reloads clean tabs when a file changes outside the app and shows a conflict banner for tabs with unsaved edits. The app recognises its own writes by content hash, so a teammate's change or `git pull` right after a save is still noticed.
- **Request identity:** Bruno files have no stable id, so a local index (`identity.db`, SQLite) gives each request an id that survives renames and moves made in the app, and outside renames matched by content fingerprint. History is stored against these ids. Runs whose request can't be matched become *orphaned history* that the user can reattach or delete; the app never guesses.
- **Renames from Git:** pull, Sync and branch switch note HEAD before and after. When it moved, `git diff --find-renames` between the two commits (limited to the collection folders) gives renamed files, edited ones included, and their request ids move to the new paths before the workspace reloads, so history and open tabs follow. A rename is skipped when Git had to choose between identical files (another deleted or renamed file with the same content as the source, or another added or renamed file with the same content as the target), when it leaves its collection or lands outside the request files, or when the new path already has an id. Skipped renames fall back to content fingerprints, then orphaned history. Watcher-driven reloads wait while a Git operation runs, so a rename is matched before anything reloads.

## Variables and environments

- **Precedence**, same as Bruno so shared collections behave the same in both tools (lowest to highest): collection < environment (file < local override < local secret < script session) < folder (outer to inner) < request < runtime.
- **Environment files** (`environments/*.yml`) hold shared values. A variable marked secret is written **without** a value.
- **This machine only** (`local-environments.json` in the app data folder): local overrides, secret values encrypted with Electron `safeStorage` (Windows DPAPI, macOS Keychain), and TLS settings. Runtime values and secrets are scoped to `(collection, environment)`, so switching environments never carries a token across.
- **Unresolved `{{variables}}`** stop the send before anything goes out, listing the names.
- **Token extraction** (post-response variables) keeps a value only from a 2xx response with a non-empty result; otherwise the variable is cleared, so an old token is never silently reused. Names declared secret go to local secrets.

## Running a request

- **Outcomes** are kept distinct: `http` (any status), `network`, `timeout`, `cancelled`, `prepare_error`. No status codes are invented for failures.
- **Limits:** a whole-request deadline (also covers bodies that stall), cancel via `AbortController`, redirects with a maximum, and a 50 MB processing limit with a visible truncation flag. Binary bodies are detected and saved as bytes.
- **Bodies:** none, JSON, text, XML, form URL-encoded and multipart (see below).
- **Auth:** none, inherit (nearest folder, then collection), bearer, basic, API key (header or query), OAuth2 client credentials, Digest, NTLM and AWS Signature v4 (see below). Other Bruno modes (WSSE, OAuth1, Akamai EdgeGrid) and other OAuth2 flows are preserved in the file and stop the send with an explanation.
- **TLS:** the operating system's certificate store is always trusted (Node's `tls.getCACertificates('system')` plus Node's roots), so locally trusted development certificates and corporate roots work. Only self-signed certificates valid for TLS server authentication are trust anchors; intermediate certificates in the store are not, so servers must send their intermediate chain. Per environment, on this machine only: an extra CA file or skipping verification (shown clearly in the UI). The CA file must contain a self-signed root (a bundle may also contain intermediates); a file with none stops the send with an explanation.
- **Masking:** secret values in results, timelines and console output are replaced with `••••••`; `Authorization`, `Cookie` and `X-Amz-Security-Token` headers are hidden. Auth passwords, secret keys and session tokens are masked even when typed into the auth settings rather than kept in a variable.
- **What went over the wire:** the runner sends through its own axios transport (`packages/core/src/engine/runner/network.ts`), which wraps follow-redirects so redirect behaviour is unchanged and records each request as a *hop*: the headers actually sent (including the ones the HTTP stack adds), response status and headers, phase timings from socket events (DNS lookup, TCP connect, TLS handshake, waiting for the first byte, download), and the connection (remote address, HTTP version, proxy, TLS protocol and cipher, certificate subject, issuer and validity). Hops are part of the run result, masked like the rest, and kept in history.

## Response bodies

- **Pretty** formats JSON in the renderer. HTML and XML (`packages/ui/src/markup.ts`) are recognised by content type, or by a body that starts with `<!DOCTYPE html>`, `<html>` or `<?xml`. Up to 128 KB they are formatted at once; larger ones in a Web Worker (`format.worker.ts`), so a body up to the 50 MB processing limit never blocks the window, and the body is shown as received until the formatted text arrives. Bodies over 2 MB open as raw text unless the user chooses to format them.
- **Formatter:** js-beautify's HTML beautifier (MIT) as bundled inside `monaco-editor`, the same code as Monaco's own HTML formatting, reached through the `@html-beautify` alias because the package's exports map doesn't expose it. No extra dependency. XML uses it with no void, inline or preformatted elements, so `<link>` in a feed keeps its content.
- **Monaco's HTML worker** is loaded for the `html` language (folding and outline); without it, its language features fail in the generic editor worker.
- **Preview** (HTML only) renders the body in `<iframe sandbox srcdoc>` with no `allow-*` flags: no scripts, forms, popups, plugins or top-level navigation, and a unique opaque origin, so the page can't reach the app's DOM or `window.yept`. The preload never runs in subframes (`nodeIntegrationInSubFrames` is off). Two policies apply together: the app's own CSP, which the srcdoc document inherits, and `PREVIEW_CSP`, put in front of the page's markup: `default-src 'none'` with inline styles and `data:` images and fonts only, `form-action 'none'`, `base-uri 'none'`. So nothing is fetched (no tracking pixels, no requests outside the runner's TLS settings and cookie jar, no app files reached through relative URLs), and the page's linked images and stylesheets are missing on purpose. Main's `will-frame-navigate` handler cancels any frame navigation except to `about:srcdoc` / `about:blank`, so a link or `<meta refresh>` goes nowhere. No preview link reaches the operating system either: without `allow-popups` the sandbox stops `target=_blank`, Shift, Ctrl and middle clicks before main sees them, and a link that did get through would still meet the http(s)-only check above.

## Digest, NTLM and AWS Signature v4

- **File format:** Bruno's `digest` (username, password), `ntlm` (username, password, domain) and `awsv4` (access key id, secret access key, session token, service, region, profile name) blocks. Empty fields are left out, as Bruno writes them, and an unchanged file is written back byte for byte. The AWS profile name is kept but not used.
- **Digest** (`packages/core/src/engine/auth/digest.ts`, RFC 7616 and RFC 2617): the first send has no `Authorization`. A 401 with a `WWW-Authenticate: Digest` challenge is read to the end and the request is sent once more with the answer (qop `auth` or none; MD5, SHA-256, SHA-512-256, each also `-sess`; `userhash`). When the server offers several, the strongest is used. A 401 without a Digest challenge, or one asking for `auth-int` or another algorithm, is the result, with a Timeline line saying why. A multipart body is encoded again, so files are read again.
- **NTLM** (`ntlm.ts`, MS-NLMP; NTLMv2 only, no signing or sealing): NEGOTIATE on the first send, then AUTHENTICATE answering the server's CHALLENGE. The three messages must share a connection, so an NTLM run gets its own keep-alive agent with one socket, closed when the run ends. MD4 for the password hash is in `md4.ts`: Node's OpenSSL 3 build has none. There is no workstation field (Bruno has none); none is sent.
- **AWS Signature v4** (`aws-sigv4.ts`): signed after cookies are added and right before the send, over the method, the encoded path (encoded again for every service but S3), the sorted query, every header except `Authorization`, `User-Agent`, `Connection`, `Expect`, `Range` and a few others the stack changes, and the SHA-256 of the body (a multipart body is streamed once to hash it). Adds `X-Amz-Date`, `X-Amz-Security-Token` for a session token, and `X-Amz-Content-Sha256` for S3. Checked against cases from the AWS SigV4 test suite. A redirect is not signed again.
- The runner calls one hook for Digest and NTLM (`challenge.ts`): an `initial` header for the first send and an `answer` for the 401. Both sends are hops in Network; the list says *sent again after 401*. An explicit `Authorization` header on the request turns all three off.
- Requests a script sends with `bru.sendRequest` don't use these modes (they are sent as written).

## OAuth2 client credentials

- **File format:** Bruno's `oauth2` auth with `flow: client_credentials`. Yept edits the token URL, client id and secret, scope, where the credentials go (Basic header or form body), where the token goes (Authorization header with a prefix, or a query parameter) and the two automatic switches; fields it doesn't edit are kept. Other grant types are kept unchanged and stop the send.
- **Tokens** (`packages/core/src/engine/auth/oauth2.ts`) are kept in memory only, per collection, environment and resolved configuration, so a changed token URL, client, secret or scope never reuses an old token, and a restart gets a new one. Sends that need a token at the same time share one token request.
- **Order:** the request is checked first (unresolved variables, URL), so no token is fetched for a request that can't be sent. Then a cached token is used, or a new one is fetched when there is none or it has expired (30 s early). The token request uses the environment's TLS settings and the request's timeout; a failure means the request is not sent, with the token endpoint's `error` and `error_description`.
- **After a 401 with a cached token** (revoked or expired early): the token is discarded. A GET, HEAD or OPTIONS request is re-sent once with a new token; other methods aren't re-sent automatically, because they may change data, and the response says so. A 401 for a token fetched in the same run is not retried.
- **Masking:** the client secret and every token join the run's secrets, so they are masked in the result, timeline, console and Network view and redacted in history.
- **Get token / Forget token** in the request's Auth tab act on the effective auth (its own or inherited) in the active environment. Only the token's state, expiry and granted scope reach the renderer.

## Cookies

- **One jar per collection and environment** (`packages/core/src/engine/cookies/cookie-store.ts`, using `tough-cookie`), the same scoping as runtime variables: a session from one environment is never sent while another is selected, and two collections calling the same host don't share cookies. With no environment selected, the collection has a jar of its own.
- **Automatic:** `Set-Cookie` from every response, redirect hops included, is stored; matching cookies (domain, path, `Secure`, expiry) are sent on later requests and on the next hop of a redirect. Every request counts as same-site, as there is no browser page.
- **The request's own `Cookie` header wins:** the jar then adds nothing. The run result records where the header came from (`jar`, `request`, `none`) and which cookies were sent and stored.
- **Off switches:** *Store and send cookies automatically* in Settings (default on) turns the jar off entirely. *Don't send stored cookies* on a request keeps storing but sends none; Bruno's file format has no place for it, so it is kept on this machine in `identity.db`, against the request's id.
- **Storage:** persistent cookies (`Expires`/`Max-Age`) are written to `cookies.json` in the app data folder, the whole file encrypted with `safeStorage`; session cookies stay in memory and are gone when the app closes. Cookies never go into collection files, exports or Git.
- **Scripts:** the sandbox worker gets a copy of the jar for `bru.cookies` (`get`, `has`, `upsert`, `remove`, `clear`, `jar()` for other URLs). A changed jar comes back with the script result and replaces the stored one; if two runs in the same environment overlap, the later change wins.

## Dev tools

A bottom drawer (footer **Dev tools** or Ctrl+Shift+J) with this session's activity, in renderer memory only (500 runs, 2,000 console lines, cleared on restart or with **Clear**); response history stays the permanent record.

- **Console:** run start, script `console.*` output by stage, script errors, variable extraction, test summary and request outcome, with level, current-request and text filters. A line opens its request and run.
- **Network:** every send with its hops; Request (headers sent, cookie source, body), Response, Timing and Connection views; **Copy as cURL** with secrets masked, or with secrets for the last 50 runs (the main process keeps those unmasked requests in memory only). **Table | Raw** shows the request and response heads as HTTP/1.x text (`packages/core/src/shared/raw-http.ts`), rebuilt from each hop's recorded method, URL, status, headers and HTTP version and labelled as a reconstruction, not a capture. It is masked like the table: sent `Authorization`, `Cookie` and secret values arrive masked from the runner, and `Set-Cookie` values stay hidden until *Show cookie values* is ticked. Copy copies what is shown; *…with secrets* copies the last request of the chain from the same in-memory unmasked copy as cURL.
- **Cookies:** the jar of the current collection and environment, grouped by domain, values masked until clicked; add, edit, delete, clear a domain, clear all. The footer shows the count.
- **Performance:** CPU and memory per Electron process (`app.getAppMetrics()`), uptime, history size and main-process heap, polled every 2 s only while the tab is open.

### Deliberate differences from Bruno

| Topic | Yept | Why |
|---|---|---|
| URL encoding | WHATWG `URL` serialisation | Bruno turns an existing `%20` into `%2520` in query values. |
| `{{var}}` inside JSON strings | JSON-escaped | Plain substitution breaks the body when a value contains `"` or a newline. |
| New requests: forward `Authorization` on redirect | Off | Avoids sending credentials to another origin. Existing files keep Bruno's default (on). |
| User-Agent | `Yept/<version>` unless the request sets one | Instead of the HTTP library's default. |
| Default proxy block | Not written back unless the file had one | `filestore` injects it, which adds noise to every diff. |
| `bru.sendRequest` | Uses the collection and environment's cookie jar and Yept's User-Agent | The same session as the request, e.g. a login cookie. Bruno sends it without a jar. |

## Scripts and tests

- Pre-request scripts run collection → folder → request; post-response scripts request → folder → collection (Bruno's order).
- Each script runs in QuickJS inside a warm `worker_threads` worker with a **5 s hard limit**. A runaway script is stopped and its worker replaced. QuickJS memory lives outside the V8 heap, so the time limit is the real stop.
- Results are honest: `passed`, `failed`, or `error`. Error covers syntax errors, top-level throws, unknown matchers (for example Jest's `toBe`), TypeErrors and timeouts — never reported as a pass. "No tests" and "not run" (no HTTP response, truncated body) are shown as such.
- Nothing a script does is written to a shared file: `bru.setEnvVar` lasts for the session; secret names go to local secrets.
- Cancelling a run stops a running script too (its worker is replaced), along with any request the script is waiting for.

### Requests sent by scripts (`bru.sendRequest`)

- **Supported shape**, the same as Bruno's own (a thin axios call), checked with scripts converted from Postman by Bruno's converter: `await bru.sendRequest(urlOrOptions)` resolves with `{ status, statusText, headers, data, responseTime }` (`data` parsed as JSON when it can be) and rejects for a non-2xx status or no response with an axios-shaped error `{ name, message, code, status, response }`. `bru.sendRequest(options, (err, res) => …)` is the callback form, with `err.status` set. Options: `url`, `method`, `headers`, `data`, `params`, `auth` (`username`/`password`, sent as Basic), `timeout`, `maxRedirects`, `baseURL`. An object `data` is sent as JSON, or as a form when the `Content-Type` is `application/x-www-form-urlencoded` or `multipart/form-data` (text fields only); a string is sent as it is. As in Bruno, nothing in the options is interpolated, and collection or folder headers and auth are not added.
- **Path:** the worker's `__yeptSendRequest` bridge (installed per job, used by the shim) posts the options to `SandboxHost`, which calls the runner's hook. The runner turns them into a prepared request (`packages/core/src/engine/runner/script-requests.ts`) and calls `run()` again with `RunOptions.prepared`: the same transport and hop recording, TLS settings, cookie jar, default timeout, body limit and masking as the request, with the parent's secrets and auth values. A child run has no sandbox, so it can't run scripts: there is no recursion.
- **Limits:** at most 10 per script (each collection, folder and request script counts separately); the requests count towards the script's 5 s limit, and a time-out or Cancel stops the script and aborts the requests it is waiting for. Every script stage can send (pre-request, post-response and tests).
- **Cookies:** before a send the script's changed copy of the jar is applied to the real one; afterwards the worker's copy is replaced with the jar as it is now, so `Set-Cookie` from a login is visible to `bru.cookies` and is sent with the request itself. Bruno's `bru.sendRequest` doesn't use a cookie jar; Yept's does.
- **Recorded:** each request is a full `RunResult` (`runId` = parent id + `.n`) in `RunResult.scriptRequests`, masked like the parent, and a *Script request* timeline line in the parent. Dev tools shows them as Network rows of their own linked to the parent run, and as Console lines. The main process keeps their unmasked copies for **…with secrets** like any send. History keeps only the parent run: `scriptRequests` is dropped there and the redacted timeline lists them.

## Collection runner

Runs every request under a collection or folder, one at a time, and reports a result for each.

- **Order** (`planRun`, `packages/core/src/shared/collection-run.ts`): depth first in the tree's order, which is the sidebar's: in each folder its subfolders, then its requests, each by `seq` and then name. Main plans from its own workspace snapshot; the renderer plans the same way only to show the list before the run.
- **Sending** (`packages/core/src/services/collection-run-service.ts`, shared by the desktop and the VS Code extension): each step reads the **saved** request and calls `RunService.start`, the path a send from a tab takes, so OAuth2, multipart, scripts and their `bru.sendRequest` calls, cookies, masking, the unmasked copies for Copy as cURL and history all behave the same. Requests a script sends stay inside their parent's result, so they are never steps.
- **Environment:** chosen in the runner and captured at the start: every step resolves against that environment by name (`EnvService.forRun(ctx, environment)`), whatever becomes active meanwhile. Values a step sets (extracted tokens, runtime and script variables, secrets, cookies) are stored as for any send, so later steps see them. Without an environment nothing is normally kept between sends; a run keeps runtime and script values in a scratch copy for its own steps instead.
- **Results** (`judge`): *passed* (tests ran, all passed), *failed* (a test or assertion failed or errored, a script failed, tests couldn't run on the response, or a request without tests got HTTP 400 or higher), *error* (outcome other than `http`: not sent, network, timeout), *no tests* (under 400, nothing to check; never counted as a pass), *cancelled*, and *skipped* for steps not run. Test counts are summed separately from request results.
- **Loop** (`runSequence`, `packages/core/src/engine/runner/collection-runner.ts`): sequential, no parallel sends. *Stop after the first failure* ends the run after a failed or errored step. Cancel aborts the step in flight through the same signal as its own Cancel and skips the rest. A step that throws (the file is gone, the environment was deleted) is an error.
- **Progress:** `runner:start` resolves with the steps and the end state (`completed`, `stopped`, `cancelled`); `runner:event` sends each step's start and end, with the full result. The UI adds each step to Dev tools as it goes (`runStarted`, `runFinished`, so script requests get their rows too) and refreshes an open tab's history. One collection run at a time.
- **Not in this version:** data files and iterations, scheduling, parallel runs, a report export.

## Response history

- SQLite (`node:sqlite`, built into Electron's Node — no native modules to compile) in the app data folder, never in the repository.
- Redaction happens **before** anything is written: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Amz-Security-Token` become `«redacted»`, and every known secret value becomes `«secret:name»` everywhere (URL, headers, bodies, console, test messages).
- Limits: runs per request (default 20), total size (default 500 MB, oldest first), body kept per run (default 2 MB, truncated on a character boundary and labelled).
- Export writes a versioned, redacted JSON file (`yept.history/1`) after a warning that bodies may contain customer data.

## Git

- Uses the installed `git` with argument arrays (no shell) and the user's credential helper; no terminal prompts.
- The source-control side panel replaces the collection tree while open. A repository picker appears only for workspaces with several repos. Shows changed collection files with an inline diff and stage/unstage controls; commits **only the selected files' working-tree content** (`git commit --only`, so unrelated staged work stays staged), pushes to the upstream or sets one after confirmation.
- Fetch updates upstream counts. Pull explicitly uses `--ff-only --no-rebase --no-autostash`; Sync runs fetch → pull → push and stops on failure. Both use the branch's configured remote/upstream. Branch switching uses existing local branches only and requires a clean whole repository. The UI also blocks switching with unsaved request drafts in that repository.
- Discard requires a UI confirmation. Tracked paths return to HEAD (index and worktree); new paths go through Electron's OS trash API. Main-process validation restricts selected paths to the workspace's collection folders and derives file metadata from fresh status, rather than trusting renderer input. Mutations in the same repo cannot overlap. Conflict or in-progress operation states direct users to their normal Git tool.
- Workspace reloads after pull/Sync, switch and discard use the existing external-change notifications. Clean tabs reload, dirty tabs keep their drafts and receive conflict choices. Reloads are serialized; the renderer checks draft state again after async reads to preserve edits made while loading.
- Never force-pushes, resets, stashes, cleans, rebases or creates merge commits. Git's own output is shown with plain-language notes for common failures.
- **Leak check** before every commit (and a warning on save): JWTs, literal `Bearer`/`Basic` credentials, literal values in credential fields, secret variables that have a value, and any value stored as a local secret. A commit with findings is blocked unless the user types the file name to confirm.

## Import and export

- Postman v2.1, Insomnia, OpenAPI 3 and bundled OpenCollection files go through one in-memory Bruno model, then a reviewable plan of YAML files, then a write (copy / skip / replace when the folder exists). Nothing is sent and scripts are converted, never run; Postman `pm.*` becomes `bru.*`.
- Credentials found during import become secret `{{variables}}` with the values stored locally.
- Bruno's Insomnia converter duplicates requests inside folders; the importer removes exact duplicates and reports how many.
- A Bruno `.bru` collection becomes a YAML copy in a new folder: an open read-only one through Convert to YAML, or (in the extension) any `.bru` folder on disk. The original folder is never changed.
- Export writes one bundled OpenCollection YAML, with or without environments; secret values are never included.
- The import service (`packages/core/src/services/import-service.ts`) keeps each plan in the host process; the UI sees only the preview, never file contents or secret values.

## Desktop shell

- Own title bar in the theme colours: Windows caption buttons are overlaid (`titleBarOverlay`), macOS traffic lights sit on the left. No visible menu bar on Windows (a hidden menu keeps editing and zoom shortcuts); the standard app, Edit, View and Window menus on macOS. There is no Reload, because it would drop unsaved drafts.
- Light or dark: System / Light / Dark via `nativeTheme.themeSource`; CSS follows `prefers-color-scheme`.
- Themes are built in (`packages/core/src/shared/appearance.ts`): Blue (the default `:root` tokens), Navy/Teal, Warm Paper and High Contrast. Each is a CSS token set in `styles.css` (`<html data-palette>`, light and dark), title-bar and window-background colours (applied by main when the theme or light/dark changes) and a pair of Monaco themes (`yept-<theme>-light|dark`). Navy/Teal overrides only the accent tokens and shares Blue's navy neutrals and title bar. `--accent` is the primary colour (buttons, active tab, links) and `--accent-soft` the light one (selection, active rows); the status colours (`--ok`, `--bad`, `--warn`, `--info`) keep their meaning in every theme. Unit tests check that the title-bar colours match the CSS tokens and that text on the accent colours reaches 4.5:1 in light and dark. The old default's id, `navy-teal`, is no longer a theme, so settings saved with it open in Blue.
- Fonts are the operating system's (Aptos / Segoe UI Variable, Cascadia Code), so nothing is bundled. The interface font, code font and code size are local settings. Choices are installed fonts only: the curated list shows those found on this computer (detected by measuring text against generic fallbacks), and any other installed font can be typed. Names are validated (letters, digits, spaces and `. _ ' -`) before they reach CSS, and the default stack always follows as fallback. Appearance changes apply at once (`app-settings:set-appearance`) without the Settings dialog's Save; the renderer applies them before its first paint.

## Local data

| Windows | macOS | Contents |
|---|---|---|
| `%APPDATA%\yept` | `~/Library/Application Support/yept` | `settings.json`, `preferences.json`, `local-environments.json` (secrets encrypted), `cookies.json` (persistent cookies, encrypted), `history.db`, `identity.db` |

Data from the previous name (folder `getnect`) or from pre-release builds (folder `vela`) is copied once on first launch; the old folder is left untouched.

## Dependencies and licences

- Every dependency must use a permissive licence (MIT, Apache-2.0, BSD, ISC and similar). `npm run check:licenses` regenerates and verifies `build/THIRD_PARTY_NOTICES.txt` offline. The inventory includes every installed lockfile package instance, including build dependencies because renderer bundles contain some of them; absent optional platform packages are reported and skipped. First-party workspaces share the root MIT licence.
- Notices retain complete installed licence files and supplemental credits (including Monaco and TypeScript's embedded-component notices). Packages that omit licence files need version-bound source records and checked-in texts in [build/licenses](../build/licenses/README.md). Standard terms supplied from a package's declaration are explicitly labelled. Unknown licences, missing terms and changed review evidence fail the check. An `OR` expression requires a permitted branch with terms; `AND` requires both. DOMPurify uses its Apache-2.0 option. The exact-version reviews for caniuse-lite's attribution-only data and tv4's public-domain grant are recorded separately.
- Packaging includes the project's `LICENSE.txt` and generated notices as resources. Electron and Chromium retain the runtime's `LICENSE.electron.txt` and `LICENSES.chromium.html` files separately.
- No native modules: SQLite comes from Node, so contributors need no compiler.
- The Windows installer is about 107 MB; the Electron runtime itself accounts for most of it.

## Multipart / form-data bodies

- **File format:** Bruno's `body.type: multipart-form` with `data` rows of `name`, `type` (`text` or `file`), `value` (a string for text; a list of paths for a file field, which may hold several files), optional `contentType`, `description` and `disabled`. A file with these rows round-trips byte for byte; per-row extras such as `description` are kept when the row is unchanged in place. `.bru` collections read the same fields from `@file(a|b)`.
- **File paths:** paths saved in the request file are relative to the collection folder, so teammates get the files through Git. A file outside the collection is never written to the request file: the picker (`requests:pick-files`, a main-process dialog) returns files inside the collection as relative paths and others as absolute paths, which are kept on this computer only in `identity.db` (table `request_files`, JSON per request id: field key → paths), next to *Don't send stored cookies*. The field key is the field name plus its position among fields with that name, so adding or moving other fields doesn't move the files. Duplicating a request copies them. Absolute paths that other tools wrote into a request file are kept as they are, flagged in the Body tab, with **Keep on this computer only** to move them to the local store.
- **Sending** (`packages/core/src/engine/runner/multipart.ts`): `prepare` fills in `{{variables}}` in field names, text values, content types and file paths, and fails for an enabled file field with no file. The runner then resolves each path against the collection folder and opens every file before anything is sent (OAuth2 token requests included); a missing, unreadable or non-file path is a `prepare_error` naming the field and the path. The body is Yept's own multipart encoder: part headers in memory, files streamed from disk on each send (a 401 re-send reads them again), with `Content-Length` from the sizes checked before sending. Yept sets the `Content-Type` and boundary, replacing any Content-Type header on the request. A file part without a content type gets one from its extension (`application/octet-stream` otherwise); a text part has none unless set.
- **What is recorded:** never file contents. `RunResult.requestBody` is a summary (field names, text values, file names, sizes and content types) and `RunResult.multipart` lists the parts with the local path each file was read from, for the Network view and Copy as cURL (`-F name=@"path";filename=…`, `--form-string` for text). Text values are masked and redacted like any other body; scripts see the text fields only.
- **Import:** Bruno's Postman converter keeps file paths from the export, often absolute paths on the exporting computer; its Insomnia converter turns file parameters into empty text fields. Yept turns those Insomnia fields back into file fields, leaves absolute paths out of the imported files and keeps relative ones (now relative to the collection folder), and lists both in the import preview. `.bru` conversion applies the same path rule.

## Known limits

- OAuth2 flows other than client credentials (authorization code, password, implicit) and refresh tokens and `bru.runRequest` are not implemented yet. The collection runner has no data files, iterations, schedules or parallel runs. `bru.sendRequest` can't send files (multipart text fields only).
- Bruno's binary file body (`body.type: file`), SPARQL and other body types Yept doesn't edit are shown read-only in the Body tab and kept unchanged when the request is saved. Sending such a request stops with an explanation; choosing another body type replaces the original when you save.
- Auth: no Kerberos/Negotiate, no proxy auth, no Digest `auth-int`, no NTLMv1. AWS Signature v4 doesn't read AWS profiles or AWS credentials from the environment, and doesn't make presigned (query-string) URLs. Copy as cURL with secrets copies the Digest or NTLM header that was sent, which the server won't accept a second time.
- Installers are unsigned (Windows SmartScreen warns; macOS needs the steps in [macos-build.md](macos-build.md)).
