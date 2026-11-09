import type { RequestDoc } from '@yept/core/shared/model';
import { requestDoc } from './validation';

/**
 * What a request panel's page tells the extension, sent as it changes: its request's name, its unsaved edits and the
 * past run it shows (for the History view).
 */
export interface PanelStateMessage {
  panelState: { requestId: string; name: string; dirty: boolean; draft: RequestDoc | null; viewing?: string | null };
}

export interface PanelState {
  name: string;
  dirty: boolean;
  /** The unsaved request, kept so closing the panel can still save it. Null while there is nothing to save. */
  draft: RequestDoc | null;
  /** The run id of the past run the page shows instead of the latest one, or null. */
  viewing: string | null;
}

/** The tab title: the request's name, with a dot while it has unsaved changes. */
export const panelTitle = (name: string, dirty: boolean): string => (dirty ? `● ${name}` : name);

/**
 * Checks a panel state message from the page showing `requestId`. Anything else, or a malformed message, is ignored
 * (undefined). A dirty state must carry a valid request document, so what closing saves is checked like any save.
 */
export function checkPanelState(message: unknown, requestId: string): PanelState | undefined {
  if (!message || typeof message !== 'object' || !('panelState' in message)) return undefined;
  const state = (message as Partial<PanelStateMessage>).panelState as Record<string, unknown> | undefined;
  if (!state || typeof state !== 'object' || state.requestId !== requestId) return undefined;
  const { name, dirty, draft } = state;
  const viewing = state.viewing ?? null;
  if (typeof name !== 'string' || typeof dirty !== 'boolean' || (viewing !== null && typeof viewing !== 'string')) return undefined;
  if (!dirty) return { name, dirty, draft: null, viewing };
  try {
    requestDoc(draft);
  } catch {
    return undefined;
  }
  return { name, dirty, draft, viewing };
}
