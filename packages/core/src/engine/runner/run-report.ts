// Reports of a finished collection run: JUnit XML for CI tools and a self-contained HTML page. Both are built from the
// steps as history stores them (secrets and credential headers redacted), never from the live results.
import type { RunnerEnd, RunnerStep, RunnerSummary } from '../../shared/collection-run';

/** A step with the request and response details a report shows, already redacted. */
export interface ReportStep extends RunnerStep {
  url?: string;
  requestHeaders?: [string, string][];
  responseHeaders?: [string, string][];
}

export interface RunReport {
  /** Collection or folder name. */
  name: string;
  kind: 'collection' | 'folder';
  /** '' for none. */
  environment: string;
  /** The data file's name (not its path), if one was used. */
  dataFile?: string;
  iterations: number;
  delayMs: number;
  startedAt: string;
  durationMs: number;
  ended: RunnerEnd;
  steps: ReportStep[];
  summary: RunnerSummary;
}

// XML 1.0 can't hold most control characters, even escaped; they are dropped.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(text: string): string {
  return text.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const seconds = (ms: number | undefined): string => ((ms ?? 0) / 1000).toFixed(3);
const stepTitle = (s: RunnerStep): string => (s.folder ? `${s.folder} / ${s.name}` : s.name);
const suiteName = (s: RunnerStep, iterations: number): string => `${stepTitle(s)}${iterations > 1 ? ` (iteration ${s.iteration})` : ''}`;

interface Case {
  name: string;
  outcome?: { tag: 'failure' | 'error' | 'skipped'; message: string; type?: string };
}

