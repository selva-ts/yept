import { describe, expect, it } from 'vitest';
import type { HistorySummary } from '@yept/core/shared/model';
import { formatDuration, formatWhen, historyDescription, historyIcon, historyLabel, historyTooltip } from './history-tree-model';

const summary = (change: Partial<HistorySummary> = {}): HistorySummary => ({
  runId: 'run-1', requestId: 'r1', startedAt: '2026-03-04T10:15:30.000Z', environment: 'local', method: 'GET',
  url: 'https://api.example.test/bookings', outcome: 'http', status: 200, durationMs: 42, sizeBytes: 2048,
  passed: 2, failed: 0, errors: 0, testsState: 'ran', bodyTruncated: false, bodyOmitted: false,
  requestName: 'List bookings', requestPath: 'Bookings/List bookings.yml', ...change
});

describe('history tree items', () => {
  it('shows the method and status, or what happened instead', () => {
    expect(historyLabel(summary())).toBe('GET 200');
    expect(historyLabel(summary({ method: 'POST', status: 404 }))).toBe('POST 404');
    expect(historyLabel(summary({ outcome: 'timeout', status: undefined }))).toBe('GET Timed out');
    expect(historyLabel(summary({ outcome: 'network', status: undefined }))).toBe('GET Connection failed');
  });

  it('shows the time and the duration', () => {
    const started = new Date(2026, 2, 4, 10, 15, 30);
    const run = summary({ startedAt: started.toISOString(), durationMs: 1500 });
    expect(historyDescription(run, new Date(2026, 2, 4, 18, 0, 0))).toBe(`${started.toLocaleTimeString()} · 1.50 s`);
    expect(formatWhen(started.toISOString(), new Date(2026, 2, 5))).toBe(`${started.toLocaleDateString()} ${started.toLocaleTimeString()}`);
    expect(formatDuration(42)).toBe('42 ms');
  });

  it('puts the URL, environment, size and tests in the tooltip', () => {
    expect(historyTooltip(summary())).toBe('https://api.example.test/bookings\nlocal · 2.0 KB · tests 2/2 passed');
    expect(historyTooltip(summary({ environment: '', testsState: 'none', sizeBytes: 12 }))).toBe('https://api.example.test/bookings\nno environment · 12 B');
  });

  it('marks the outcome with an icon', () => {
    expect(historyIcon(summary()).id).toBe('pass');
    expect(historyIcon(summary({ status: 404 })).id).toBe('warning');
    expect(historyIcon(summary({ status: 503 })).id).toBe('error');
    expect(historyIcon(summary({ outcome: 'network', status: undefined })).id).toBe('error');
    expect(historyIcon(summary({ outcome: 'cancelled', status: undefined })).id).toBe('circle-slash');
  });
});
