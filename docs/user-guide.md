# Yept user guide

Yept stores collection requests and non-secret environment values as Bruno OpenCollection YAML files. Your secrets, response history and personal TLS settings stay on your computer. Use your normal Git tool to clone the shared collections repository before opening it in Yept. The installer is currently unsigned, so Windows may show a SmartScreen warning; on macOS follow [macos-build.md](macos-build.md). On a Mac, use ⌘ wherever this guide says Ctrl.

## 1. Open a collection

Choose **Open folder…** and select the folder containing `opencollection.yml` collections. Yept restores this folder on the next launch and starts on the **Collections** home, which lists every collection as a tile or a row (switch with **Grid** / **List**; the choice is remembered on this computer only). Search filters by name. **+ New collection** creates an empty collection folder in the workspace. A `bruno.json` collection opens read-only; choose **Convert to YAML** from its **⋯** menu if you need to edit it.

Open a collection to see only its requests in the sidebar. With no request selected, the collection page offers **+ New request**, **New folder**, **Run collection** (see section 4), **Environments** and **Collection settings**; right-clicking a folder in the sidebar also adds requests. Enter the method and URL, save with **Ctrl+S**, and send with **Ctrl+Enter**. The response pane distinguishes HTTP errors from network failures and timeouts. Click **Collections** in the breadcrumb to return home; unsaved drafts stay open while you move between collections.

