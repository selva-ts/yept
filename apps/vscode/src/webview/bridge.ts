import { createApi } from '@yept/core/shared/create-api';
import type { PanelStateMessage } from '../panel-state';
import { createWebviewTransport } from './transport';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

// The entry imports this module first: the shared UI reads window.yept when its modules load.
const vscodeApi = acquireVsCodeApi();
const { invoke, subscribe } = createWebviewTransport(vscodeApi, window);
window.yept = createApi(async (channel, ...args) => {
  try { return await invoke(channel, ...args); }
  catch (error) {
    if (String(error).includes('Unknown channel:')) window.dispatchEvent(new CustomEvent('yept-unavailable', { detail: 'This action is not available in the extension yet' }));
    throw error;
  }
}, subscribe);

/** The extension asks for the environment editor from its status bar, tree and commands. */
export const onManageEnvironments = (cb: (collectionId: string) => void): (() => void) => subscribe('environments:manage', (e) => cb(e.collectionId));

/** The extension's History view asks to show a past run, or to restore its request into the draft. */
export const onHistoryEntry = (cb: (runId: string, action: 'open' | 'restore' | 'show') => void): (() => void) => subscribe('history:entry', (e) => cb(e.runId, e.action));

/** Asks the extension to open a run's whole response body in a read-only editor. The body stays on the extension's side. */
export const openBodyInEditor = (runId: string): Promise<void> => invoke('runs:open-body', runId);

/** Calls a channel only the extension's runner and Dev Tools pages use. */
export const callHost = (channel: string, ...args: unknown[]): Promise<unknown> => invoke(channel, ...args);

/** Subscribes to a host event. */
export const onHostEvent = subscribe;

/** Sends the extension what a page shows, for its title, status bar and tests. */
export const postToHost = (message: unknown): void => vscodeApi.postMessage(message);

/** Tells the extension the request's name and unsaved edits, for the tab title and the prompt on close. */
export const postPanelState = (message: PanelStateMessage): void => vscodeApi.postMessage(message);
