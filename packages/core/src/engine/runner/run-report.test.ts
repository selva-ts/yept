// Run reports: JUnit XML is well formed, escapes text and has a case per test grouped by request and iteration; the
// HTML report escapes text and loads nothing from anywhere.
import { describe, expect, it } from 'vitest';
import { summarize, type RunnerStep } from '../../shared/collection-run';
import { escapeXml, htmlReport, junitReport, type ReportStep, type RunReport } from './run-report';

const step = (over: Partial<ReportStep>): ReportStep => ({
  requestId: 'r1', name: 'Login', method: 'POST', folder: 'Auth', iteration: 1, runId: 'run', status: 'passed',
  httpStatus: 200, durationMs: 12, tests: { passed: 0, failed: 0, errors: 0 }, testResults: [], ...over
});
const report = (steps: ReportStep[], over: Partial<RunReport> = {}): RunReport => ({
  name: 'Sample <Travel>', kind: 'collection', environment: 'local', iterations: 1, delayMs: 0, startedAt: '2026-01-02T03:04:05.000Z',
  durationMs: 1234, ended: 'completed', steps, summary: summarize(steps as RunnerStep[]), ...over
});

/** Checks XML is well formed enough for a CI parser: one root, tags balanced, attributes quoted, no bare & or <. */
function wellFormed(xml: string): string[] {
  const errors: string[] = [];
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  let roots = 0;
  while ((m = re.exec(body))) {
    if (m[6]) { errors.push(`stray < at ${m.index}`); continue; }
    if (m[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) errors.push(`bare & in text at ${m.index}`);
      if (!stack.length && m[5].trim()) errors.push('text outside the root');
      continue;
    }
    const [, close, name, attrs, self] = m;
    if (/&(?!(amp|lt|gt|quot|apos);)/.test(attrs)) errors.push(`bare & in attribute of ${name}`);
    if (close) {
      if (stack.pop() !== name) errors.push(`unbalanced </${name}>`);
    } else if (!self) {
      if (!stack.length) roots++;
      stack.push(name);
    } else if (!stack.length) roots++;
  }
  if (stack.length) errors.push(`unclosed ${stack.join(', ')}`);
  if (roots !== 1) errors.push(`${roots} root elements`);
  return errors;
}

