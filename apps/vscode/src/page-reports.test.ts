import { expect, it } from 'vitest';
import { checkDevToolsState, checkRunnerState, runnerProgress, type RunnerState } from './page-reports';

const state: RunnerState = {
  target: { nodeId: 'n', name: 'Sample', kind: 'collection' },
  planned: 3,
  run: { runnerId: 'r', running: true, ended: null, steps: [{ name: 'A', status: 'passed', httpStatus: 200 }, { name: 'B', status: 'running' }, { name: 'C', status: 'pending' }] }
};

it('accepts a runner page state and rejects anything malformed', () => {
  expect(checkRunnerState({ runnerState: state })).toEqual(state);
  expect(checkRunnerState({ runnerState: { target: null, planned: 0, run: null } })).toEqual({ target: null, planned: 0, run: null });
  for (const bad of [null, {}, { panelState: {} }, { runnerState: { ...state, planned: -1 } }, { runnerState: { ...state, target: { ...state.target, kind: 'request' } } },
    { runnerState: { ...state, run: { ...state.run, steps: [{ name: 'A', status: 'unknown' }] } } }, { runnerState: { ...state, run: { ...state.run, running: 'yes' } } }]) {
    expect(checkRunnerState(bad)).toBeUndefined();
  }
});

it('accepts a Dev Tools page state', () => {
  expect(checkDevToolsState({ devtoolsState: { runs: 2, lines: 5 } })).toEqual({ runs: 2, lines: 5 });
  expect(checkDevToolsState({ devtoolsState: { runs: 2 } })).toBeUndefined();
  expect(checkDevToolsState({ runnerState: state })).toBeUndefined();
});

it('shows the progress of a run going on, as the desktop status bar does', () => {
  expect(runnerProgress(state)).toBe('2/3');
  expect(runnerProgress({ ...state, run: { ...state.run!, running: false } })).toBeUndefined();
  expect(runnerProgress(undefined)).toBeUndefined();
});
