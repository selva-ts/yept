import type { HistorySummary } from '@yept/core/shared/model';

const OUTCOMES: Record<string, string> = { network: 'Connection failed', timeout: 'Timed out', cancelled: 'Cancelled', prepare_error: 'Not sent' };

/** The method and the status, or what happened instead of a response. */
export const historyLabel = (h: HistorySummary): string => `${h.method} ${h.outcome === 'http' ? h.status : (OUTCOMES[h.outcome] ?? h.outcome)}`;

export const formatDuration = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);

const formatSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

/** The time a run started: the time alone for today, else the date too (as the desktop's history list shows it). */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString() : `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export const historyDescription = (h: HistorySummary, now = new Date()): string => `${formatWhen(h.startedAt, now)} · ${formatDuration(h.durationMs)}`;

/** The URL (redacted when stored), environment, size and tests. */
export function historyTooltip(h: HistorySummary): string {
  const tests = h.testsState === 'ran' ? `tests ${h.passed}/${h.passed + h.failed + h.errors} passed` : h.testsState === 'not-run' ? 'tests not run' : undefined;
  return [h.url, `${h.environment || 'no environment'} · ${formatSize(h.sizeBytes)}${tests ? ` · ${tests}` : ''}`].join('\n');
}

/** A codicon and theme colour for the outcome: success, client error, server error or no response. */
export function historyIcon(h: HistorySummary): { id: string; color: string } {
  if (h.outcome === 'cancelled') return { id: 'circle-slash', color: 'disabledForeground' };
  if (h.outcome !== 'http') return { id: 'error', color: 'testing.iconFailed' };
  const status = h.status ?? 0;
  if (status >= 500) return { id: 'error', color: 'testing.iconFailed' };
  if (status >= 400) return { id: 'warning', color: 'list.warningForeground' };
  return { id: 'pass', color: 'testing.iconPassed' };
}