describe('escapeXml', () => {
  it('escapes markup and drops characters XML cannot hold', () => {
    expect(escapeXml(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
    expect(escapeXml('bell\u0007 tab\t nl\n esc\u001b')).toBe('bell tab\t nl\n esc');
    expect(escapeXml('lone \uD800 surrogate, pair 😀')).toBe('lone  surrogate, pair 😀');
  });
});

describe('junitReport', () => {
  const steps: ReportStep[] = [
    step({
      url: 'https://api.example.test/auth?x=1&y=<2>',
      tests: { passed: 1, failed: 1, errors: 0 },
      reason: '1 test failed',
      status: 'failed',
      testResults: [
        { name: 'status is 200', kind: 'test', status: 'passed', source: 'request' },
        { name: 'body has "token" & <type>', kind: 'test', status: 'failed', message: 'expected <a> to equal "b"\nsecond line', source: 'request' }
      ]
    }),
    step({ name: 'List', method: 'GET', folder: '', status: 'error', httpStatus: undefined, reason: 'Connection failed: ECONNREFUSED' }),
    step({ name: 'Echo', method: 'GET', folder: '', status: 'no-tests' }),
    step({ name: 'Later', method: 'GET', folder: '', status: 'skipped', reason: 'Not run: stopped after "List" failed', httpStatus: undefined, durationMs: undefined }),
    step({
      name: 'Scripted', status: 'failed', reason: '1 test failed; Script error (post-response): boom',
      tests: { passed: 0, failed: 1, errors: 0 }, testResults: [{ name: 'ok', kind: 'assertion', status: 'failed', source: 'request' }]
    })
  ];

  it('is well formed and escapes every text', () => {
    const xml = junitReport(report(steps));
    expect(wellFormed(xml)).toEqual([]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Sample &lt;Travel&gt;"')).toBe(true);
    expect(xml).toContain('<property name="url" value="https://api.example.test/auth?x=1&amp;y=&lt;2&gt;"/>');
    expect(xml).toContain('<testcase name="body has &quot;token&quot; &amp; &lt;type&gt;"');
    // The message attribute is the first line; the whole message is the element's text.
    expect(xml).toContain('<failure message="expected &lt;a&gt; to equal &quot;b&quot;" type="test">expected &lt;a&gt; to equal &quot;b&quot;\nsecond line</failure>');
  });

  it('has a case per test, and one for the request when it failed outside its tests or has none', () => {
    const xml = junitReport(report(steps));
    expect(xml).toMatch(/<testsuites [^>]*tests="7" failures="3" errors="1" skipped="2" time="1.234"/);
    expect(xml).toContain('<testsuite name="Auth / Login" id="0" tests="2" failures="1" errors="0" skipped="0" time="0.012">');
    expect(xml).toContain('<error message="Connection failed: ECONNREFUSED">Connection failed: ECONNREFUSED</error>');
    expect(xml).toContain('<skipped message="No tests"/>');
    expect(xml).toContain('<skipped message="Not run: stopped after &quot;List&quot; failed"/>');
    expect(xml).toContain('<testcase name="assertion: ok"');
    expect(xml).toContain('<failure message="Script error (post-response): boom">');
  });

  it('groups by request and iteration', () => {
    const xml = junitReport(report([step({ iteration: 1 }), step({ iteration: 2 })], { iterations: 2 }));
    expect(wellFormed(xml)).toEqual([]);
    expect(xml).toContain('<testsuite name="Auth / Login (iteration 1)"');
    expect(xml).toContain('<testsuite name="Auth / Login (iteration 2)"');
    expect(xml).toContain('<property name="iteration" value="2"/>');
  });

  it('is well formed for an empty run', () => {
    expect(wellFormed(junitReport(report([])))).toEqual([]);
  });
});

describe('htmlReport', () => {
  const steps = [
    step({
      url: 'https://api.example.test/<script>alert(1)</script>',
      requestHeaders: [['Authorization', '«redacted»'], ['X-Note', '<b>bold</b>']],
      responseHeaders: [['Content-Type', 'application/json']],
      tests: { passed: 0, failed: 1, errors: 0 }, status: 'failed', reason: '1 test failed',
      testResults: [{ name: '<img src=x onerror=alert(1)>', kind: 'test', status: 'failed', message: 'expected 1 to equal 2', source: 'request' }]
    }),
    step({ iteration: 2, status: 'passed', tests: { passed: 1, failed: 0, errors: 0 }, testResults: [{ name: 'fine', kind: 'test', status: 'passed', source: 'request' }] })
  ];
  const page = htmlReport(report(steps, { iterations: 2, dataFile: 'users.csv', delayMs: 250 }));

  it('escapes everything taken from the run', () => {
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<img');
    expect(page).not.toContain('<b>bold');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).toContain('<title>Collection run: Sample &lt;Travel&gt;</title>');
  });

  it('is self-contained: no scripts and nothing loaded from elsewhere', () => {
    expect(page).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(page).not.toMatch(/<(script|link|img|iframe|object|embed)\b/i);
    expect(page).not.toMatch(/<[^>]*\s(src|href)=/i);
    expect(page).not.toMatch(/url\(/i);
    expect(page).not.toMatch(/@import/i);
  });

  it('shows the run, its iterations and each request with its details', () => {
    expect(page).toContain('environment local · data file users.csv · 2 iterations · 250 ms between requests');
    // A failed iteration is open; a passed one is closed.
    expect(page).toContain('<details class="iteration" open><summary><strong>Iteration 1</strong>');
    expect(page).toContain('<details class="iteration"><summary><strong>Iteration 2</strong>');
    expect(page).toContain('«redacted»');
    expect(page).toContain('expected 1 to equal 2');
    expect(page).toMatch(/Requests:<\/span> <span class="ok">1 passed<\/span> <span class="bad">1 failed<\/span>/);
  });
});
