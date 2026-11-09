# Changelog

All notable changes to Yept for VS Code are listed here.

## 0.9.0 (pre-release)

The first preview of Yept for VS Code. It uses the same request engine and collection files as the Yept desktop app.

- **Collections tree:** finds collections in every local workspace folder. You can create, open and import collections, and create, rename, duplicate, move and delete requests and folders. Deleted items go to the system trash. Bruno `.bru` collections open read-only.
- **Request panels:** one editor tab per request, with the shared request editor and response pane. Unsaved changes show `●`, and **Ctrl+S** / **Cmd+S** saves. **Open in editor** opens large response bodies in a read-only editor.
- **Environments:** the active environment is in the status bar. **Manage Environments** edits shared values (saved to the collection), and local overrides, secrets and TLS settings (kept on this machine).
- **Secrets and cookies:** local secrets and automatic cookies are encrypted under a key in VS Code's secret storage.
- **History:** local response history, with secrets redacted, in a History view that follows the active request. Open a past run, or restore it into the editor.
- **Collection runner:** runs a collection or folder in order, with the environment you choose and an option to stop at the first failure.
- **Dev Tools:** Console, Network and Cookies tabs in the bottom panel, for every send.
- **Import and export:** import Postman, Insomnia, OpenAPI, OpenCollection and Bruno collections, with a preview and credential handling. Export to OpenCollection YAML without secret values.
- **Paste cURL:** create a request from a curl command (bash or Windows cmd) on the clipboard.
- **Leak check:** flags credentials in collection files in the Problems panel, and offers an optional Git pre-commit hook that blocks leaky commits.
- **Settings:** automatic cookies and history limits, applied without a reload.
- **Workspace Trust:** in untrusted folders, requests send but scripts and tests don't run.
- **Diagnostics:** **Yept: Run Diagnostics** checks the local database, certificates, script sandbox and editor workers.
- Remote windows and virtual workspaces aren't supported yet.