To start from a curl command (from API docs, or **Copy as cURL** in a browser's developer tools, bash or cmd), choose **Paste cURL…** from the ☰ menu, or press **Ctrl+K** and paste the command there. The dialog previews the method, URL, headers, body and auth, and lists anything it leaves out, such as `-k` (set TLS per environment instead) or options that read files: files named in the command are never read, except that `-F name=@path` adds a file field with that path kept on this computer only. Choose a name and the collection or folder, then **Create request**. Credentials in the command (an `Authorization` or `Cookie` header, a `-u` password) are saved in the request file as they are; move them to a secret before you commit.

## 2. Set environments and secrets

Use the environment switcher beside **Send** to create or select an environment. In **Environments**, set shared values such as `baseUrl` in the file. Mark a credential variable **Secret**, save, then enter its value under **This machine only**. Refer to it as `{{variableName}}` in a URL, header, body or auth field. Switching environments keeps each environment's secrets and runtime tokens separate. The URL preview masks secrets and marks missing variables before you send. If you paste a credential into a shared field, use **Store as local secret** when prompted.

## 3. Log in and use a token

Create a login request using the API's documented method, URL and body. In its post-response variables, set a name such as `accessToken` from the documented response path (for example `res.body.access_token`). Mark `accessToken` secret in the active environment. For a protected request, choose **Bearer** auth and use `{{accessToken}}`, or set bearer auth on the collection and inherit it in requests. Send the login request first, then the protected request. A failed login clears the previous extracted token.

Collections imported from Postman or Bruno often log in from a pre-request script instead, with `bru.sendRequest` (Postman's `pm.sendRequest` is converted to it on import):

```js
const login = await bru.sendRequest({
  method: 'POST',
  url: bru.getEnvVar('baseUrl') + '/auth/token',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  data: { grant_type: 'client_credentials', client_id: bru.getEnvVar('clientId'), client_secret: bru.getEnvVar('clientSecret') }
});
bru.setEnvVar('accessToken', login.data.access_token);
```

The script gets `status`, `headers` and `data` (parsed JSON) back. A non-2xx status throws, with the response in `err.response`; or pass a callback, `(err, res) => …`. These requests use the same TLS settings and cookies as the request, and secrets stay masked in Dev tools. A script can send up to 10, and they count towards its 5 second limit; **Cancel** stops them. They show in Dev tools (see below) and in the response Timeline, not as history entries of their own.

Choose **OAuth2** in the Auth tab and select the grant your API uses. Set it on the collection to inherit it in its requests. Enter the token URL, client ID and any scope the provider needs. Store a client secret or password as a local secret in the active environment and refer to it as `{{clientSecret}}` or `{{oauthPassword}}`.

- **Client credentials** can fetch a token on the first send.
- **Authorization code** also needs the authorization URL. PKCE with S256 is on by default. Leave the callback blank to use a random port on `127.0.0.1` at `/oauth/callback`, or enter the fixed HTTP loopback callback registered with your provider. Click **Get token** to sign in in your system browser. Use **Cancel sign-in** in Yept to stop waiting. Collection runs and scripts can use and renew a token after sign-in.
- **Password (legacy)** uses the resource owner's username and password and can fetch a token on the first send. This grant is for compatibility with existing collections. [OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.4)

The Auth tab shows token status and offers **Get token** and **Forget token**. Yept keeps access and refresh tokens in memory per collection and environment. With **Get a new token automatically when it expires or is rejected** enabled, Yept tries a refresh token first. Enter a **Refresh URL** if your provider uses a separate endpoint. If browser sign-in is needed again, use **Get token**. When a server rejects a cached token, a GET, HEAD or OPTIONS request can be re-sent once after renewal. For other methods, send again yourself.

Three more modes in the Auth tab, for APIs that need them. Keep each password or secret key in a `{{variable}}` stored as a local secret; a literal one gets the **Store as local secret** hint, as for Basic.

- **Digest**: username and password. Yept sends the request, the server answers 401 with a challenge, and Yept sends it once more with the answer. MD5, SHA-256 and SHA-512-256 (also `-sess`) with qop `auth`, or servers that send no qop. Network shows both sends.
- **NTLM**: username, password and domain (or `DOMAIN\user` as the username). NTLMv2; the handshake runs on a connection of its own, so Network shows the 401 and the final answer. There is no workstation field, as in Bruno.
- **AWS Signature v4**: access key ID, secret access key, an optional session token, service (for example `execute-api` or `s3`) and region. The request is signed just before it goes out, after variables are filled in, so the signature covers the final URL, headers and body. If a Bruno file names an AWS profile, the name is kept, but Yept doesn't read profiles: enter the keys.

An `Authorization` header set on the request wins over all of these. Collections and folders can set them too, for requests that inherit.

### Upload files (multipart / form-data)

In the Body tab, choose **Multipart**. Add **text fields** and **file fields**; each row has a name, a value or files, an optional content type, and a checkbox to leave it out. `{{variables}}` work in names, text values and file paths. **Choose files…** picks one or more files:

- A file **inside the collection folder** is saved in the request file as a path relative to the collection (for example `files/report.pdf`), so teammates get it through Git. Use **Type a path** for a path with a variable, such as `{{dataDir}}/report.pdf`.
- A file **anywhere else** is marked **this computer only**. Its path stays on your computer and never goes into the request file, so nobody else's machine path reaches Git. A teammate who opens the request sees *No file chosen on this computer* and chooses their own copy.
- A path another tool wrote into the file as an absolute path is flagged; **Keep on this computer only** moves it out of the shared file.

Yept sets the multipart `Content-Type` header and its boundary. If a file is missing or can't be read, nothing is sent and the message names the field and the path. History and Dev tools show field names, file names and sizes, never file contents. Copy as cURL writes `-F` options that read the same files.

## 4. Read responses, history and tests

The response **Body** shows **Pretty** (formatted, with highlighting) or **Raw** (exactly as received). Pretty indents JSON, HTML and XML; HTML and XML are recognised by their content type, or by a body that starts with `<!DOCTYPE html>`, `<html>` or `<?xml`. Pretty normalises spaces inside text, so use Raw to see the exact bytes. Bodies over 2 MB open as raw text, with **Format anyway**.

An HTML response also has **Preview**, which shows the page as a browser would draw it, but safely: its scripts don't run, links and forms do nothing, and nothing is loaded from the server or anywhere else. So the page's own inline styles apply, but images and stylesheets that it links to are missing. This is meant for error pages and simple HTML from an API, not for browsing a site. Pretty, Raw or Preview stays chosen for that tab while you keep sending, and **Copy** always copies the body as received when Preview is on.

### Filter, save and preview a response

For a JSON body in **Pretty**, click **Filter** beside Pretty and Raw. The box takes JSONPath: `$.items[*].id`, `$..price`, `$.items[0]`, `$.items[-1]`, `$.items[1:3]`, `$['x-request-id']`, or a filter such as `$.items[?(@.price < 10 && @.status == 'open')]`. The leading `$` is optional. The body is replaced by the matching values while the filter is on, and **Copy** copies them. A mistake in the expression shows a message beside the box and leaves the body as it is. Click **✕** or **Filter** again, or press **Esc**, to return to the whole body. A filter that matches a huge number of values shows the first 10,000.

**Set as variable…** saves a value from the response into the collection's active environment. It is in the filter bar and on the body editor's right-click menu. It takes the value you selected in the body, or else the one value the filter matches. Choose a name and where it goes:

- **Runtime variable**: kept for this session only, like a value a post-response variable extracts. Use it as `{{name}}` in the next requests.
- **Local secret**: for tokens and keys. The environment file only declares the name as a secret; the value is encrypted on this machine and shown masked, as other secrets are. A name such as `token`, `secret` or `apiKey` picks this by default.

The dialog shows the variable name used and, for a secret, hides the value. Choose an environment first; without one there is nowhere to keep the value.

**Save to file…** writes the body exactly as received, byte for byte, so images, PDFs and archives open as they should. The suggested name comes from the response's `Content-Disposition` header, else the last part of the URL, else the request name. For a run opened from history, the stored body is saved, which is redacted and may be cut short by the history body limit.

An image (`image/png`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg+xml`, `x-icon`) or a PDF opens in **Preview**, drawn from the bytes received, in the same sandboxed frame as the HTML preview: no scripts, nothing loaded from the network. PDF pages are drawn as pictures (the first 30 pages), so their links and forms don't work, and fonts the PDF doesn't embed use system fonts. A body that was cut short, or is larger than 20 MB, is not previewed; save it to a file instead. **Pretty** and **Raw** are still there for a PDF that is mostly text, or an SVG.

The response pane's history list keeps up to 20 runs per request by default and survives a restart. Select a past run to see its **original** response and test results; Yept does not resend it. **Restore request** copies the old request into the editor for review, without saving. Add simple checks in the **Tests** tab, or a JavaScript `test(...)` script. Results distinguish passed, failed and script error. The Settings dialog controls history limits and shows orphaned runs after external file moves. History export may contain response data even after known secrets are redacted, so review it before sharing.

To compare two runs, open **History**, click **Compare** and pick two runs. Status, time, size, environment, URL and tests are listed side by side with the changed rows marked, and **Headers** and **Body** open in a diff view (JSON bodies are formatted first, so spacing doesn't count as a change; headers are sorted by name). Only what history stored is compared: secrets show as `«secret:name»` and auth and cookie headers as `«redacted»`, as the view says. Pick another run to change the pair, or **Close comparison**.

### Run a folder or a whole collection

To send a series of requests in order, such as login → create → read → delete, right-click a folder or the collection in the sidebar and choose **Run folder…** or **Run collection…**. **Run collection** is also on the collection page and in a collection's **⋯** menu on the home page. The runner lists the requests in sidebar order: each folder's subfolders first, then its requests, top to bottom.

Choose the **environment** for the run; it starts as the active one, and changing it here doesn't change the active environment. Values a request sets are used by the ones after it: an extracted token, `bru.setVar` and `bru.setEnvVar`, cookies. Without an environment they last until the end of the run. The runner sends the **saved** requests: unsaved edits in open tabs are left out, and the runner says how many there are.

Each request gets a result:

- **Passed**: its tests and assertions ran and all passed.
- **Failed**: a test or assertion failed or couldn't run, a script failed, or, for a request with no tests, the response was HTTP 400 or higher. A request whose tests expect a 404 passes when it gets one.
- **Error**: there was no response: not sent (a missing `{{variable}}`, say), connection failed or timed out.
- **No tests**: a response under 400 with nothing to check it. It isn't counted as a passed test.

Tick **Stop after the first failure** to stop at the first *Failed* or *Error*; the rest are marked *Not run*. Otherwise every request is sent. The summary counts requests by result and, separately, the tests that passed and failed. Click a request for the reason and its tests, **Open request**, or **Show in Dev tools**. **Cancel run** stops the request being sent and sends nothing after it. You can close the runner while it works; the footer shows its progress, and clicking that opens it again. Every request in a run goes to its history and to Dev tools, like a request sent from its tab. Requests that scripts send with `bru.sendRequest` show in Dev tools under the request that sent them, not as results of their own. One run at a time, and runs don't happen on a schedule.

#### Data files, iterations and delay

To run the same requests with different values, click **Choose CSV or JSON…** next to **Data file** and pick a file:

- **CSV:** the first line names the variables, then one row per iteration, like `username,city`. Put a value in double quotes when it has a comma, a quote (written `""`) or a line break. UTF-8, with or without a BOM (Excel's *CSV UTF-8*).
- **JSON:** an array of objects, one per iteration, like `[{ "username": "asha" }, { "username": "ravi" }]`. Numbers and true/false become text.

The run goes through every request once per row. In each iteration, the row's values are variables for that iteration, over the environment's values (`{{username}}` in a URL, `bru.getVar("username")` in a script). After the iteration they are gone, and the environment's values apply again. An empty cell is an empty value, so a request that uses it isn't sent, as with an empty environment value. The file is read again when a run starts, so you can edit it between runs. Its path stays on this computer, in memory: it is never written to the collection's files.

Without a data file, set **Iterations** to repeat the run (up to 1,000). **Delay** waits that many milliseconds between requests, within an iteration and between iterations (up to 60,000). **Cancel run** stops a wait too.

With more than one iteration the results are grouped by iteration. Iterations that passed stay closed; the one running and the first few that failed open by themselves. Click an iteration to open or close it. *Stop after the first failure* stops the whole run, not just the iteration.

#### Reports

When a run has finished, **JUnit XML…** and **HTML report…** save it to a file. The JUnit report has a test suite per request and iteration and a test case per test or assertion; a request without tests, or one that got no response, gets one case for the request. CI tools such as Jenkins, GitLab and Azure DevOps read it. The HTML report is one file with no scripts and nothing loaded from elsewhere, so it opens anywhere. Both are built from the results as history keeps them: secret values show as `«secret:name»` and `Authorization`, `Cookie` and `Set-Cookie` headers as `«redacted»`.

## 5. Share collections with Git

Click **Git**, the branch in the footer, or **Menu → Git** to open the source-control side panel. It replaces the collection tree while open; close it with **×** to return to the tree. When the workspace has several repositories, choose one in the repository picker.

**Fetch** updates the upstream's ahead/behind counts without changing your files. **Pull** receives upstream commits with fast-forward only. **Sync** fetches, pulls fast-forward only, then pushes; it stops at the first failure. If the branch has no upstream, use **Push** and confirm upstream setup first. Git Credential Manager handles sign-in outside Yept. A diverged branch, conflict or unfinished Git operation needs your normal Git tool; Git's output and a plain explanation appear in the panel. Yept never force-pushes, rebases, stashes or creates merge commits.

Choose an existing local branch in **Branch** only when the whole repository is clean and its open request tabs have no unsaved drafts. Changes outside the collection folders also block switching. Pull and branch changes reload clean request tabs; a changed file with an unsaved draft shows the existing choice to reload or keep your edits. When a teammate renamed or moved a request file, even with edits, Yept follows Git's rename detection: the request keeps its history and open tab, and the panel output lists the renames it followed. If Git could have matched the file to more than one request (identical copies), Yept doesn't guess; the old history appears under *History of deleted or moved requests* in Settings.

Tick the changed collection files to work on. **Stage selected** and **Unstage selected** change only those files in Git's index. **Commit** saves the current working-file versions of the ticked files, including any edits made after staging; other staged files stay staged. Enter a message first. The leak check blocks likely secrets unless you explicitly override it by typing the file name. **Discard selected** asks for confirmation, restores tracked files and their staged changes to the last commit, and moves new files to the Recycle Bin. Unsaved editor drafts are kept; discard does not commit or push anything.

For anything the panel doesn't do, such as merging, rebasing or resolving conflicts, use your usual Git tool.

## 6. Debug with Dev tools and cookies

Click **Dev tools** in the footer or press **Ctrl+Shift+J**. **Console** lists what happened in each run this session: script `console.log` output, variables set, test results and errors. Click a line to open that run. **Network** shows every request with the headers really sent, redirects, timings, and the connection and certificate details; **Copy as cURL** copies it for a terminal, with secrets masked unless you choose **…with secrets**. **Copy as ▾** copies it as code instead: cURL, C# `HttpClient`, PowerShell `Invoke-RestMethod`, JavaScript `fetch` or axios, or Python `requests`. Secrets stay masked there too; tick **Include secrets and cookies** in that menu first to include them (only for the last 50 requests sent in this session, and the tick clears each time). Multipart files are read from the path they were sent from. The JavaScript snippets read files with Node.js `openAsBlob`; PowerShell's multipart form needs PowerShell 7, and the snippet says so when it can't keep a part's content type or file name. **Table | Raw** switches the request and response headers to HTTP text (`GET /path HTTP/1.1` and header lines). Yept rebuilds that text from what it recorded, so header case, order and line endings may differ from the exact bytes sent. Secrets stay masked there too, and **Copy** copies it masked. Requests a script sent with `bru.sendRequest` have rows of their own marked **script**: *Show the run that sent it* goes to the request's run, which lists them under **Scripts sent**, and the Console shows each one. Cookies from responses are stored and sent automatically, separately for each collection and environment. **Cookies** shows them for the current environment, where you can add, edit or delete them. Session cookies are cleared when Yept closes. A request's own `Cookie` header always wins. To send none from the jar, tick **Don't send stored cookies** in the request's Settings; to turn cookies off entirely, use Settings. Dev tools keeps only this session's activity; History is the permanent record.

## 7. Themes and fonts

**Settings → Appearance** (or the ☰ menu) offers four themes: **Blue** (the default: navy with blue and light blue), **Navy/Teal**, **Warm Paper** and **High Contrast**. Each has light and dark versions. Status colours keep their meaning in every theme: green for success, amber for warnings and red for errors. `{{variables}}` take the theme's primary colour; secrets, missing variables and generated ones such as `{{$guid}}` each have a colour of their own. **Light or dark** follows Windows when set to *System*; the footer button switches it too. You can choose an interface font, a code font and the code size in editors. Yept uses only fonts installed on your computer: it lists the common ones it finds, and **Other installed font…** accepts any other installed font by name. A font that isn't installed is flagged, and the default is used. Changes apply at once, stay on this computer, and **Reset appearance to defaults** undoes them.

## Good practice

Try a new setup against the included fixture collection or the sample ASP.NET API first, then your own APIs. Each person should use their own credentials, stored as local secrets. Never paste real credentials or response captures into an issue, a screenshot or a code repository.
