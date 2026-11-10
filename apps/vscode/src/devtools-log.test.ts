import { expect, it } from 'vitest';
import { DevToolsLog, MAX_RUNS, type DevToolsEvent } from './devtools-log';

const start = (runId: string): DevToolsEvent => ({ channel: 'devtools:run', payload: { type: 'start', runId, requestId: 'r', requestName: 'Request', collectionId: 'c', environment: '', method: 'GET', url: 'https://api.example.test/' } });
const end = (runId: string): DevToolsEvent => ({ channel: 'devtools:run', payload: { type: 'end', runId, collectionId: 'c', result: null, error: 'failed' } });
const step = (runId: string): DevToolsEvent => ({
  channel: 'runner:event',
  payload: { runnerId: 'x', type: 'step-start', index: 0, collectionId: 'c', environment: '', url: '', step: { requestId: 'r', name: 'n', method: 'GET', folder: '', iteration: 1, runId, status: 'running', tests: { passed: 0, failed: 0, errors: 0 }, testResults: [] } }
});
const ids = (log: DevToolsLog): string[] => log.all().map((e) => (e.channel === 'devtools:run' ? `${e.payload.type}:${e.payload.runId}` : `step:${e.payload.step.runId}`));

it('keeps sends and their ends in order', () => {
  const log = new DevToolsLog();
  log.add(start('a'));
  log.add(step('b'));
  log.add(end('a'));
  expect(ids(log)).toEqual(['start:a', 'step:b', 'end:a']);
});

it('keeps the last sends only, dropping the oldest with what followed it', () => {
  const log = new DevToolsLog();
  for (let i = 0; i < MAX_RUNS; i++) {
    log.add(start(`r${i}`));
    log.add(end(`r${i}`));
  }
  expect(log.all().length).toBe(MAX_RUNS * 2);
  log.add(start('new'));
  expect(ids(log).slice(0, 2)).toEqual(['start:r1', 'end:r1']);
  expect(ids(log).at(-1)).toBe('start:new');
  expect(log.all().length).toBe(MAX_RUNS * 2 - 1);
});

it('forgets everything on clear', () => {
  const log = new DevToolsLog();
  log.add(start('a'));
  log.clear();
  expect(log.all()).toEqual([]);
  for (let i = 0; i <= MAX_RUNS; i++) log.add(start(`r${i}`));
  expect(log.all().length).toBe(MAX_RUNS);
});
