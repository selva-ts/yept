import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HandlerRegistry } from '@yept/core/shared/handler-registry';
import type { HostEvents } from '@yept/core/shared/ipc';
import { DevToolsLog, type DevToolsEvent } from './devtools-log';
import { checkDevToolsState, type DevToolsState } from './page-reports';
import { pageHtml } from './panel';
import { bindWebview, extendRegistry, type WebviewBinding } from './webview-binding';

export const DEV_TOOLS_VIEW = 'yept.devtools';

type Context = HostEvents['devtools:context'];

/**
 * The Dev Tools view in the bottom panel: Console, Network and Cookies for the sends of every request panel and of the
 * collection runner. Sends are recorded from the start, so the view shows them whenever it is first opened.
 */
export class DevToolsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly log = new DevToolsLog();
  private readonly registration: vscode.Disposable;
  private view: vscode.WebviewView | undefined;
  private binding: WebviewBinding | undefined;
  /** Set once the page has asked for what happened before it loaded; events are sent live from then on. */
  private ready = false;
  private context: Context = { snapshot: null, requestId: null, collectionId: null };
  private pendingSelect: string | undefined;
  /** What the page last reported it holds. */
  private shownState: DevToolsState | undefined;

  /** `channels` answers the page's calls (cookies, copies with secrets, the clipboard, opening a run's request). */
  constructor(private readonly resources: vscode.Uri, private readonly channels: HandlerRegistry) {
    this.registration = vscode.window.registerWebviewViewProvider(DEV_TOOLS_VIEW, this, { webviewOptions: { retainContextWhenHidden: true } });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    this.shownState = undefined;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.resources] };
    const binding = bindWebview(view.webview, extendRegistry(this.channels, {
      'devtools:ready': () => {
        // Sent in one go, so nothing that happens meanwhile can come before them or twice.
        for (const e of this.log.all()) binding.emit(e.channel, e.payload as never);
        binding.emit('devtools:context', this.context);
        if (this.pendingSelect) binding.emit('devtools:select', { runId: this.pendingSelect });
        this.pendingSelect = undefined;
        this.ready = true;
      }
    }));
    this.binding = binding;
    const messages = view.webview.onDidReceiveMessage((message) => {
      const state = checkDevToolsState(message);
      if (!state) return;
      this.shownState = state;
      // Clear in the view: forget the sends kept for it too.
      if (!state.runs && !state.lines) this.log.clear();
    });
    view.onDidDispose(() => {
      messages.dispose();
      binding.dispose();
      if (this.view === view) {
        this.view = undefined;
        this.binding = undefined;
        this.ready = false;
      }
    });
    view.webview.html = pageHtml(view.webview, this.resources, randomBytes(24).toString('base64'), 'devtools.js');
  }

  /** Records a send (or its end) and shows it when the view is open. */
  record(event: DevToolsEvent): void {
    this.log.add(event);
    if (this.ready) this.binding?.emit(event.channel, event.payload as never);
  }

  /** The panel last focused, for "Current request only" and the Cookies tab. */
  setContext(context: Context): void {
    this.context = context;
    if (this.ready) this.binding?.emit('devtools:context', context);
  }

  /** Opens the view and selects a run in its Network tab. */
  async showRun(runId: string): Promise<void> {
    if (this.ready) this.binding?.emit('devtools:select', { runId });
    else this.pendingSelect = runId;
    await vscode.commands.executeCommand(`${DEV_TOOLS_VIEW}.focus`);
  }

  /** For the tests: whether the page has loaded, and what it holds. */
  state(): { resolved: boolean; ready: boolean; shown: DevToolsState | undefined } {
    return { resolved: !!this.view, ready: this.ready, shown: this.shownState };
  }

  dispose(): void {
    this.registration.dispose();
    this.binding?.dispose();
  }
}
