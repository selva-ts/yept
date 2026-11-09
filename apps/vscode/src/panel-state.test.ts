import { describe, expect, it } from 'vitest';
import { newRequestItem, toRequestDoc } from '@yept/core/engine/workspace/bruno-adapter';
import { checkPanelState, panelTitle } from './panel-state';

const draft = { ...toRequestDoc(newRequestItem('Login', 1)), name: 'Login' };

describe('panel state', () => {
  it('marks unsaved changes in the title', () => {
    expect(panelTitle('Login', false)).toBe('Login');
    expect(panelTitle('Login', true)).toBe('● Login');
  });

  it('accepts the state of the panel\'s own request', () => {
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: true, draft } }, 'r1')).toEqual({ name: 'Login', dirty: true, draft, viewing: null });
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: false, draft } }, 'r1')).toEqual({ name: 'Login', dirty: false, draft: null, viewing: null });
  });

  it('passes on the past run the page shows', () => {
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: false, draft: null, viewing: 'run-1' } }, 'r1')?.viewing).toBe('run-1');
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: false, draft: null, viewing: null } }, 'r1')?.viewing).toBeNull();
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: false, draft: null, viewing: 7 } }, 'r1')).toBeUndefined();
  });

  it('ignores other requests, API calls and malformed states', () => {
    expect(checkPanelState({ panelState: { requestId: 'r2', name: 'Login', dirty: false, draft: null } }, 'r1')).toBeUndefined();
    expect(checkPanelState({ id: 1, channel: 'requests:get', args: ['r1'] }, 'r1')).toBeUndefined();
    expect(checkPanelState(null, 'r1')).toBeUndefined();
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 3, dirty: false } }, 'r1')).toBeUndefined();
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: 'yes' } }, 'r1')).toBeUndefined();
  });

  it('needs a valid request document for unsaved changes, so closing never saves anything else', () => {
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: true, draft: null } }, 'r1')).toBeUndefined();
    expect(checkPanelState({ panelState: { requestId: 'r1', name: 'Login', dirty: true, draft: { ...draft, method: 'BREW' } } }, 'r1')).toBeUndefined();
  });
});
