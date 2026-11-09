import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { HostEvents } from '@yept/core/shared/ipc';
import { safeDetail, type DiagnosticsReport } from '../../src/diagnostics';
import { createLocalStores, createRequestServices } from '../../src/handlers';
import { createHost } from '../../src/host';
import { panelHtml } from '../../src/panel';
import { bindWebview, extendRegistry, type WebviewBinding } from '../../src/webview-binding';
import type { TestApi } from '../../src/extension';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';
import { Workspace } from '@yept/core/engine/workspace/workspace';

// Runs before the panel bundle: it shares the page's single acquireVsCodeApi(), probes the transport, then drives the
// request page (choose the local environment, send, open the history list) and reports what it saw.
const OBSERVER = `(() => {
  const api = acquireVsCodeApi();
  globalThis.acquireVsCodeApi = () => api;
  const report = (observed, value) => api.postMessage({ observed, value });
  window.addEventListener('error', (e) => report('page-error', e.message));
  window.addEventListener('unhandledrejection', (e) => report('page-error', String(e.reason)));
  window.addEventListener('message', ({ data }) => {
    if (data && typeof data.id === 'string' && data.id.startsWith('probe-')) report(data.id, data);
    if (data && 'event' in data) report('event-message', data.event);
    if (data?.result?.result) report('response', data.result);
  });
  document.addEventListener('DOMContentLoaded', async () => {
    while (!window.yept) await new Promise((r) => setTimeout(r, 10));
    window.yept.runner.onEvent((event) => report('runner-event', event));
    api.postMessage({ id: 'probe-versions', channel: 'app:versions', args: [] });
    api.postMessage({ id: 'probe-unknown', channel: 'app:unknown', args: [] });
    api.postMessage({ id: 'probe-raw', channel: 'cookies:clear', args: ['c1', undefined] });
    Promise.all([window.yept.cookies.clear('c1'), window.yept.cookies.clear('c1', 'api.example.test'), window.yept.git.commit('root', [], 'message')])
      .then((value) => report('omitted', value), (error) => report('omitted', String(error)));
    let sent = false;
    let opened = false;
    const check = () => {
      const buttons = [...document.querySelectorAll('button')];
      const send = buttons.find((b) => b.textContent.trim() === 'Send');
      const select = document.querySelector('select[aria-label="Environment"]');
      if (send && !sent && select?.querySelector('option[value="local"]')) {
        sent = true;
        select.value = 'local';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => send.click(), 500);
      }
      const toggle = buttons.find((b) => b.textContent.trim().startsWith('History'));
      if (sent && toggle && !opened && document.body.textContent.includes('200')) {
        opened = true;
        toggle.click();
      }
      const entry = document.querySelector('.history-item');
      if (entry) report('history', entry.textContent);
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, attributes: true });
    check();
  });
})();`;

