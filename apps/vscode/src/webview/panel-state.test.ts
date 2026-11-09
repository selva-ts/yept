import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestDoc } from '@yept/core/shared/model';
import { newRequestItem, toRequestDoc } from '@yept/core/engine/workspace/bruno-adapter';
import type { PanelStateMessage } from '../panel-state';
import { watchPanelState } from './panel-state';

type State = { name: string; dirty: boolean; draft: RequestDoc | null; viewing?: string | null } | undefined;

function setup(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  const posted: PanelStateMessage['panelState'][] = [];
  const stop = watchPanelState('r1', () => state, (l) => { listeners.add(l); return () => listeners.delete(l); }, (m) => posted.push(m.panelState), 150);
  const set = (next: State): void => { state = next; for (const l of listeners) l(); };
  return { posted, set, stop, listeners };
}

describe('watchPanelState', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports the loaded request at once, and nothing before it loads', () => {
    const { posted, set } = setup(undefined);
    expect(posted).toEqual([]);
    set({ name: 'Login', dirty: false, draft: null });
    expect(posted).toEqual([{ requestId: 'r1', name: 'Login', dirty: false, draft: null }]);
  });

  it('reports becoming unsaved and saved again at once', () => {
    const { posted, set } = setup({ name: 'Login', dirty: false, draft: null });
    const draft = { ...toRequestDoc(newRequestItem('Login', 1)), name: 'Login', url: 'x' };
    set({ name: 'Login', dirty: true, draft });
    set({ name: 'Login', dirty: false, draft: null });
    expect(posted.map((p) => p.dirty)).toEqual([false, true, false]);
  });

  it('sends further edits at most every delay, the latest one last', () => {
    const first = { ...toRequestDoc(newRequestItem('Login', 1)), name: 'Login', url: 'a' };
    const { posted, set } = setup({ name: 'Login', dirty: true, draft: first });
    for (const url of ['ab', 'abc', 'abcd']) set({ name: 'Login', dirty: true, draft: { ...first, url } });
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(150);
    expect(posted).toHaveLength(2);
    expect(posted[1].draft?.url).toBe('abcd');
  });

  it('reports the past run shown at once', () => {
    const { posted, set } = setup({ name: 'Login', dirty: false, draft: null, viewing: null });
    set({ name: 'Login', dirty: false, draft: null, viewing: 'run-1' });
    set({ name: 'Login', dirty: false, draft: null, viewing: null });
    expect(posted.map((p) => p.viewing)).toEqual([null, 'run-1', null]);
  });

  it('reports a rename at once and stops when asked', () => {
    const { posted, set, stop, listeners } = setup({ name: 'Login', dirty: false, draft: null });
    set({ name: 'Sign in', dirty: false, draft: null });
    expect(posted.at(-1)?.name).toBe('Sign in');
    stop();
    expect(listeners.size).toBe(0);
  });
});
