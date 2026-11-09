import * as vscode from 'vscode';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * A page of the extension: a bundled local script under a nonce, local styles, and data attributes on the root element
 * (escaped). Inline styles are allowed for Monaco and React; Monaco's workers run from blob URLs.
 */
export function pageHtml(webview: vscode.Webview, resources: vscode.Uri, nonce: string, script: string, data: Record<string, string> = {}): string {
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(resources, 'webview', file));
  const attributes = Object.entries(data).map(([name, value]) => ` data-${name}="${escape(value)}"`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; worker-src blob:; img-src data:; font-src ${webview.cspSource}; base-uri 'none'; form-action 'none'">
  <link rel="stylesheet" href="${asset('main.css')}">
  <title>Yept</title>
</head>
<body>
  <div id="root"${attributes}></div>
  <script type="module" nonce="${nonce}" src="${asset(script)}"></script>
</body>
</html>`;
}

/**
 * The request panel page. The request to open, a collection whose environment editor should open, unsaved edits to
 * restore (JSON) and a past run to show are passed as data attributes.
 */
export function panelHtml(webview: vscode.Webview, resources: vscode.Uri, nonce: string, requestId = '', manageCollectionId = '', draft = '', viewRun = ''): string {
  return pageHtml(webview, resources, nonce, 'main.js', { 'request-id': requestId, 'manage-environments': manageCollectionId, draft, 'view-run': viewRun });
}