function waitForMessage<T>(webview: vscode.Webview, what: string, match: (message: any) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Timed out waiting for ${what}`)); }, 30000);
    const subscription = webview.onDidReceiveMessage((message: unknown) => {
      const value = match(message);
      if (value === undefined) return;
      clearTimeout(timer);
      subscription.dispose();
      resolve(value);
    });
  });
}

/**
 * Accepts the first item in the real quick pick the command shows, and returns what the command returned. The command
 * first waits for the workspace to load, so accepting starts only once it has asked for the quick pick.
 */
async function acceptFirstChoice<T>(opening: () => Thenable<T>): Promise<T> {
  const window = vscode.window as { showQuickPick: (...args: unknown[]) => Thenable<unknown> };
  const show = window.showQuickPick;
  let shown = false;
  window.showQuickPick = (...args) => { shown = true; return show.apply(vscode.window, args); };
  try {
    let settled = false;
    const result = Promise.resolve(opening()).finally(() => { settled = true; });
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (shown && !settled) await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }
    return await result;
  } finally {
    window.showQuickPick = show;
  }
}

/** Every file under a folder with its content, to show nothing was added or changed. */
async function files(root: string): Promise<string[]> {
  const list: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) list.push(...await files(path));
    else list.push(`${path}:${await readFile(path, 'base64')}`);
  }
  return list.sort();
}

interface RequestCheck {
  panel: vscode.WebviewPanel;
  binding: WebviewBinding;
  services: ReturnType<typeof createRequestServices>;
  close: () => Promise<void>;
  storage: string;
  requestId: string;
  cipherCalls: () => number;
  observed: (name: string) => Promise<any>;
  events: string[];
}

/**
 * A panel with the real page, bundle, services and binding, opened on the Login request, plus echo handlers for two
 * channels with optional arguments, a cipher that counts calls, and the observer script. Test panels only.
 */
async function openRequestCheck(extension: vscode.Extension<unknown>, root: string): Promise<RequestCheck> {
  const storage = await mkdtemp(join(tmpdir(), 'yept-panel-storage-'));
  let calls = 0;
  const host = await createHost(storage, extension.extensionPath, extension.packageJSON.version, { node: process.versions.node }, () => {}, () => {});
  const counted = (): never => { calls++; throw new Error('cipher called'); };
  host.cipher = { encrypt: counted, decrypt: counted };
  const identity = new IdentityStore(join(storage, 'identity.db'));
  const ws = new Workspace(root, identity, { trash: host.trash });
  await ws.load();
  const stores = createLocalStores(host);
  const services = createRequestServices(host, ws, stores);
  const close = async () => {
    await services.close();
    stores.close();
    identity.close();
  };
  const echo = (...args: unknown[]) => ({ count: args.length, args });
  // Channels with optional trailing arguments answer with what arrived, to check how omitted arguments travel.
  const handlers = extendRegistry(services.handlers, { 'cookies:clear': echo, 'git:commit': echo });
  const requestId = [...ws.liveRequestIds()].find((id) => ws.getRequest(id).doc.name === 'Login');
  assert.ok(requestId, 'Missing the Login request');

  const resources = vscode.Uri.joinPath(extension.extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel('yeptRequestCheck', 'Yept request check', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [resources] });
  const binding = bindWebview(panel.webview, handlers);
  const values = new Map<string, Promise<unknown>>();
  const events: string[] = [];
  const observed = (name: string): Promise<unknown> => {
    if (!values.has(name)) values.set(name, waitForMessage(panel.webview, name, (m) => m?.observed === name ? { value: m.value } : undefined).then((m) => m.value));
    return values.get(name)!;
  };
  // Listen before the page loads, so no report is missed.
  for (const name of ['probe-versions', 'probe-unknown', 'probe-raw', 'omitted', 'runner-event', 'response', 'history']) void observed(name).catch(() => undefined);
  panel.webview.onDidReceiveMessage((m: any) => {
    if (m?.observed === 'event-message') events.push(m.value);
    if (m?.observed === 'page-error') console.error('Page error:', m.value);
  });
  const nonce = randomBytes(24).toString('base64');
  const html = panelHtml(panel.webview, resources, nonce, requestId);
  const withObserver = html.replace('<script type="module"', `<script nonce="${nonce}">${OBSERVER}</script>\n  <script type="module"`);
  assert.notEqual(withObserver, html);
  panel.webview.html = withObserver;
  return { panel, binding, services, close, storage, requestId, cipherCalls: () => calls, observed, events };
}

// This entry is loaded by VS Code, not by the desktop's Node unit-test runner.
export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'The tests need a workspace folder');
  const before = await files(root);
  let panel: vscode.WebviewPanel | undefined;
  let requestId: string | undefined;
  let extensionUri: vscode.Uri | undefined;
  let development: vscode.Extension<unknown> | undefined;
  let check: RequestCheck | undefined;
  const checks: [string, () => Promise<void>][] = [
    ['activates the development extension and registers its commands', async () => {
      const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      const extensionPath = normalize(resolve(__dirname, '../../..'));
      const extension = vscode.extensions.all.find((entry) => normalize(entry.extensionPath) === extensionPath);
      assert.ok(extension, 'Development extension was not loaded');
      extensionUri = extension.extensionUri;
      development = extension;
      await extension.activate();
      assert.equal(extension.isActive, true);
      const commands = await vscode.commands.getCommands(true);
      for (const command of ['yept.open', 'yept.openRequest', 'yept.diagnostics']) assert.ok(commands.includes(command), command);
    }],
    ['shows a single workspace without an extra folder level', async () => {
      assert.ok(development);
      const api = development.exports as TestApi | undefined;
      assert.ok(api, 'The extension returns its test API only when run for tests');
      await api.ready;
      const items = api.collections.getChildren();
      assert.equal(items.length, 1);
      assert.equal(items[0].kind, 'collection');
      assert.equal(items[0].name, 'Sample Travel');
    }],
    ['opens a chosen request with built local assets and a restrictive policy', async () => {
      panel = await acceptFirstChoice(() => vscode.commands.executeCommand<vscode.WebviewPanel | undefined>('yept.openRequest'));
      assert.ok(panel, 'The command did not open a panel');
      assert.ok(panel.title && !panel.title.startsWith('●'), 'The panel is named after its request');
      assert.equal(panel.webview.options.enableScripts, true);
      assert.ok(extensionUri);
      const resources = vscode.Uri.joinPath(extensionUri, 'dist');
      assert.deepEqual(panel.webview.options.localResourceRoots?.map((uri) => uri.fsPath), [resources.fsPath]);
      const html = panel.webview.html;
      requestId = html.match(/data-request-id="([^"]+)"/)?.[1];
      assert.ok(requestId, 'Missing the request id');
      const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1];
      assert.ok(policy, 'Missing the content security policy');
      const directives = Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
      assert.deepEqual(directives['default-src'], ["'none'"]);
      assert.equal(directives['script-src'].length, 1);
      const nonce = directives['script-src'][0].match(/^'nonce-(.+)'$/)?.[1];
      assert.ok(nonce, 'Scripts must be allowed by nonce only');
      assert.ok(html.includes(`nonce="${nonce}"`));
      assert.ok(!policy.includes('unsafe-eval'));
      for (const [name, values] of Object.entries(directives)) if (name !== 'style-src') assert.ok(!values.includes("'unsafe-inline'"), name);
      for (const file of ['main.js', 'main.css']) {
        const uri = vscode.Uri.joinPath(resources, 'webview', file);
        assert.ok(html.includes(panel.webview.asWebviewUri(uri).toString()));
        assert.ok((await readFile(uri.fsPath)).length > 0, `Missing built asset: ${file}`);
      }
    }],
    ['shows the open panel of a request opened again by id', async () => {
      assert.ok(panel && requestId);
      assert.equal(await vscode.commands.executeCommand('yept.openRequest', requestId), panel);
      assert.ok(panel.webview.html.includes(`data-request-id="${requestId}"`));
    }],
    ['refuses a request id that is not in the workspace', async () => {
      assert.ok(panel);
      const html = panel.webview.html;
      assert.equal(await vscode.commands.executeCommand('yept.openRequest', 'not-a-request'), undefined);
      assert.equal(panel.webview.html, html);
    }],
    ['opens a fresh panel after the previous panel is disposed', async () => {
      assert.ok(panel && requestId);
      const previous = panel;
      previous.dispose();
      panel = await vscode.commands.executeCommand<vscode.WebviewPanel>('yept.openRequest', requestId);
      assert.ok(panel);
      assert.notEqual(panel, previous);
      panel.dispose();
    }],
    // Its check panels close afterwards and take focus, which would dismiss a quick pick, so it runs after those checks.
    ['runs all diagnostics and keeps paths out of the report', async () => {
      const output = await vscode.commands.executeCommand<DiagnosticsReport>('yept.diagnostics');
      assert.ok(output);
      const { results, report } = output;
      assert.equal(results.length, 5);
      console.log(report);
      assert.ok(!report.toLowerCase().includes(homedir().toLowerCase()));
      assert.ok(extensionUri);
      assert.ok(!report.toLowerCase().includes(extensionUri.fsPath.toLowerCase()));
      assert.ok(!safeDetail(`failure at ${homedir()}\\file`).includes(homedir()));
      assert.ok(results.every((result) => result.ok), report);
    }],
    ['answers the page through the real bundle and binding', async () => {
      assert.ok(development);
      check = await openRequestCheck(development, root);
      const versions = await check.observed('probe-versions');
      assert.equal(versions.result.app, development.packageJSON.version);
      assert.ok(!/[\\/]/.test(JSON.stringify(versions.result)), 'Versions contain a path');
    }],
    ['rejects an unknown channel with an error reply through the real binding', async () => {
      assert.ok(check);
      assert.deepEqual(await check.observed('probe-unknown'), { id: 'probe-unknown', error: 'YeptError: Unknown channel: app:unknown' });
    }],
    ['keeps omitted arguments omitted across VS Code message serialisation', async () => {
      assert.ok(check);
      assert.deepEqual(await check.observed('omitted'), [
        { count: 1, args: ['c1'] },
        { count: 2, args: ['c1', 'api.example.test'] },
        { count: 3, args: ['root', [], 'message'] }
      ]);
      // Sent without the transport, the undefined argument arrives as null.
      assert.deepEqual(await check.observed('probe-raw'), { id: 'probe-raw', result: { count: 2, args: ['c1', null] } });
    }],
    ['pushes host events in the event map to their subscribers only', async () => {
      assert.ok(check);
      const event = { runnerId: 'check', type: 'step-start', index: 0 } as unknown as HostEvents['runner:event'];
      (check.binding.emit as (channel: string, event: unknown) => void)('app:unlisted', { value: 'not sent' });
      check.binding.emit('runner:event', event);
      assert.deepEqual(await check.observed('runner-event'), event);
      assert.deepEqual(check.events, ['runner:event']);
    }],
    ['sends the request and shows its history entry, without workspace writes or cipher calls', async () => {
      assert.ok(check);
      const sent = await check.observed('response');
      assert.equal(sent.result.status, 200);
      assert.match(sent.result.body.text, /access_token/);
      assert.deepEqual(sent.result.scriptErrors, []);
      assert.equal(sent.result.testsState, 'ran');
      assert.ok(sent.result.tests.length > 0 && sent.result.tests.every((t: any) => t.status === 'passed'));
      assert.ok(sent.result.extractions.every((e: any) => e.ok));
      assert.match(await check.observed('history'), /200/);
      assert.equal(check.services.runs.history.list(check.requestId).length, 1);
      assert.equal(check.cipherCalls(), 0);
      assert.deepEqual(await files(root), before);
    }]
  ];
  const failures: Error[] = [];
  try {
    for (const [name, run] of checks) {
      try {
        await run();
        console.log(`PASS ${name}`);
      } catch (error) {
        console.error(`FAIL ${name}`, error);
        failures.push(new Error(name, { cause: error }));
      }
    }
  } finally {
    panel?.dispose();
    if (check) {
      check.binding.dispose();
      check.panel.dispose();
      await check.close();
      await rm(check.storage, { recursive: true, force: true });
    }
  }
  console.log(`Extension host checks: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) throw new AggregateError(failures, 'Extension host checks failed');
}
