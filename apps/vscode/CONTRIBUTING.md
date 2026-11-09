# Developing Yept for VS Code

Developer and test notes for the extension in `apps/vscode`. The store page is [README.md](README.md); release notes are in [CHANGELOG.md](CHANGELOG.md). See also the [architecture notes](../../docs/architecture.md) and [testing notes](../../docs/testing.md).

## Build and test

Use Node.js 24. The extension runs in VS Code 1.101 or newer; the tests use VS Code 1.144.0, downloaded on first run. From the repository root:

```sh
npm ci
npm run build --workspace yept-vscode
npm test --workspace yept-vscode
```

F5 with the **Yept Extension** launch configuration starts a development host. **Yept: Run Diagnostics** checks SQLite, system certificates, worker sandbox, QuickJS and Monaco workers.

The webview sends API messages to the extension host and makes no network requests. Local history, identity, preferences and environments live under VS Code's global storage. Environments work as in the desktop app: the status bar shows the active environment of the open request's collection (click it, or run **Yept: Select Environment**), and **Yept: Manage Environments** (also on a collection in the tree, or *Manage environments…* in the panel's environment list) opens the same editor. Shared values stay in the collection's `environments/*.yml`; overrides, secrets and TLS settings stay in global storage, with secrets encrypted by AES-256-GCM under a key kept in VS Code's secret storage (the operating system's keychain). Secrets are entered separately from the desktop app, which uses its own key.

Settings live under `yept.*` (automatic cookies, history size and body limit) and apply without a reload. Automatic cookies are on by default and stored encrypted; they stay off if the keychain can't be reached. In folders VS Code hasn't trusted (Workspace Trust), requests still send, but pre-request and post-response scripts, post-response vars, assertions and tests are reported as not run until the folder is trusted. In a remote window (WSL, SSH, containers, Codespaces) the extension shows a notice instead of its features. Scripts and tests use the same QuickJS sandbox as the desktop app.

The webview loads assets from `dist` with nonce-bearing scripts. Its build inlines shared workers for `worker-src blob:` and drops the separate worker files Monaco's language modes emit as a fallback, which the page never loads. Inline styles support React and Monaco, data images support response previews, and local fonts support Monaco icons. Desktop worker loading is unchanged.

Extension tests use temporary profiles and synthetic collections, start the local fixture server on a free port, and observe a real test panel. They check diagnostics, transport, send, response, visible and persisted history, cipher-free sending, workspace file integrity, tree changes, a local Git pull and multiple workspace folders. The history suite checks that the History view follows the active panel, lists 100 runs within 250 ms, opens and restores runs without saving, and opens a 48 MB body in an editor while the panel keeps answering. It turns off VS Code's proxy support (`http.proxySupport`), which slows a large download in the extension host to a few MB a second. The runner suite runs every sample collection under `fixtures/` through the extension and straight through core, and checks the results match. It also checks folder runs, one run at a time, cancel, and that Dev Tools loads and shows each send in Network and Console. The import and export suite imports each fixture format under `fixtures/import`, checks each conflict choice, that cancelling writes nothing, an export that imports back the same, and Paste cURL with a valid and an invalid clipboard. The leak check suite checks a warning's place, that a fix or a delete clears it, the check command's count, and the hook in throwaway Git repositories: it blocks a leaky commit and allows a clean one, follows `core.hooksPath`, and leaves an existing hook alone unless asked. The first run downloads the pinned VS Code runtime. If TLS is intercepted, set `NODE_USE_SYSTEM_CA=1`; keep certificate verification enabled.

Only Windows has been tested locally. VS Code theme mapping is future work.

## Behaviour notes

