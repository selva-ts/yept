# Testing

## VS Code scaffold

Run `npm test --workspace yept-vscode` at the repository root, or `npm test` inside `apps/vscode`, for extension-host smoke checks using `@vscode/test-electron`. Root `npm test` continues to run the desktop/core unit suite. Root `npm run typecheck` checks both apps. See [extension development](../apps/vscode/CONTRIBUTING.md) for the pinned runtime, isolated test profile and F5 instructions. Automated host checks and an actual F5/webview render check are separate evidence.

## Automated checks

| Layer | Command | What it covers |
|---|---|---|
| Types | `npm run typecheck` | The whole project (main, preload, renderer, engine, shared). |
| Licences | `npm run check:licenses` | Offline declaration policy, licence text and source checksums, package versions, project copyright and generated notice coverage. |
| Engine unit tests | `npm test` | Workspace and files, identity, variables and environments, runner pipeline, network recording (hops, timings, TLS details), cookie jars and `bru.cookies`, sandbox, `bru.sendRequest` (call and return shapes, scripts converted from Postman, limits, cancel), history and redaction, Digest/NTLM/AWS Signature v4 auth (MD4 against RFC 1320, NTLMv2 against MS-NLMP 4.2.4, Digest against RFC 2617 and 7616, SigV4 against cases from the AWS test suite, and each mode sent to the fixture server, inherited and in a collection run), the collection runner (tree order, judging and counting results, stop on failure, cancel, a login → create → read → delete run through the pipeline, iterations, delay and cancel during it, CSV and JSON data files and their edge cases, row values over environment values for one iteration only, JUnit XML that is well formed and escaped, HTML reports with no secret values or outside assets), Git, leak check, import/export, URL params, cURL export, code snippets for the other languages (quoting and escaping per language, masked values kept masked; `snippets-run.test.ts` runs the fetch and axios snippets on Node against the fixture server, and the Python, PowerShell 7 and C# ones where `requests`, `pwsh` or the .NET 10 SDK is installed, skipping them otherwise) and a corpus of pasted cURL commands (bash and Windows cmd) read back into requests. |
| End-to-end | `npm run e2e` | Builds the app, then drives the real Electron app with Playwright. |
| Packaged app | `Yept --self-test` | Headless checks inside the installed build. |
| By hand | [ui-test-checklist.md](ui-test-checklist.md) | Looks, keyboard, accessibility, Windows/macOS integration. |

## Unit tests (Vitest)

- Run in plain Node against temporary folders; nothing outside the system temp directory is touched.
- Git tests create real temporary repositories with a bare remote (selected-file commits, staging, discard through an injected trash callback, fast-forward pull/Sync, divergence, dirty-file protection, branch switching, conflict handling and non-origin upstreams). Service tests cover scope validation, mutation serialization and branches that remove collections. Renderer-state tests cover edits made during external reload and duplicate notifications.
- Handler tests construct the application in plain Node with a synthetic host, checking dispatch, unknown channels, errors, cancelled dialogs, clipboard and appearance persistence. Host tests cover IPC error formatting and detachment, dialog parenting, event delivery, metrics, theme and the existing safeStorage ciphertext format and failure behaviour. Service tests reopen encrypted secrets and cookies through an injected cipher. A source-boundary test rejects Electron imports outside the desktop host, including type imports and tooling.
- The history tests scan the raw database files to prove no secret value is stored.
- Licence inventory tests use synthetic temporary packages to check expression selection, missing terms and packages, duplicate versions, optional platform packages, supplemental credits, source checksums and review invalidation.
- The markup tests cover HTML and XML detection, the expected formatted output and the policy put in front of the HTML preview.
- The JSONPath tests cover names, indexes, slices, wildcards, recursive descent, filters, invalid expressions (a message, never an exception), a 200,000-item array, the match cap and deep nesting. The response-file tests cover `Content-Disposition` names (`filename*`, quoting, path parts, reserved names) and which types are previewed; the history comparison tests cover changed rows, header changes, JSON formatting and that only stored, redacted values appear. The extension's response tools test sets a runtime variable and checks the next request sends it while no file holds it, stores a local secret and checks only the encrypted store has the value, and saves the fixture's `/binary` body and compares it byte for byte.
- Skipped automatically when a tool is missing: the self-signed HTTPS tests need `openssl` on `PATH` (it ships with Git for Windows).

### Opt-in: your own collections

Point the tests at a folder of real collections or exports. They are read or converted into a temporary folder; nothing is written back or copied into the repository.

```bash
YEPT_REAL_COLLECTIONS=/path/to/collections npx vitest run packages/core/src/engine/workspace/real-collections.test.ts packages/core/src/engine/import/import.test.ts
```

On Windows PowerShell: `$env:YEPT_REAL_COLLECTIONS = 'C:\path\to\collections'` first. Never add real collections, tokens or internal hostnames to this repository.

## End-to-end tests (Playwright + Electron)

Each suite launches the app with an isolated profile (`YEPT_USER_DATA` pointing at a temporary folder) and a copy of `fixtures/collections`, so your own settings, secrets and history are never touched. Screenshots go to `e2e/out/` (git-ignored); a failing suite also saves a `*-99-failure.png`.

| Suite | Covers |
|---|---|
| `e2e/home.mjs` | Collections home: grid/list (and that nothing shifts), search, restore after restart, New collection (staying on Home), the tile menu (closing on an outside click) and Move to Recycle Bin, folder tree (keyboard, remembered state), `{{variable}}` colouring, long URLs, the ☰ menu, footer, About, light/dark mode. |
| `e2e/requests.mjs` | Open, create, edit, save and send; every outcome type (HTTP error, network, timeout, cancel); external file change and conflict; rename; command palette; Paste cURL from the menu and the command palette (preview, notes, sending the new request); dark theme. |
| `e2e/environments.mjs` | Environments and local secrets, login → token extraction → protected call, environment switching, failed login clears the token, "Store as local secret", the sample ASP.NET API over `https://localhost`. |
| `e2e/history-tests.mjs` | Tests and assertions (passed, failed, error, runaway script), response history (restart, rename, redaction on disk), orphaned history, history limits. |
| `e2e/git-import.mjs` | Git panel against a temporary repository and bare remote (diff, selected-file commit, push, rejected push), leak check, Postman/Insomnia/OpenAPI import, `.bru` conversion, export. |
| `e2e/git-sync.mjs` | Source-control side panel, multiple repositories, fetch counts, fast-forward pull, clean-tab reload and dirty-draft protection, local branches, stage/unstage, cancelled/confirmed discard and Sync to a bare remote; a teammate's rename (moved and edited) pulled with the open tab following it. |
| `e2e/devtools.mjs` | Dev tools drawer (footer button, Ctrl+Shift+J, remembered tab), Console lines and filters, Network rows, redirect chain, headers sent, timing and connection, masked values and reveal, Copy as cURL with and without secrets, Copy as C# and PowerShell (masked, and with secrets only when ticked), the raw HTTP view (request and status lines, masking, Copy, with secrets on the last hop only, cookie values on request), automatic cookies across a redirect, the Cookies tab (add, edit, delete, clear), "Don't send stored cookies", Performance. |
| `e2e/script-requests.mjs` | `bru.sendRequest` in a pre-request script: a login whose token the request uses, the callback form with a 404, Console lines, Network rows marked *script* with links both ways, the client secret masked and Copy as cURL with secrets, the Timeline, one history entry with no secret on disk, Cancel, and the shared 5 s script limit. |
| `e2e/collection-runner.mjs` | The collection runner from the collection page, a folder's menu and the home page's ⋯ menu: the plan in sidebar order, an environment chosen in the runner without changing the active one, login → list → create → read → delete with extracted values, results per request (passed, failed, error, no tests) and counts that keep request errors apart from failed tests, details with reasons and tests, one Dev tools row per request plus a script's `bru.sendRequest` linked to it, history entries, stop on failure, the saved request sent rather than an unsaved draft, Cancel, closing the runner while it works and reopening it from the footer. A 3-row CSV data file (BOM, quoted values) against the fixture server's `/echo`: three iterations, a delay between requests, results grouped by iteration, JUnit export checked with the renderer's XML parser, an HTML export, and the environment's value back once the file is removed. |
| `e2e/auth-modes.mjs` | Digest, AWS Signature v4 and NTLM: each picked in the Auth tab and sent to the fixture server, the local-secret hint for a literal password, the 401 and the second send in Network (*sent again after 401*), `Authorization` and `X-Amz-Security-Token` masked in Network and in Copy as cURL, a wrong NTLM password ending with the 401, the saved Bruno file. |
| `e2e/oauth2.mjs` | OAuth2 client credentials and password, token status, renewal after a 401, Get token and Forget token, masking, local secret references in the saved file and authorization code with PKCE via the loopback callback. The browser open is intercepted so the test follows the fixture redirect directly. |
| `e2e/multipart.mjs` | Multipart bodies: the Body tab's Multipart table, text and file fields, the file picker (a file inside the collection shown relative to it, one outside marked this computer only), both files arriving intact, the Network summary without file contents, Copy as cURL with `-F`, the saved Bruno file without the outside path, a missing file stopping the send, the local file kept after reopening. |
| `e2e/response-html.mjs` | HTML and XML response bodies: Pretty indents and highlights HTML, Raw is the body as received, Preview renders in a fully sandboxed frame with its inline styles, the page's script, links, form, refresh, image, stylesheet and frame cause no request and no navigation, light and dark, XML indented without HTML rules, Preview kept for the next HTML response, Copy in Preview. |
| `e2e/response-tools.mjs` | Response tools: the JSONPath filter (matches, an invalid expression shown inline, clearing it), Set as variable from the filter's match as a runtime variable used by the next request and as a local secret (declared in the environment file, value only in the encrypted store, masked in the dialog), Save to file with the dialog stubbed (named from `Content-Disposition` or the URL, `/download` and `/binary` saved byte for byte), image and PDF preview in a fully sandboxed frame with no request to the server or anywhere else, and comparing two history runs of `/changing` (the changed header listed, cookies still `«redacted»`, the body diff). |
| `e2e/appearance.mjs` | Themes (CSS tokens, window colours, Monaco) in light and dark, `{{variables}}` in the theme's primary colour in inputs and the body editor, the ☰ menu and footer, installed-font choices, a missing font flagged and falling back, code size in editors, an unusable font name in `settings.json` ignored, everything kept after a restart, Reset appearance. |
| `e2e/about.mjs` | About shows the version and third-party notices. |

Run one suite after `npm run build`, e.g. `node e2e/git-import.mjs`.

### Test servers

The OAuth2 fixture's `GET /auth/authorize` issues a one-time code bound to the redirect URI and S256 challenge. Add `?wrong_state=1` to simulate a bad callback. `POST /auth/token` checks client credentials, the password grant, the authorization code and verifier, and refresh tokens. `?reject_refresh=1` rejects a refresh and `GET /auth/stats` counts exchanges by grant.

- **Fixture API** (`fixtures/server/server.mjs`, started by the suites; manually `npm run fixture-server` on port 4010): deterministic routes for every status, slow and hanging responses, large bodies, redirects, echo, cookies (`/cookies/set`, `/cookies/echo`, `/cookies/redirect`), and a login → token → protected route flow. With a token, `/bookings` lists and creates bookings, and `/bookings/{id}` reads one or deletes one created in this server's lifetime (then 404). The token endpoint (`/auth/token`) takes client credentials in a Basic header or the form body, `?expires_in=N` sets the token lifetime, `/auth/revoke` invalidates every token and `/auth/stats` counts token requests. `POST /upload` parses a multipart body and describes each part (name, text value or file name, size, content type and a SHA-256 of the file bytes, never the bytes); `/upload/last` returns the last one. `/html` is a page that tries to run a script, refresh, and load an image, stylesheet and frame from `/html/hit/*`, which count requests (`/html/stats`); `/xml` is a small RSS feed. `/auth/digest` answers with a Digest challenge (qop `auth`; `?algorithm=SHA-256`, MD5 by default) and accepts the fixture user's answer; `/auth/ntlm` runs an NTLM handshake and accepts an AUTHENTICATE only on the connection that got the challenge; `/auth/aws/...` (any method, query and body) checks an AWS Signature v4 made with the fixture's access key and secret. These live in `fixtures/server/auth-schemes.mjs`, with code that shares nothing with the app, and the credentials are exported for the tests. `/media/image.png` is a 24×16 PNG and `/media/doc.pdf` a one-page PDF, both generated by the server (also exported as `fixturePng()` and `fixturePdf()`); `/download` returns the `/binary` bytes with `Content-Disposition: attachment; filename="sample-export.bin"`; `/changing` returns a new `X-Run-Count` header, `Set-Cookie` and body on every call, for comparing runs. No external network.
- **Sample ASP.NET Core API** (`samples/SampleApi`, .NET 10): `POST /auth/login` and `GET /api/me` over `https://localhost:7443` with the development certificate. Used by `environments.mjs` when `dotnet` is installed; skipped otherwise. The suite builds it before starting it, so a fresh checkout needs no separate build step; trust the development certificate once with `dotnet dev-certs https --trust`.

## Packaged app

```bash
npm run package:win
dist/win-unpacked/Yept.exe --self-test
```

The self-test checks `node:sqlite`, a YAML round-trip, the OS certificate bundle, the script sandbox (including `bru.sendRequest` through the packaged stand-in, stopping a runaway script and `bru.cookies` on a cookie jar), the import converters and Git, and exits non-zero on failure. To run the About check against the packaged app, set `YEPT_PACKAGED_EXE` to the full path of `Yept.exe` and run `node e2e/about.mjs`.

For macOS, see [macos-build.md](macos-build.md).

## Antivirus and TLS interception

Some antivirus products re-sign all TLS traffic, including the Electron download during packaging and connections to `localhost`. The app trusts the operating system's certificate store, so requests still work. For npm and electron-builder, set `NODE_USE_SYSTEM_CA=1` so Node uses the system store too. The CA-file unit test detects interception and skips with a note rather than reporting a false result.

## GitHub Actions

[Desktop validation](../.github/workflows/ci.yml) runs for pull requests and pushes to `main`. Each job installs the lockfile with Node 24, explicitly downloads the pinned Electron runtime, then runs typecheck, unit tests, the licence check and packaging.

| Job | Runner | Additional checks |
|---|---|---|
| Windows x64 | `windows-2025` | Builds the .NET 10 sample, trusts its public development certificate in the ephemeral runner's machine certificate store, checks HTTPS from Node and Electron using the engine's TLS options, runs all E2E suites, then checks the packaged self-tests and About. |
| macOS arm64 | `macos-15` | Builds native arm64 DMG and ZIP packages. |
| macOS x64 | `macos-15-intel` | Builds native Intel DMG and ZIP packages. |

Unit tests use `--maxWorkers=1` to reduce load on the short script-sandbox deadlines. Failures stop the job; the workflow does not automatically rerun or hide them. Matrix jobs finish independently so one platform's failure does not cancel the evidence from the others. Local validation commands above remain applicable.

The preflight checks that the exported fixture certificate is included in the engine's trusted anchors and retains certificate fingerprints and connection errors for diagnosis. HTTPS verification remains enabled. The certificate is public and exists only on the ephemeral runner; no private key is exported or retained.

Electron's BoringSSL needs partial-chain support for trusted self-signed server certificates whose key usage omits certificate signing, including ASP.NET development certificates. The engine restricts its trust anchors to self-signed certificates suitable for server authentication before enabling that support. Cached intermediate certificates are not independent anchors; servers must supply their intermediate chain. The TLS regression suite runs in both Node and Electron over in-memory streams so antivirus interception cannot hide failures. It covers trusted certificates, full chains and PEM bundles, and rejection of untrusted certificates, wrong hostnames, expiry, client-only usage, incomplete chains and certificates signed by a non-CA server certificate. An environment's CA file without a usable self-signed root is rejected with an explanation.

Actions are pinned to reviewed commit SHAs. The workflow uses a read-only repository token, does not persist checkout credentials and does not receive signing secrets. The Git tests use synthetic local repositories and bare remotes. Ordinary validation jobs build packages without publishing them or retaining the installer archives.

Each job uploads `out/ci` diagnostics for seven days, including the command logs and Windows packaged results. A failed Windows packaged check also retries the self-test with several launch methods and records only the environment variable names. Failed Windows jobs also retain E2E screenshots for three days. These uploads use synthetic test data; profiles and credential stores are excluded. Logs printed before the workspace is available remain in the Actions job log.

### Manually approved tag builds

[Approved tag packages](../.github/workflows/release.yml) is a separate manually dispatched workflow. It does not start on a tag push and does not create tags or GitHub Releases.

1. Use a reviewed commit already on `main` and an existing tag exactly matching `v` plus the stable version in `package.json`, for example `v0.9.0`. Branch refs, prerelease suffixes, mismatched versions and tags on unmerged commits are rejected.
2. In Actions, choose **Approved tag packages**, click **Run workflow**, select that version tag in the ref selector and tick the explicit build-approval checkbox. Selecting a branch or leaving approval unticked fails verification.
3. The verification job checks the manual event, approval, tag, checked-out commit and `origin/main` ancestry. Only a successful verification can call the same Windows/macOS validation and packaging jobs used for pull requests.
4. Successful tag jobs retain installer/DMG/ZIP files, the project licence and third-party notices as Actions artifacts for one day. Download them before expiry. Artifact retention is not a public release or a signing guarantee.

GitHub Free does not provide required-reviewer environment gates for private repositories. The manual dispatch and explicit checkbox are the current approval mechanism, rather than an independent reviewer gate. See [GitHub's environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) and the [code signing policy](code-signing.md). A different approval mechanism requires an explicit configuration change.

Workflow syntax and helper checks can be validated locally. Hosted Windows and macOS results are verified only after the workflow branch is pushed and its pull-request checks run. Publishing and signing are separate from these package builds.
