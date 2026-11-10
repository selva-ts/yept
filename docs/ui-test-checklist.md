# Yept UI test checklist

Manual checks to run before a release. `npm run e2e` already covers the main flows (see [testing.md](testing.md)); this list covers what automation can't see: looks, keyboard, accessibility, Windows integration and edge cases. Mark each row Pass/Fail and note the build (dev or installer hash).

## Setup

Use a **copy** of the fixture collections so test edits never touch the repo:

```powershell
$ws = "$env:TEMP\yept-ui-test"; Remove-Item $ws -Recurse -Force -ErrorAction Ignore
Copy-Item fixtures\collections $ws -Recurse
npm run fixture-server          # terminal 1: http://localhost:4010
npm run dev                     # terminal 2: dev build
```

For the installed build, run `dist\Yept-Setup-0.9.0.exe` instead of `npm run dev`. To start from a clean profile, rename `%APPDATA%\yept` first (rename it back afterwards; it holds your local secrets and history).

## A. Home

| # | Check | Expected | Result |
|---|---|---|---|
| A1 | First launch with no workspace | Home shows the mark, **Start with your collections** and **Open folder…**; no empty editor | |
| A2 | Open the copied workspace | 3 tiles: Sample Travel, DummyJSON, Sample ASP.NET; request/folder counts match the sidebar tree | |
| A3 | Restart the app | Home appears again with the same workspace | |
| A4 | Search `dummy`, then `zzz` | One tile; then **No matching collections** | |
| A5 | Switch to **List**, restart | List view kept. `%APPDATA%\yept\preferences.json` has only `lastWorkspace` and `collectionViewMode`; no collection file changed (`git status` clean in a Git workspace) | |
| A6 | Tile **⋯** menu | Collection settings, Environments and Export open the right dialog for that collection; clicking outside the menu, pressing Esc or opening another tile's menu closes it | |
| A10 | Tile **⋯ → Move to Recycle Bin**, then the same from the sidebar's collection right-click menu | Asks first (and warns about unsaved edits); the folder goes to the Recycle Bin and can be restored; its open tabs close and Home shows the remaining collections | |
| A7 | Workspace with one collection; empty folder | Layout still looks deliberate; empty folder shows **No collections yet** | |
| A8 | Add a `bruno.json` collection to the workspace | Tile shows the `.bru · read-only` badge; **⋯ → Convert to YAML** opens the import preview | |
| A9 | Put a broken `opencollection.yml` in a collection | Home shows the "could not be read" note; no crash | |

## B. New collection

| # | Input | Expected | Result |
|---|---|---|---|
| B1 | `Fresh API` | Stays on Home with a "Created" message; the new tile appears; `Fresh API\opencollection.yml` exists | |
| B2 | `fresh api` (case only differs) | "already exists"; nothing written | |
| B3 | `../outside`, `a/b`, `CON`, `name.`, `a:b` | Rejected with a clear message; no folder created anywhere | |
| B4 | Open a single collection folder as the workspace, then New collection | "Open a parent workspace folder…" | |
| B5 | Open the new collection in plain Bruno | Bruno loads it | |

## C. Inside a collection