This development preview shows local workspace collections in the **Yept** activity-bar view. Select a request in the tree, or run **Yept: Open Request** and choose one by collection and path. Multiple workspace folders are supported; non-file folders are skipped. The panel uses the shared request editor and response pane: edit, send, cancel, and inspect past runs in History. Each request opens in its own editor tab, named after the request; opening it again brings its tab forward. The tab shows `●` while the request has unsaved changes, and **Ctrl+S** (**Cmd+S** on macOS) saves it. VS Code can't stop a webview tab from closing, so closing one with unsaved changes asks afterwards: **Save** writes them, **Don't Save** drops them, and **Cancel** reopens the request with them still unsaved. Tabs keep their page while hidden, so edits and responses survive switching tabs; each open tab holds its own page and code editor in memory.

The **History** view, below Collections, lists the past runs of the request in the active panel, newest first. Each entry shows the method, status, time and duration; the tooltip adds the URL, environment, size and tests. It follows the panel you last focused, and refreshes after a run and when the request is renamed, moved or deleted. Click an entry (or choose **Open Run**) to show that run's request and response in the panel, read-only, as the desktop's history list does. **Restore Request** puts that run's request into the panel's draft and keeps the request's name. The tab then shows `●`, and nothing is saved until you save.

**Run Collection** (on a collection in the tree, or from the Command Palette) and **Run Folder** (on a folder) open the collection runner in a panel. It is the desktop's runner: choose an environment, choose whether to stop after the first failure, then run. The saved requests are sent one at a time, in tree order, and each result shows as it arrives. Unsaved edits in open request panels are not sent; the runner says how many requests have them. One run goes on at a time. While the runner panel is hidden, the status bar shows the run's progress; click it to show the panel. Closing the runner panel cancels a run that is still going on. Each request goes to its history and to Dev Tools.

**Dev Tools** is a view in the bottom panel (**Yept: Show Dev Tools**). It has the desktop's Console, Network and Cookies tabs, for the sends of every request panel and of the runner. Performance is left out, because it shows the desktop app's own processes. Sends are kept from the start of the session, so the view shows them when you first open it. **Clear** forgets them. The Cookies tab shows the jar of the collection and environment of the panel you last focused. **Open request** opens the request's panel at that run.

**Import Collection** is in the Collections view's `...` menu and the Command Palette. Choose a file (Postman, Insomnia, OpenAPI or bundled OpenCollection), or a Bruno `.bru` collection folder, which is converted to YAML and left unchanged. Nothing is written until you accept the preview. It shows the format, the number of requests, folders and environments, where the collection goes, and any warnings. **Rename…** changes the collection name. If credentials are found, you choose which become secret `{{variables}}`, with the values stored as local secrets. If a folder with that name exists, choose **Import as a Copy**, **Keep Existing Files** or **Replace Existing Files**, as on the desktop. Nothing is deleted. The new collection is then selected in the tree. The import code is the desktop's, shared from core.

**Export Collection** is on a collection in the tree. It writes one OpenCollection YAML file, with or without environments, to a file you choose. Secret values are never included.

**Paste cURL** (on a collection or folder, or from the Command Palette) reads a curl command from the clipboard: bash, or Windows cmd as browsers copy it. You name the request, and it opens in its own tab. Nothing is sent, and files the command names are not read. If the clipboard doesn't hold a curl command, an error says why. Credentials in the command are saved in the request file as they are, and a warning says so.

The extension has no Git view of its own: use VS Code's Source Control. Yept adds the leak check the desktop runs before a commit, with the same scanner from core. It looks for literal tokens, credential fields with values, secret variables with values, and values stored as local secrets on this machine. Findings in collection files (`.yml`, `.yaml`, `.bru` and `.json` in each collection folder) show as warnings in the Problems panel, on the flagged value. Each warning says what was found and how to fix it: use a `{{variable}}` and keep the value as a local secret. The value itself is never shown. The check runs when the extension starts, when a collection file changes or is saved, and when a workspace folder is added or removed. A deleted file or a closed folder loses its warnings. It also runs in untrusted folders, since it only reads files, as the tree does. **Yept: Check for Leaked Secrets** runs it at once and reports the count.

