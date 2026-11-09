import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';

// Runs before the panel bundle in measured panels only. It reports, in page time, when the request editor is usable
// (URL shown, Send present), then opens the Script section and reports when its first editor shows the script.
const OBSERVER = `(() => {
  const api = acquireVsCodeApi();
  globalThis.acquireVsCodeApi = () => api;
  const report = (mark, detail) => api.postMessage({ measure: mark, at: performance.now(), detail });
  let usable = false;
  const check = () => {
    const buttons = [...document.querySelectorAll('button')];
    if (!usable) {
      const url = document.querySelector('input[aria-label="URL"]');
      if (!url || !url.value.includes('/auth/token') || !buttons.some((b) => b.textContent.trim() === 'Send')) return;
      usable = true;
      report('usable');
      buttons.find((b) => b.getAttribute('role') === 'tab' && b.textContent.trim().startsWith('Script')).click();
    }
    if ([...document.querySelectorAll('.monaco-editor .view-lines')].some((e) => e.textContent.includes('scriptToken'))) {
      observer.disconnect();
      const navigation = performance.getEntriesByType('navigation')[0];
      const scripts = performance.getEntriesByType('resource').filter((r) => /\\.m?js$/.test(r.name)).map((r) => [r.name.replace(/.*\\//, ''), Math.round(r.responseEnd)]);
      report('editor', { domContentLoaded: Math.round(navigation.domContentLoadedEventEnd), scripts });
    }
  };
  const observer = new MutationObserver(check);
  document.addEventListener('DOMContentLoaded', () => { observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true }); check(); });
})();`;

export interface Sample {
  kind: 'new profile' | 'first' | 'new panel';
  /** Host milliseconds from running the command until the command returned. */
  command: number;
  /** Host milliseconds from running the command until the page's report arrived. */
  usable: number;
  editor: number;
  /** Page milliseconds from navigation start, for the breakdown. */
  page: { usable: number; editor: number; domContentLoaded: number; scripts: [string, number][] };
}

type Mark = { measure: string; at: number; detail?: any; received: number };
let marks: Mark[] = [];
// The latest panel the extension created. A command that activates the extension returns it serialised, so the
// command's own result can't be used.
let panel: vscode.WebviewPanel | undefined;

/** Adds the observer to every page the extension sets, and collects its reports with the host time they arrived. */
function observePanels(): void {
  const window = vscode.window as { createWebviewPanel: typeof vscode.window.createWebviewPanel };
  const create = window.createWebviewPanel;
  window.createWebviewPanel = (...args) => {
    panel = create.apply(vscode.window, args);
    const { webview } = panel;
    let proto = Object.getPrototypeOf(webview);
    while (proto && !Object.getOwnPropertyDescriptor(proto, 'html')) proto = Object.getPrototypeOf(proto);
    const html = Object.getOwnPropertyDescriptor(proto, 'html')!;
    Object.defineProperty(webview, 'html', {
      configurable: true,
      get() { return html.get!.call(this); },
      set(value: string) {
        const nonce = value.match(/'nonce-([^']+)'/)?.[1];
        const page = value.replace('<script type="module"', `<script nonce="${nonce}">${OBSERVER}</script>\n  <script type="module"`);
        if (!nonce || page === value) throw new Error('Could not add the observer to the panel page');
        html.set!.call(this, page);
      }
    });
    webview.onDidReceiveMessage((m: any) => { if (typeof m?.measure === 'string') marks.push({ ...m, received: performance.now() }); });
    return panel;
  };
}

async function mark(name: string): Promise<Mark> {
  for (let waited = 0; waited < 60000; waited += 5) {
    const found = marks.find((m) => m.measure === name);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${name}`);
}

async function time(kind: Sample['kind'], open: () => Thenable<unknown>): Promise<Sample> {
  marks = [];
  const start = performance.now();
  await open();
  const command = performance.now() - start;
  if (!panel) throw new Error('The command did not open a panel');
  const usable = await mark('usable');
  const editor = await mark('editor');
  const round = (n: number) => Math.round(n * 10) / 10;
  // Let the page's workers and timers settle before the next open.
  await new Promise((r) => setTimeout(r, 750));
  return {
    kind,
    command: round(command),
    usable: round(usable.received - start),
    editor: round(editor.received - start),
    page: { usable: Math.round(usable.at), editor: Math.round(editor.at), ...editor.detail }
  };
}

// Loaded by VS Code from test/measure.mjs. The request id comes from an earlier launch with the same profile; without
// one, the first open picks the Login request from the quick pick, answered at once.
export async function run(): Promise<void> {
  const out = process.env.YEPT_MEASURE_OUT;
  if (!out) throw new Error('YEPT_MEASURE_OUT is not set');
  const fresh = Number(process.env.YEPT_MEASURE_NEW ?? 5);
  observePanels();
  // Let the window finish starting, as it would before someone runs a command.
  await new Promise((r) => setTimeout(r, 2000));
  const samples: Sample[] = [];
  let requestId = process.env.YEPT_MEASURE_REQUEST || undefined;
  const open = (id: string) => vscode.commands.executeCommand('yept.openRequest', id);
  if (requestId) samples.push(await time('first', () => open(requestId!)));
  else {
    const window = vscode.window as { showQuickPick: (items: readonly vscode.QuickPickItem[]) => Thenable<unknown> };
    const pick = window.showQuickPick;
    window.showQuickPick = async (items) => (await items).find((i) => i.label === 'Login');
    try {
      samples.push(await time('new profile', () => vscode.commands.executeCommand('yept.openRequest')));
    } finally {
      window.showQuickPick = pick;
    }
    requestId = panel?.webview.html.match(/data-request-id="([^"]+)"/)?.[1];
    if (!requestId) throw new Error('Missing the request id');
  }
  for (let i = 0; i < fresh; i++) {
    panel?.dispose();
    samples.push(await time('new panel', () => open(requestId!)));
  }
  panel?.dispose();
  await writeFile(out, JSON.stringify({ requestId, samples }));
}