| # | Check | Expected | Result |
|---|---|---|---|
| C1 | Open a tile | Sidebar shows only that collection; breadcrumb `Collections / <name>`; overview with New request, New folder, Environments, Collection settings | |
| C2 | **+ New request**, **New folder** from the overview | Created in that collection; request opens in the editor | |
| C3 | Edit a request URL (don't save), go Home, open another collection, come back | Draft and dirty marker still there | |
| C4 | **Ctrl+K** on Home and in a collection; pick a request from another collection | Switches collection and sidebar to it | |
| C5 | Click a tab that belongs to another collection | Sidebar and breadcrumb follow the tab | |
| C6 | Close the window with an unsaved draft while on Home | "Unsaved changes" prompt | |
| C7 | Edit an open, clean request file in Notepad while on Home or in another collection | Reloads silently. With a dirty draft: conflict prompt | |
| C8 | Open folder… with a dirty draft | Warns before discarding drafts | |
| C9 | Send Login then List bookings (fixture server running) | Token extracted, 200 | |
| C10 | Git, Import, Settings, environment switcher | Reachable from the collection view and working | |

## D. Look, keyboard and accessibility

| # | Check | Expected | Result |
|---|---|---|---|
| D1 | Windows light and dark mode (Settings → Personalisation → Colours) | Both themes readable: tiles, sidebar, tabs, dialogs, Monaco, response pane, Git diff | |
| D2 | Resize to the minimum 900 × 560 | Grid drops columns; list readable; no clipped buttons | |
| D3 | Display scaling 125%, 150%, 200% | Text crisp, no overlap; icon sharp in the title bar | |
| D4 | Keyboard only: Tab through Home | Visible focus on search, Grid/List, every tile, ⋯ menu, buttons; Enter/Space activates | |
| D5 | Narrator (Ctrl+Win+Enter) on Home | Tiles read as "Open <name>"; ⋯ as "More actions for <name>"; Grid/List announce pressed state | |
| D6 | Windows high-contrast theme | Controls and focus remain visible | |
| D7 | Method colours GET/POST/PUT/PATCH/DELETE; error, warning, selection states | Consistent and distinguishable in both themes | |
| D8 | Title bar | Theme-coloured (not the Windows accent colour), shows `Yept · Collections` or the collection name; minimise/maximise/close match the theme and follow a live light↔dark switch; drag moves the window, double-click maximises, Windows snap layouts appear on hovering maximise | |
| D9 | No menu bar (Alt does nothing visible) | Ctrl+C/V/X/Z/A work in fields and editors; Ctrl+= / Ctrl+- / Ctrl+0 zoom; F11 full screen; Ctrl+R does **not** reload | |
| D10 | Status bar (bottom) | Workspace path; in a Git repo `⎇ branch ↑ahead ↓behind · N changed` (click opens Git), otherwise "Not in a Git repository"; on Home the collection count, in a collection the active environment, updating when you switch it | |
| D11 | ☰ menu (click or a lone Alt) | Open folder, Import, New collection, Git, themes, light/dark modes, Settings, About, Exit; arrows move, Esc closes, disabled items without a workspace | |
| D12 | Light/dark from menu, footer (☀/☾/◐) and Settings | Applies at once to the page, editors and caption buttons; survives restart | |
| D13 | `{{variables}}` in URL, params, headers, form, auth and body | Resolved in a shade of the theme's primary colour in every theme, light and dark (blue, teal, orange-brown in Warm Paper, green in High Contrast), also in the body editor and the resolved URL line; secret amber (violet in Warm Paper), missing red wavy (crimson in Warm Paper), `{{$guid}}` in a colour of its own (purple in Blue); colours update when you switch environment; text and caret stay aligned while typing, scrolling a long URL, and at 125–200% zoom | |
| D14 | Sidebar tree | Connector lines show which folder each request is in; ←/→/↑/↓/Enter work; right-click Expand all / Collapse all; collapsed folders stay collapsed after Home and restart | |
| D15 | New request / folder / collection name prompt | The default name is selected; typing replaces it immediately | |
| D16 | Workspace with same-named collections in different folders (e.g. a folder holding two copies of `fixtures/collections`) | Home groups tiles by folder with a "same name elsewhere" badge; breadcrumb and title bar show the folder | |
| D17 | Paste a very long URL | Send/Save stay visible; the URL scrolls inside its box; the resolved line ends in … and shows the full URL on hover | |
| D18 | Switch Grid ↔ List repeatedly, with a few collections and with enough (6 or more) that only List needs to scroll | The Grid/List buttons, heading and tile icons don't move sideways | |
| D19 | Each theme (Blue, Navy/Teal, Warm Paper, High Contrast) in light and dark | Readable everywhere: Home, sidebar, tabs, dialogs, Monaco, response pane, Dev tools, Git diff; caption buttons and title bar match; no flash of another theme on start; 2xx stays green and errors red | |
| D20 | High Contrast with keyboard only | Focus outline clearly visible on every control; selected tree row and tabs distinguishable | |
| D21 | Settings → Interface font / Code font | Only installed fonts listed; the choice applies at once to the interface or editors; **Other installed font…** with a made-up name shows the "isn't installed" note and the default font | |
| D22 | Code font size 16, restart, then **Reset appearance to defaults** | Editors use 16 px after restart; reset restores Blue, System, default fonts and 12.5 | |

## E. Installer and Windows integration (installed build only)

| # | Check | Expected | Result |
|---|---|---|---|
| E1 | Run the installer | Yept icon on the installer; SmartScreen warning expected (unsigned); install directory choice offered | |
| E2 | Start menu, desktop shortcut, taskbar (light and dark taskbar) | Yept mark everywhere; no Electron icon | |
| E3 | Settings → About | Version 0.9.0, Electron/Node versions, notices | |
| E4 | Upgrade from an earlier release (data in `%APPDATA%\getnect`, or `%APPDATA%\vela` from a pre-release build) | First launch copies it to `%APPDATA%\yept`; environments, local secrets and history are still there; the old folder is left untouched | |
| E5 | `"%LOCALAPPDATA%\Programs\Yept\Yept.exe" --self-test` | 9/9 PASS, exit code 0 | |
| E6 | Apps → Installed apps → Yept → Uninstall | Uninstaller shows the icon; app removed; `%APPDATA%\yept` kept | |
| E7 | Install on a second PC with no dev tools | Launches, A1–A3 and C9 pass | |

## F. Dev tools and cookies

| # | Check | Expected | Result |
|---|---|---|---|
| F1 | **Dev tools** in the footer, then Ctrl+Shift+J | Drawer opens and closes; dragging its top edge resizes it; height and last tab are kept after a restart | |
| F2 | Send an `https://` request on a machine with antivirus web protection | Network → Connection shows TLS version, cipher and the antivirus root as **Issued by** | |
| F3 | Fixture server: `/cookies/set?sid=a&max-age=3600` and `/cookies/set?tmp=b`, restart Yept | Cookies tab keeps `sid` (with an expiry date), `tmp` is gone | |
| F4 | Open `%APPDATA%\yept\cookies.json` in Notepad | No cookie names, values or hosts in plain text | |
| F5 | Store a cookie with environment `local`, switch to no environment | Footer count and Cookies tab change; the cookie isn't sent until you switch back | |
| F6 | Settings → turn off *Store and send cookies automatically* | Cookies tab says automatic cookies are off; no cookies sent or stored until turned on again | |
| F7 | Keyboard only through the drawer: tabs, filters, Network rows, cookie Edit/Delete | Visible focus everywhere; Enter/Space activates | |
| F8 | Window at the minimum 900 × 560 with the drawer open | Editor still usable; drawer tables scroll instead of overflowing | |
| F9 | Network → a request with a bearer token → **Raw** | `GET /path HTTP/1.1` then header lines; `Authorization: ••••••`; the reconstruction note shows; long lines scroll sideways | |
| F10 | Raw response with `Set-Cookie`; **Copy**, then *Show cookie values* and **Copy** | First copy has the values masked, the second has them; **…with secrets** on the request includes the token (last request of a redirect chain only) | |
| F11 | Import a Postman collection whose pre-request script logs in with `pm.sendRequest`; send a request | The login runs; Network shows it as a **script** row; *Show the run that sent it* and **Scripts sent** move between them; the client secret and token are masked in Console and Network | |
| F12 | A pre-request script calling `bru.sendRequest` on a slow endpoint; press **Cancel**, then send and wait | Cancel stops at once (Cancelled); otherwise the script stops after 5 s saying it was waiting for `bru.sendRequest`; the script row shows Cancelled | |

## G. Source control (use a disposable collections repository)

| Check | Expected | Result |
|---|---|---|
| Open Git from the collection view and footer; close with × | Source-control panel replaces the collection tree; request editing stays available; closing restores the tree | |
| **New branch…** on a clean repository, then with a changed file | Creates the branch from the current commit and switches to it; refused with a clear message when the repository has changes, the name is invalid or already exists | |
| Open a Git repository folder that holds no collections yet | The panel still shows its branch, Fetch, Pull and Push, and says there are no collections yet | |
| Light/dark, minimum 900 × 560, keyboard navigation | Branch, action buttons, file selection, diff, output and Close remain reachable and readable; content scrolls | |
| Workspace with two repositories | Picker appears; selection, diff, commit message and output do not carry into the other repository | |
| Fetch, Pull and Sync against a hosted test branch with saved credentials | Ahead/behind counts update; fast-forward Pull reloads clean tabs; Sync fetches, pulls, then pushes; hosted credential handling works | |
| Dirty request draft while another checkout changes its saved file; Pull | Draft remains; reload/keep choice appears. Branch switching stays unavailable with unsaved drafts or repository changes, including outside collections | |
| Stage/unstage, commit selected files with other work already staged | Only selected paths change in the index or commit; other staged work stays staged; secret detection still blocks unsafe commits | |
| Cancel discard, then confirm for a tracked file and a new file | Cancel leaves files unchanged; confirm restores tracked content/index to HEAD, and the new file can be recovered from the Windows Recycle Bin | |
| Diverged branch or external conflict/unfinished merge | Yept explains the failure and directs you to your normal Git tool; no forced push, stash, rebase or merge commit | |
| A teammate renames and edits a request you have sent before (open in a tab); Pull | The output lists the rename; the tab stays open on the new name; its History keeps the earlier runs | |
| Switch to a branch where a request was renamed, then back | History and the open tab follow both ways | |

## H. OAuth2 client credentials

| Check | Expected | Result |
|---|---|---|
| A team or vendor API with client credentials, secret stored as a local secret | First send gets a token; later sends say "cached token"; the Auth tab shows expiry and scope | |
| Switch environment | The token panel names the new environment; no token is shared between environments | |
| Restart Yept | The Auth tab shows no token; the next send gets one | |
| Open the same collection in Bruno after saving | Bruno shows the OAuth2 client credentials settings unchanged | |
| Wrong client secret; Get token | The token endpoint's error is shown; the secret appears nowhere in the response, timeline or Dev tools | |

## H2. Digest, NTLM and AWS Signature v4

| Check | Expected | Result |
|---|---|---|
| A test server with Digest auth (for example a local nginx or IIS with Digest), password stored as a local secret | 200; Network shows the 401 and the second send, `Authorization` masked | |
| An IIS site with Windows authentication (NTLM only), from a Windows machine | 200 with the right user; a wrong password ends with 401 | |
| An API Gateway or S3 test bucket in a sandbox account, keys as local secrets; a GET with a query, then a PUT with a JSON body | Both accepted; with temporary credentials, the session token works and is masked | |
| Open the same collection in Bruno after saving each mode | Bruno shows the same settings, and the AWS profile name is unchanged | |
| Import a Postman and an Insomnia export using these modes | The modes come across; literal passwords and secret keys are offered as local secrets | |

## I. Multipart / form-data uploads

| Check | Expected | Result |
|---|---|---|
| Body → Multipart; add a text field and a file field; Choose files… with a file inside the collection folder | The path shows relative to the collection (e.g. `files/x.pdf`) | |
| Choose a file outside the collection (e.g. Documents) | Shown by name with **this computer only**; after Save the request file has no trace of its path | |
| Send to a test or vendor upload endpoint | The server receives both fields and the file with its name and type; Network shows names and sizes, not contents | |
| Rename the chosen file in Explorer, then Send | "Multipart field "…": … was not found", nothing sent | |
| Restart Yept and open the request | The file chosen outside the collection is still chosen | |
| Commit the request and open it on a second computer (or a second Windows user) | The outside file shows *No file chosen on this computer*; the collection file is found | |
| Open the same collection in Bruno after saving | Bruno shows the multipart fields and the collection-relative file; the request sends there | |
| Copy as cURL (with secrets), run it in Git Bash | curl sends the same fields and files | |
| Import a Postman collection with a file field | The import preview says the exporting computer's file path was left out; the field is a file field with no file | |

## J. HTML and XML responses

| Check | Expected | Result |
|---|---|---|
| Send to a page that returns `text/html` (e.g. a 404 page of a test server, or `/html` on the fixture server) | Opens in **Pretty**: indented, HTML colours; **Pretty / Raw / Preview** buttons | |
| **Raw** | The body exactly as received, one long line for a minified page | |
| **Preview** in light and dark mode, each theme | The page drawn on white, its inline styles applied; the note says nothing is loaded from the network; app colours unchanged around it | |
| In Preview: click a link, submit a form, wait for a `<meta refresh>` | Nothing happens: no browser window, the preview stays on the page, the app is not navigated | |
| Page with images or a stylesheet from its server | Shown without them; the server's log shows no request for them | |
| Send an XML or RSS response | Pretty indents it; `<link>` keeps its text; no Preview button | |
| A large HTML response (over 2 MB) | Raw text with **Format anyway** / **Preview anyway**; the window stays responsive while it formats | |

## K. Collection runner

| Check | Expected | Result |
|---|---|---|
| Right-click a folder → **Run folder…**; the collection → **Run collection…**; the collection page and the home page's ⋯ menu → **Run collection** | The runner opens for that folder or collection and lists its requests in sidebar order | |
| A team collection with a login request and requests using its token; choose an environment other than the active one; run | Requests after the login use its token; the footer still shows the active environment | |
| A request with tests that fail, one returning 404 without tests, one with an unresolved variable | *Failed*, *Failed* (with "HTTP 404, and no tests…"), *Error*; the summary counts errors apart from failed tests | |
| A request whose tests expect a 404 | *Passed* | |
| **Stop after the first failure** on, run again | The run stops at the first failure; the rest show *Not run* | |
| A request that takes a long time; **Cancel run** | That request shows *Cancelled*, nothing after it is sent | |
| Close the runner while it works | The footer shows "Running n/m"; clicking it reopens the runner on the same run | |
| Edit a request without saving, then run its folder | The runner says one request has unsaved edits; the saved version is sent | |
| After a run: Dev tools Network and each request's history | One row and one history entry per request; script requests linked to the request that sent them | |
| Narrow window, dark mode, each theme, keyboard only (Tab, Space on the checkbox, Esc) | The table wraps without overlapping; result colours readable; Esc closes | |

## Reporting

Note failures with steps, window size, theme and scaling, plus a screenshot. Never include tokens or real hostnames. Fixes go back through `npm run typecheck`, `npm test` and `npm run e2e` before the next installer build.
