// Headless rendering checks with synthetic data and supplied VS Code tokens; not a native workbench screenshot.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const extension = join(root, 'apps/vscode');
const directory = await mkdtemp(join(tmpdir(), 'yept-webview-review-'));
const output = resolve(process.argv[2] ?? join(extension, 'out', 'ui-review'));
await mkdir(output, { recursive: true });
const adapter = join(directory, 'services.cjs');
await build({ stdin: { contents: `export { createHost } from './src/host'; export { createLocalStores, createRequestServices } from './src/handlers'; export { IdentityStore } from '../../packages/core/src/engine/identity/identity-store'; export { Workspace } from '../../packages/core/src/engine/workspace/workspace';`, resolveDir: extension, loader: 'ts' }, outfile: adapter, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { createHost, createLocalStores, createRequestServices, IdentityStore, Workspace } = createRequire(import.meta.url)(adapter);
await mkdir(join(directory, 'workspace'));
const host = await createHost(join(directory, 'storage'), extension, '0.6.0', {}, () => {}, () => {});
const identity = new IdentityStore(join(directory, 'identity.db'));
const workspace = new Workspace(join(directory, 'workspace'), identity, { trash: host.trash });
await workspace.load();
const collectionId = await workspace.createCollection('Synthetic review');
const id = await workspace.createRequest(collectionId, 'Create booking');
const doc = workspace.getRequest(id).doc;
doc.method = 'POST'; doc.url = 'https://api.example.test/bookings'; doc.body.mode = 'json'; doc.body.json = JSON.stringify({ destination: 'London', guests: 2, confirmed: true }, null, 2);
await workspace.saveRequest(id, doc);
const stores = createLocalStores(host);
const service = createRequestServices(host, workspace, stores);
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<html><head><link rel="stylesheet" href="/main.css"></head><body class="vscode-dark" data-vscode-theme-kind="vscode-dark"><div id="root" data-request-id="${id}"></div><script type="module" src="/main.js"></script></body></html>`); return; }
    const file = resolve(extension, 'dist/webview', '.' + decodeURIComponent(req.url));
    if (!file.startsWith(resolve(extension, 'dist/webview') + sep)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', extname(file) === '.css' ? 'text/css' : extname(file) === '.ttf' ? 'font/ttf' : 'text/javascript'); res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.exposeFunction('__invoke', async (message) => {
  try { return { id: message.id, result: await service.handlers.invoke(message.channel, ...message.args) }; }
  catch (error) { return { id: message.id, error: String(error) }; }
});
const modes = [
  { name: 'dark', kind: 'vscode-dark', bg: '#1f1f1f', fg: '#cccccc', input: '#313131', muted: '#9d9d9d', accent: '#0078d4', buttonFg: '#ffffff', line: '#474747', select: '#264f78', focus: '#007fd4', error: '#f14c4c', warn: '#cca700' },
  { name: 'light', kind: 'vscode-light', bg: '#ffffff', fg: '#3b3b3b', input: '#ffffff', muted: '#616161', accent: '#005fb8', buttonFg: '#ffffff', line: '#cecece', select: '#add6ff', focus: '#005fb8', error: '#a1260d', warn: '#855f00' },
  { name: 'high-contrast-dark', kind: 'vscode-high-contrast', bg: '#000000', fg: '#ffffff', input: '#000000', muted: '#ffffff', accent: '#000000', buttonFg: '#ffffff', line: '#6fc3df', select: '#ffffff', focus: '#f38518', error: '#f48771', warn: '#ffcc00' },
  { name: 'high-contrast-light', kind: 'vscode-high-contrast-light', bg: '#ffffff', fg: '#292929', input: '#ffffff', muted: '#292929', accent: '#0f4a85', buttonFg: '#ffffff', line: '#0f4a85', select: '#0f4a8566', focus: '#0f4a85', error: '#b5200d', warn: '#895503' }
];
function tokens(mode) {
  const values = { 'editor-background': mode.bg, 'editor-foreground': mode.fg, 'sideBar-background': mode.bg, 'input-background': mode.input, 'input-foreground': mode.fg, 'input-border': mode.line, 'input-placeholderForeground': mode.muted, 'descriptionForeground': mode.muted, 'panel-border': mode.line, 'button-background': mode.accent, 'button-foreground': mode.buttonFg, 'button-hoverBackground': mode.accent, 'textLink-foreground': mode.focus, 'focusBorder': mode.focus, 'contrastBorder': mode.line, 'icon-foreground': mode.fg, 'errorForeground': mode.error, 'editorWarning-foreground': mode.warn, 'testing-iconPassed': mode.fg, 'list-inactiveSelectionBackground': mode.select, 'list-hoverBackground': mode.input, 'editor-selectionBackground': mode.select, 'editor-selectionHighlightBackground': mode.select, 'editorCursor-foreground': mode.fg, 'editorLineNumber-foreground': mode.muted, 'editorWidget-background': mode.bg, 'editorWidget-foreground': mode.fg, 'editorWidget-border': mode.line, 'font-family': '"Segoe UI", sans-serif', 'font-size': '13px', 'font-weight': '400', 'editor-font-family': 'Consolas, monospace', 'editor-font-size': '16px', 'editor-font-weight': '500' };
  // VS Code registers no value for these in high-contrast themes; '' clears a value left by the previous mode.
  if (mode.kind.startsWith('vscode-high-contrast')) Object.assign(values, { 'editor-selectionHighlightBackground': '', 'toolbar-hoverBackground': '' });
  if (mode.kind === 'vscode-high-contrast') values['list-inactiveSelectionBackground'] = '';
  return values;
}
await page.addInitScript(({ initial }) => {
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__invoke(m).then((reply) => window.postMessage(reply, '*')) });
  const observer = new MutationObserver(() => {
    if (!document.body) return;
    observer.disconnect();
    for (const [key, value] of Object.entries(initial)) document.body.style.setProperty('--vscode-' + key, value);
  }); observer.observe(document, { childList: true, subtree: true });
}, { initial: tokens(modes[0]) });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('tab', { name: /^Body/ }).click();
  await page.locator('.monaco-editor').first().waitFor();
  for (const mode of modes) {
    await page.emulateMedia({ colorScheme: mode.kind === 'vscode-light' ? 'dark' : 'light' });
    await page.evaluate(({ mode, tokens }) => { document.body.className = mode.kind; document.body.dataset.vscodeThemeKind = mode.kind; for (const [key, value] of Object.entries(tokens)) document.body.style.setProperty('--vscode-' + key, value); }, { mode, tokens: tokens(mode) });
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, editor: getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor, font: getComputedStyle(document.querySelector('.view-lines')).fontFamily, size: getComputedStyle(document.querySelector('.view-lines')).fontSize, activeTabBorder: getComputedStyle(document.querySelector('.subtab.active')).borderBottomColor }));
    const expected = mode.bg === '#000000' ? 'rgb(0, 0, 0)' : mode.bg === '#ffffff' ? 'rgb(255, 255, 255)' : 'rgb(31, 31, 31)';
    assert.equal(result.body, expected); assert.equal(result.editor, expected); assert.match(result.font, /Consolas/); assert.equal(result.size, '16px');
    if (mode.name === 'high-contrast-dark') assert.equal(result.activeTabBorder, 'rgb(243, 133, 24)');
    // Accent text and selected states must stay visible when the theme leaves a token unset or uses a black button background.
    const accent = await page.evaluate(() => { const s = getComputedStyle(document.body); return { accent: s.getPropertyValue('--accent').trim(), soft: s.getPropertyValue('--accent-soft').trim() }; });
    assert.equal(accent.accent, mode.focus); assert.notEqual(accent.soft, '');
    await page.screenshot({ path: join(output, mode.name + '.png') });
    console.log(`PASS live ${mode.name} panel + Monaco background and editor font`, result);
  }
  // Font updates use the same live observer as theme switches, without reloading the editor.
  await page.evaluate(() => document.body.style.setProperty('--vscode-editor-font-size', '19px'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.view-lines')).fontSize === '19px');
  assert.deepEqual(errors, []);
  console.log('PASS live editor font-size change; no page errors');
  console.log(`SCREENSHOTS=${output}`);
} finally { await browser.close(); server.closeAllConnections(); server.close(); await service.close(); stores.close(); identity.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
