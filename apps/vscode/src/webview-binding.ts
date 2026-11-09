import { HandlerRegistry } from '@yept/core/shared/handler-registry';
import { HOST_EVENTS, IPC_ERROR_PREFIX, type HostEvents } from '@yept/core/shared/ipc';
import { checkRequest, type EventMessage, type MessageId, type ResponseMessage } from '@yept/core/shared/webview-protocol';

/** The part of vscode.Webview the binding uses. */
export interface WebviewPort {
  onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): unknown };
  postMessage(message: unknown): PromiseLike<boolean>;
}

export interface WebviewBinding {
  /** Pushes a host event to the webview. Channels outside the host event map are not sent. */
  emit<K extends keyof HostEvents>(channel: K, event: HostEvents[K]): void;
  dispose(): void;
}

// Message only, as over Electron IPC: no stack trace, no error class.
const errorReply = (id: MessageId, e: unknown): ResponseMessage => ({ id, error: IPC_ERROR_PREFIX + (e instanceof Error ? e.message : String(e)) });

/** Answers one webview's API calls from the registered channels; malformed messages are ignored. */
export function bindWebview(webview: WebviewPort, registry: HandlerRegistry): WebviewBinding {
  const channels = new Set(registry.channels());
  const events = new Set<string>(HOST_EVENTS);
  let disposed = false;
  const send = async (message: ResponseMessage | EventMessage): Promise<void> => {
    if (disposed) return;
    try {
      await webview.postMessage(message);
    } catch (e) {
      // A result VS Code can't serialise still settles the call, as a failed structured clone does on the desktop.
      if ('id' in message && !('error' in message)) await send(errorReply(message.id, e));
    }
  };
  const subscription = webview.onDidReceiveMessage(async (message) => {
    const checked = checkRequest(message, (channel) => channels.has(channel));
    if (!checked) return;
    if ('reply' in checked) return send(checked.reply);
    const { id, channel, args } = checked.request;
    let response: ResponseMessage;
    try {
      response = { id, result: await registry.invoke(channel, ...args) };
    } catch (e) {
      response = errorReply(id, e);
    }
    await send(response);
  });
  return {
    emit: (channel, event) => { if (events.has(channel)) void send({ event: channel, payload: event }); },
    dispose: () => {
      disposed = true;
      subscription.dispose();
    }
  };
}

/** A registry with every channel of `base` (answered by it) and the channels in `extra`, for a page that needs both. */
export function extendRegistry(base: HandlerRegistry, extra: Record<string, (...args: any[]) => unknown>): HandlerRegistry {
  const registry = new HandlerRegistry();
  for (const channel of base.channels()) if (!(channel in extra)) registry.register(channel, (...args: unknown[]) => base.invoke(channel, ...args));
  for (const [channel, fn] of Object.entries(extra)) registry.register(channel, fn);
  return registry;
}
