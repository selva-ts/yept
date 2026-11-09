import type { PanelStateMessage } from '../panel-state';

type State = Omit<PanelStateMessage['panelState'], 'requestId'>;

/**
 * Tells the extension about the request's unsaved state and the past run it shows. A change of name, of saved/unsaved
 * or of the run shown is sent at once (the tab title and the History view follow it); further edits are sent at most every `delay` ms, so closing the panel can save the latest
 * draft. Returns a function that stops watching.
 */
export function watchPanelState(requestId: string, read: () => State | undefined, subscribe: (listener: () => void) => () => void, post: (message: PanelStateMessage) => void, delay = 150): () => void {
  let sent: State | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (): void => {
    timer = undefined;
    const state = read();
    if (!state || (sent && sent.name === state.name && sent.dirty === state.dirty && sent.draft === state.draft && sent.viewing === state.viewing)) return;
    sent = state;
    post({ panelState: { requestId, ...state } });
  };
  const changed = (): void => {
    const state = read();
    if (!state) return;
    if (!sent || sent.name !== state.name || sent.dirty !== state.dirty || sent.viewing !== state.viewing) {
      if (timer) clearTimeout(timer);
      send();
    } else if (sent.draft !== state.draft) {
      timer ??= setTimeout(send, delay);
    }
  };
  const unsubscribe = subscribe(changed);
  changed();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