**Yept: Install Pre-commit Leak Check Hook** adds the same check to a repository's `pre-commit` hook, so any commit (from Source Control, the terminal or the desktop app) of a collection file with a secret is blocked, with the findings. It writes the hook and a small checker, `yept-leak-check.cjs`, into the folder Git runs hooks from: `core.hooksPath` when it is set, else `.git/hooks`. The hook runs the checker with `node` when Node.js is on PATH, else with the VS Code that installed it, so it works with VS Code closed. It scans the staged version of every file in a folder holding `opencollection.yml` or `bruno.json`. Local secrets aren't checked there, as they are encrypted with a key only the extension can read. If the repository already has a `pre-commit` hook, Yept asks before adding its check to the top of it; a hook that isn't a shell script is left alone. Installing again updates the check. To skip it once, run `git commit --no-verify`; the desktop's **Commit anyway** is blocked by the hook too. To remove it, run **Yept: Remove Pre-commit Leak Check Hook**, which takes out only Yept's block and the checker. Or delete the lines between `# >>> yept leak check >>>` and `# <<< yept leak check <<<` and the `yept-leak-check.cjs` file. These two commands run Git, so they need a trusted folder.

The response pane has **Open in editor**. It opens the whole body in a read-only editor beside the panel, with JSON, XML, HTML or plain-text highlighting from the content type. The extension serves the document itself (`yept-body:`), so the body never goes through the page. A body over 2 MB of text reaches the page only as its first 2 MB, shown as raw text with a note and the same button: the page stays responsive with a body up to the 50 MB processing limit. The desktop uses the same 2 MB limit to stop formatting large bodies. **Copy** is hidden for such a preview, since it would copy only part of the body; copy from the editor instead.

Discovery uses the same engine as the desktop, including read-only `.bru` collections and warnings for unreadable files. The extension watches collection directories with chokidar and uses VS Code's workspace file watcher to discover collection markers added or removed elsewhere; VS Code's `files.watcherExclude` applies to that discovery watcher. Changes are debounced. If an open request is removed, its tab closes; with unsaved changes it stays open and offers to keep or drop them. For an externally changed open request, the existing shared editor reloads a clean draft and marks a dirty draft as conflicted.

## Size and performance

Measured on 2 November 2026 on Windows 11 with VS Code 1.144.0: a desktop with a 16-core 12th-generation Intel Core i9, 32 GB of memory and an SSD. Expect slower times on a laptop.

For watcher scope, `node --expose-gc apps/vscode/test/watcher-measure.mjs` creates 50,000 synthetic files in 100 source directories alongside the sample collection. Chokidar became ready in 63,445 ms with 50,111 watched entries for the whole workspace, and 168 ms with 8 entries for the collection alone. These are single measurements and do not include VS Code's discovery watcher or the engine's directory traversal. Memory measurements from sequential watchers were affected by garbage collection and are not comparable.

