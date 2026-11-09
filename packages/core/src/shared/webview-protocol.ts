// Messages between a VS Code webview and its extension host. VS Code sends them as JSON in both directions.
import { IPC_ERROR_PREFIX, type HostEvents } from './ipc';

export type MessageId = string | number;

/** Webview to host: one API call. */
export interface RequestMessage {
  id: MessageId;
  channel: string;
  args: unknown[];
}

/** Host to webview: the reply to the request with the same id. JSON drops an undefined result, so it may be absent. */
export type ResponseMessage = { id: MessageId; result?: unknown } | { id: MessageId; error: string };

/** Host to webview: a pushed event. */
export type EventMessage<K extends keyof HostEvents = keyof HostEvents> = { event: K; payload: HostEvents[K] };

/**
 * JSON turns an undefined array item into null, so trailing undefined arguments are left out. The handler then sees an
 * omitted optional argument as undefined, as it does over Electron IPC.
 */
export function requestMessage(id: MessageId, channel: string, args: unknown[]): RequestMessage {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  return { id, channel, args: args.slice(0, end) };
}

/**
 * Accepts a well-formed request for a known channel and answers an unknown channel with an error reply. Anything else
 * is malformed and gets null: there is no id to answer.
 */
export function checkRequest(message: unknown, known: (channel: string) => boolean): { request: RequestMessage } | { reply: ResponseMessage } | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const prototype = Object.getPrototypeOf(message);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const { id, channel, args } = message as Record<string, unknown>;
  if (!(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)))) return null;
  if (typeof channel !== 'string' || !Array.isArray(args)) return null;
  if (!known(channel)) return { reply: { id, error: `${IPC_ERROR_PREFIX}Unknown channel: ${channel}` } };
  return { request: { id, channel, args } };
}
