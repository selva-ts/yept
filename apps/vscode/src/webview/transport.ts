import type { Invoke, Subscribe } from '@yept/core/shared/create-api';
import { HOST_EVENTS } from '@yept/core/shared/ipc';
import { requestMessage, type MessageId } from '@yept/core/shared/webview-protocol';

/** The part of acquireVsCodeApi() the transport uses. */
export interface WebviewHost {
  postMessage(message: unknown): void;
}

/** Where the host's messages arrive: the webview's window. */
export interface MessageSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * Carries API calls over webview messages. Replies settle the request with the same id; an error reply rejects with
 * the host's message, which keeps the error prefix the UI strips. Events reach the subscribers of their channel only.
 */
export function createWebviewTransport(host: WebviewHost, source: MessageSource): { invoke: Invoke; subscribe: Subscribe } {
  let nextId = 1;
  const pending = new Map<MessageId, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const events = new Set<string>(HOST_EVENTS);

  source.addEventListener('message', ({ data }) => {
    if (typeof data !== 'object' || data === null) return;
    if ('id' in data) {
      const call = pending.get(data.id);
      if (!call) return;
      pending.delete(data.id);
      if ('error' in data) call.reject(new Error(String(data.error)));
      else call.resolve(data.result);
    } else if ('event' in data && typeof data.event === 'string' && events.has(data.event)) {
      for (const listener of [...listeners.get(data.event) ?? []]) listener(data.payload);
    }
  });

  const invoke: Invoke = (channel, ...args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      host.postMessage(requestMessage(id, channel, args));
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });

  const subscribe: Subscribe = (channel, cb) => {
    const listener = (event: unknown): void => cb(event as Parameters<typeof cb>[0]);
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, set = new Set());
    set.add(listener);
    return () => { set.delete(listener); };
  };

  return { invoke, subscribe };
}