`npm run measure --workspace yept-vscode -- --tree` times showing the Collections view with the sample collection, across five launches: from the command that opens the view, which activates the extension, to the tree returning its top-level items (not the moment they're drawn). It took 391 ms (376–435). About 340 ms of that passes before the tree is registered: loading the 3.5 MB extension bundle and activating it. Loading the collections and returning the items takes about 35 ms. Showing the tree within 200 ms needs a smaller bundle to load first, with the request services loaded when a request opens.

### Package

`.vscodeignore` keeps only `package.json`, the README, CHANGELOG, licence, icons and the built `dist` files. Source maps, sources, tests, screenshots and `.vscode-test` stay out. Everything the extension runs is bundled, so the package has no `node_modules`. The build copies the repository's `LICENSE` to `LICENSE.txt` here (ignored by Git), where vsce and the registries look for it. To build and package a pre-release:

```sh
npm run build --workspace yept-vscode
npm run package --workspace yept-vscode
```

`npm run package` runs `vsce package --pre-release --no-dependencies --out out/yept-vscode.vsix` with a pinned vsce. vsce rewrites relative README links from `repository`. The README uses absolute links and image URLs, so the store page doesn't depend on that rewrite.

On 6 November 2026 the package was 6.57 MB (115 files, 28.5 MB unpacked). The table below is from an earlier measurement, at 5.81 MB (104 files, 25.4 MB unpacked); the extension host bundle has grown since, with import, export and the leak check. Dropping Monaco's unused fallback worker files saved about 2.1 MB packed and 9.2 MB unpacked.

| Part | Files | Packed (MB) | Unpacked (MB) |
|---|---:|---:|---:|
| Webview code editor chunk, loaded after the page: inlined TypeScript and HTML workers | 1 | 1.75 | 7.82 |
| Webview Monaco editor core, loaded with the code editor | 1 | 1.22 | 5.38 |
| Script sandbox worker, `worker.cjs` | 1 | 0.90 | 4.23 |
| Extension host bundle, `extension.cjs` | 1 | 0.83 | 3.51 |
| QuickJS wasm | 1 | 0.23 | 0.50 |
| Webview chunk with the inlined JSON and editor workers (`json.worker-*.mjs`, shared with diagnostics) | 1 | 0.20 | 0.68 |
| Webview page chunk: React and the shared UI | 1 | 0.14 | 0.62 |
| Webview Monaco syntax chunks, one per language, loaded on first use | 81 | 0.18 | 0.65 |
| Third-party notices and licence | 2 | 0.17 | 1.43 |
| Webview CSS, with the Monaco icon font inline | 1 | 0.14 | 0.43 |
| Webview Monaco language services, entries, `package.json`, README, manifests | 13 | 0.02 | 0.12 |

### Request panel open

`npm run measure --workspace yept-vscode` launches VS Code five times with one profile and the sample collection. Add `-- --vsix out/yept-vscode.vsix` to install and measure the package instead of this folder. In each launch it waits two seconds, then runs **Yept: Open Request** with the Login request's id: once for the first panel, then 5 times on a new panel after closing the previous one. Opening a request whose tab is already open only brings it forward, so it is not measured. The first launch has no id yet; it opens through the quick pick, answered at once, in a new profile.

The clock starts in the extension host just before the command runs. A test-only script added to the measured pages reports when the request editor is usable (the URL field shows the request and Send is present), then opens the Script section and reports when its editor shows the script. Times are when those reports reach the host, so they include a few milliseconds of messaging. Nothing is added to the shipped page.

Installed package, milliseconds, median (range):

| Open | Samples | Command returns | Usable | First editor shown |
|---|---:|---:|---:|---:|
| First panel, new profile | 1 | 336 | 936 | 1353 |
| First panel in a window | 4 | 267 (262–277) | 794 (756–934) | 1198 (1183–1338) |
| Same panel again (before one tab per request) | 50 | 24 (10–33) | 77 (61–109) | 438 (396–501) |
| New panel after closing one | 25 | 28 (12–54) | 108 (93–159) | 510 (474–560) |

The page loads 0.6 MB of script and shows the request. The code editor, with Monaco and its workers (14 MB of script), starts loading once the request is shown and the page is idle, so it is usually ready by the time a response arrives or a script is opened. The measurement opens the Script section as soon as the request is usable, so the first editor waits for that load: about 360 ms in a reused panel, most of it fetching the editor chunks. Each new tab loads its own page and editor. The first panel also includes starting the host services (the time until the command returns) and creating the webview, about 600 ms before the page starts.

Before the code editor loaded separately, the page loaded Monaco before showing the request: the same panel was usable in 390 ms (365–441), a new panel in 467 ms (434–595) and the first panel in a window in 1016 ms (1005–1046), with the first editor shown at 450, 532 and 1120 ms.

### Native collections actions and appearance

The Collections view offers **New Request**, **New Folder**, **New Collection**, **Open Collection** and **Import Collection**. Requests and folders can be added inside a writable collection or folder. Requests and folders can be renamed or moved by dragging them within one collection. Requests can also be duplicated. Delete asks for confirmation and moves the request or folder to the OS trash. An open request keeps its identity and history when renamed or moved. Empty views offer **Open Folder**, or **New Collection**, **Open Collection** and **Import Collection** when a local folder is open. The new request and folder commands offer to create a collection first when none is writable. Collection creation uses the selected workspace folder as its parent. If that folder is itself a collection, open its parent as a workspace folder to create another collection alongside it. Bruno `.bru` collections remain read-only.

Opening a collection checks its root marker and asks to add the folder to the VS Code workspace. VS Code owns workspace membership and trust; adding the first folder may restart the extension host. Cancelling any prompt leaves existing files alone. If a collection has already been created during the first-request flow, cancelling the subsequent request prompt keeps that collection.

The request panel uses VS Code webview colour and font variables, independently of desktop appearance preferences. Embedded Monaco follows light, dark, high-contrast dark and high-contrast light modes, exposed editor colours, font family, size and weight, including live updates. Its syntax colours inherit Monaco's built-in theme for that mode: the webview does not import arbitrary workbench TextMate grammars or semantic-token themes, so exact custom syntax-theme matching is not supported.

For reproducible headless rendering checks after building, run from the repository root:

```sh
node apps/vscode/test/webview-review.mjs <absolute-output-folder>
```

This uses an already installed Microsoft Edge in headless mode, real request services with synthetic local data, and supplied VS Code colour tokens. It checks live mode changes, font updates and independence from the OS light/dark preference. These screenshots cover the built request webview; they do not establish native workbench/sidebar appearance.

For native visual review, `node apps/vscode/test/review.mjs` launches an isolated development/test profile with synthetic sample collections and prints `REVIEW_DIRECTORY`. Write a built-in theme name (for example `Default Light Modern`, `Default Dark Modern`, `Default High Contrast`, or `Default High Contrast Light`) to that directory's `command` file to switch the running profile; write `done` to close it. Only use this with the existing cached VS Code test installation unless a download has been approved.

## Store screenshots

The README's screenshots are in `images/` and aren't packaged; the README links to them on GitHub. To capture them again on Windows after `npm run build`, run from the repository root:

```sh
node apps/vscode/test/screenshots/run.mjs apps/vscode/images 1486,123
```

It starts the cached VS Code test build with a throwaway profile, the synthetic `sample-travel` collection and the local fixture server, then captures `runner.png`, `request.png` and `environments.png` at 1600×1000. The second argument is where the runner's **Run** button is, measured from the window's top-left corner. Clicking it moves the mouse and briefly brings the window to the front. If the layout changes, run without it: the script then saves `runner-before.png`, where you can read the new position. Capture at 100% display scaling, and check every image for real data before committing it.

## Compatibility

The manifest declares no proposed APIs (`enabledApiProposals`), so other editors built on VS Code can load the extension. `engines.vscode` is `^1.101.0`. That is the first VS Code release whose runtime is Node 22, which `node:sqlite` needs. The source typechecks against `@types/vscode` 1.101.0, and vsce requires the types to be no newer than the engine. The extension tests run on VS Code 1.144.0 only. VSCodium follows VS Code releases. Cursor rebases onto VS Code with some delay, so it needs a build based on 1.101 or later.

## Pre-release publishing

`.github/workflows/vscode-prerelease.yml` runs when started by hand, or on a tag such as `vscode-v0.9.0`. It installs, typechecks, runs the unit tests and the extension tests (under `xvfb-run` on Linux), packages a pre-release VSIX and uploads it as an artifact. It then publishes the same VSIX to the Visual Studio Marketplace and to Open VSX. Each publish step is skipped when its secret isn't set, so the workflow can be run to build and check a package without publishing.

Before the first publish:

- The `publisher` in `package.json` must be the id of a Marketplace publisher you own. It is also the namespace on Open VSX.
- Add the repository secrets `VSCE_PAT` (an Azure DevOps personal access token with the Marketplace **Manage** scope) and `OVSX_PAT` (an Open VSX access token).
- On Open VSX, create the namespace and claim its ownership, so the extension shows as verified.

The Marketplace and Open VSX both treat the version as `major.minor.patch`. Publish pre-releases with odd minor versions or a separate range from releases, and raise the version for each publish: a version can only be published once.