/** One test case per test or assertion; a step without tests, or one that failed outside its tests, gets one for the request. */
function casesOf(s: RunnerStep): Case[] {
  const cases: Case[] = s.testResults.map((t) => ({
    name: t.kind === 'assertion' ? `assertion: ${t.name}` : t.name,
    outcome: t.status === 'passed' ? undefined : { tag: t.status === 'failed' ? 'failure' : 'error', message: t.message ?? (t.status === 'failed' ? 'Failed' : "Couldn't run"), type: t.kind }
  }));
  const reason = s.reason ?? '';
  const covered = s.tests.failed + s.tests.errors > 0;
  if (s.status === 'skipped' || s.status === 'cancelled') cases.push({ name: 'request', outcome: { tag: 'skipped', message: reason || 'Not run' } });
  else if (s.status === 'error') cases.push({ name: 'request', outcome: { tag: 'error', message: reason || 'No response' } });
  else if (s.status === 'failed' && !covered) cases.push({ name: 'request', outcome: { tag: 'failure', message: reason || 'Failed' } });
  else if (s.status === 'no-tests') cases.push({ name: 'request', outcome: { tag: 'skipped', message: 'No tests' } });
  else if (s.status === 'failed') {
    // Failed tests plus something else (a script error, say): the something else gets its own case.
    const other = reason.split('; ').filter((p) => p && !/^\d+ tests? (failed|couldn't run)$/.test(p));
    if (other.length) cases.push({ name: 'request', outcome: { tag: 'failure', message: other.join('; ') } });
  }
  return cases;
}

/** JUnit XML: a test suite per request and iteration, a test case per test. */
export function junitReport(r: RunReport): string {
  const out: string[] = [];
  const suites = r.steps.map((s) => ({ s, cases: casesOf(s) }));
  const count = (tag: string): number => suites.reduce((n, x) => n + x.cases.filter((c) => c.outcome?.tag === tag).length, 0);
  const total = suites.reduce((n, x) => n + x.cases.length, 0);
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<testsuites name="${escapeXml(r.name)}" tests="${total}" failures="${count('failure')}" errors="${count('error')}" skipped="${count('skipped')}" time="${seconds(r.durationMs)}" timestamp="${escapeXml(r.startedAt)}">`);
  suites.forEach(({ s, cases }, i) => {
    const n = (tag: string): number => cases.filter((c) => c.outcome?.tag === tag).length;
    out.push(`  <testsuite name="${escapeXml(suiteName(s, r.iterations))}" id="${i}" tests="${cases.length}" failures="${n('failure')}" errors="${n('error')}" skipped="${n('skipped')}" time="${seconds(s.durationMs)}">`);
    const props: [string, string][] = [['method', s.method], ['iteration', String(s.iteration)]];
    if (s.url) props.push(['url', s.url]);
    if (s.httpStatus !== undefined) props.push(['status', String(s.httpStatus)]);
    out.push('    <properties>');
    for (const [k, v] of props) out.push(`      <property name="${k}" value="${escapeXml(v)}"/>`);
    out.push('    </properties>');
    for (const c of cases) {
      const head = `    <testcase name="${escapeXml(c.name)}" classname="${escapeXml(suiteName(s, r.iterations))}" time="0.000"`;
      if (!c.outcome) out.push(`${head}/>`);
      else if (c.outcome.tag === 'skipped') out.push(`${head}>\n      <skipped message="${escapeXml(c.outcome.message)}"/>\n    </testcase>`);
      else out.push(`${head}>\n      <${c.outcome.tag} message="${escapeXml(firstLine(c.outcome.message))}"${c.outcome.type ? ` type="${escapeXml(c.outcome.type)}"` : ''}>${escapeXml(c.outcome.message)}</${c.outcome.tag}>\n    </testcase>`);
    }
    out.push('  </testsuite>');
  });
  out.push('</testsuites>');
  return `${out.join('\n')}\n`;
}

const firstLine = (s: string): string => s.split(/\r?\n/)[0];

const html = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATUS: Record<RunnerStep['status'], string> = {
  pending: 'Not run', running: 'Not run', passed: 'Passed', failed: 'Failed', error: 'Error', 'no-tests': 'No tests', cancelled: 'Cancelled', skipped: 'Not run'
};
const ENDED: Record<RunnerEnd, string> = { completed: 'Finished', stopped: 'Stopped after a failure', cancelled: 'Cancelled' };

const formatMs = (ms: number | undefined): string => (ms === undefined ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

function headersTable(title: string, headers: [string, string][] | undefined): string {
  if (!headers?.length) return '';
  return `<p class="label">${html(title)}</p><table class="kv">${headers.map(([k, v]) => `<tr><td>${html(k)}</td><td>${html(v)}</td></tr>`).join('')}</table>`;
}

function stepHtml(s: ReportStep, index: number): string {
  const tests = s.tests.passed + s.tests.failed + s.tests.errors;
  const details = [
    s.url ? `<p class="mono">${html(s.method)} ${html(s.url)}</p>` : '',
    s.reason ? `<p class="${s.status === 'skipped' || s.status === 'cancelled' ? 'mute' : 'bad'}">${html(s.reason)}</p>` : '',
    s.testResults.length
      ? `<ul class="tests">${s.testResults.map((t) => `<li class="${t.status}"><span>${t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '⚠'}</span> ${html(t.name)}${t.kind === 'assertion' ? ' <span class="mute">· assertion</span>' : ''}${t.message && t.status !== 'passed' ? `<div class="mono msg">${html(t.message)}</div>` : ''}</li>`).join('')}</ul>`
      : '',
    headersTable('Request headers', s.requestHeaders),
    headersTable('Response headers', s.responseHeaders)
  ].join('');
  return `<tr class="step ${s.status}"><td class="mute">${index + 1}</td><td><span class="badge ${s.status}">${STATUS[s.status]}</span></td><td class="mono">${html(s.method)}</td>`
    + `<td>${details ? `<details><summary>${html(s.name)}${s.folder ? ` <span class="mute">· ${html(s.folder)}</span>` : ''}</summary>${details}</details>` : `${html(s.name)}${s.folder ? ` <span class="mute">· ${html(s.folder)}</span>` : ''}`}</td>`
    + `<td class="mono">${s.httpStatus ?? ''}</td><td class="mono">${tests ? `${s.tests.passed}/${tests}` : '—'}</td><td class="mono mute">${formatMs(s.durationMs)}</td></tr>`;
}

function countsHtml(sum: RunnerSummary): string {
  const parts: [number, string, string][] = [
    [sum.passed, 'passed', 'ok'], [sum.failed, 'failed', 'bad'], [sum.errors, sum.errors === 1 ? 'error' : 'errors', 'bad'],
    [sum.noTests, 'without tests', 'mute'], [sum.cancelled, 'cancelled', 'mute'], [sum.skipped, 'not run', 'mute']
  ];
  return parts.filter(([n], i) => n > 0 || i === 0).map(([n, w, c]) => `<span class="${n ? c : 'mute'}">${n} ${w}</span>`).join(' ');
}

/** A self-contained HTML page: inline styles, no scripts, nothing loaded from anywhere. */
export function htmlReport(r: RunReport): string {
  const title = `${r.kind === 'collection' ? 'Collection' : 'Folder'} run: ${r.name}`;
  const facts = [
    ENDED[r.ended],
    r.environment ? `environment ${r.environment}` : 'no environment',
    r.dataFile ? `data file ${r.dataFile}` : '',
    r.iterations > 1 ? `${r.iterations} iterations` : '',
    r.delayMs ? `${r.delayMs} ms between requests` : '',
    `started ${r.startedAt}`,
    `took ${formatMs(r.durationMs)}`
  ].filter(Boolean);
  const groups = new Map<number, { steps: ReportStep[]; start: number }>();
  r.steps.forEach((s, i) => {
    const g = groups.get(s.iteration) ?? { steps: [], start: i };
    g.steps.push(s);
    groups.set(s.iteration, g);
  });
  const head = '<thead><tr><th>#</th><th>Result</th><th>Method</th><th>Request</th><th>Status</th><th>Tests</th><th>Time</th></tr></thead>';
  const table = (steps: ReportStep[], start: number): string => `<table class="steps">${head}<tbody>${steps.map((s, i) => stepHtml(s, start + i)).join('')}</tbody></table>`;
  let body: string;
  if (r.iterations > 1) {
    body = [...groups.entries()].map(([n, g]) => {
      const bad = g.steps.some((s) => s.status === 'failed' || s.status === 'error');
      const passed = g.steps.filter((s) => s.status === 'passed').length;
      return `<details class="iteration"${bad ? ' open' : ''}><summary><strong>Iteration ${n}</strong> <span class="${bad ? 'bad' : 'mute'}">${passed}/${g.steps.length} passed</span></summary>${table(g.steps, g.start)}</details>`;
    }).join('');
  } else body = table(r.steps, 0);
  const css = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --mute: #656d76; --line: #d0d7de; --ok: #1a7f37; --bad: #cf222e; --chip: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --mute: #8d96a0; --line: #30363d; --ok: #3fb950; --bad: #f85149; --chip: #161b22; } }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
.mute { color: var(--mute); } .ok { color: var(--ok); } .bad { color: var(--bad); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
.counts span { margin-right: 10px; }
table.steps { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
table.steps th, table.steps td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.steps th { font-weight: 600; color: var(--mute); font-size: 12px; }
.badge { display: inline-block; padding: 0 6px; border-radius: 4px; background: var(--chip); font-size: 12px; white-space: nowrap; }
.badge.passed { color: var(--ok); } .badge.failed, .badge.error { color: var(--bad); }
details summary { cursor: pointer; }
details.iteration { border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; margin: 8px 0; }
ul.tests { margin: 6px 0; padding-left: 0; list-style: none; }
ul.tests li.passed span { color: var(--ok); } ul.tests li.failed span, ul.tests li.error span { color: var(--bad); }
.msg { color: var(--mute); margin-left: 18px; white-space: pre-wrap; }
.label { margin: 8px 0 2px; color: var(--mute); font-size: 12px; }
table.kv { border-collapse: collapse; } table.kv td { padding: 1px 12px 1px 0; font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>${css}</style>
</head>
<body>
<h1>${html(title)}</h1>
<p class="mute">${facts.map(html).join(' · ')}</p>
<p class="counts"><span class="mute">Requests:</span> ${countsHtml(r.summary)}</p>
<p class="counts"><span class="mute">Tests:</span> <span class="${r.summary.tests.passed ? 'ok' : 'mute'}">${r.summary.tests.passed} passed</span> <span class="${r.summary.tests.failed ? 'bad' : 'mute'}">${r.summary.tests.failed} failed</span>${r.summary.tests.errors ? ` <span class="bad">${r.summary.tests.errors} couldn't run</span>` : ''}</p>
${body}
<p class="mute">Secrets and credential headers are redacted, as in history.</p>
</body>
</html>
`;
}
