// End-to-end: the collection runner. A whole collection runs in sidebar order with an environment chosen in the dialog
// (login → list → create → read → delete), with a results list and counts that keep request errors apart from failed
// tests; each request lands in Dev tools and history; a script's bru.sendRequest is not a step; stop on failure,
// Cancel, unsaved edits and the entry points (sidebar menus, collection overview, Home). Then a CSV data file: one
// iteration per row, with a delay between requests, grouped results, and JUnit and HTML reports.
// Usage: npm run build && node e2e/collection-runner.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer, CLIENT_SECRET } from '../fixtures/server/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e', 'out');
await fs.mkdir(out, { recursive: true });

const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-e2e-'));
const wsDir = join(tmp, 'ws');
const userData = join(tmp, 'user-data');
await fs.cp(join(root, 'fixtures', 'collections'), wsDir, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: wsDir }));

const indent = (text, n) => text.trim().split('\n').map((l) => `${' '.repeat(n)}${l.trim()}`).join('\n');
/** A request file: bearer auth with the token Login extracts unless `auth: false`. */
const requestFile = ({ name, seq, method = 'GET', url, json, extract, tests, script, timeout = 0, auth = true }) => `info:
  name: ${name}
  type: http
  seq: ${seq}

http:
  method: ${method}
  url: "${url}"
${json ? `  body:\n    type: json\n    data: |-\n${indent(json, 6)}\n` : ''}${auth ? '  auth:\n    type: bearer\n    token: "{{accessToken}}"\n' : ''}
runtime:
  scripts:
${script ? `    - type: before-request\n      code: |-\n${indent(script, 8)}\n` : ''}${tests ? `    - type: tests\n      code: |-\n${indent(tests, 8)}\n` : ''}${extract ? `  actions:\n    - type: set-variable\n      phase: after-response\n      selector:\n        expression: ${extract.expression}\n        method: jsonq\n      variable:\n        name: ${extract.name}\n        scope: runtime\n` : ''}
settings:
  encodeUrl: true
  timeout: ${timeout}
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: false
`;
const collectionDir = join(wsDir, 'sample-travel');
const write = async (folder, spec) => {
  await fs.mkdir(join(collectionDir, folder), { recursive: true });
  await fs.writeFile(join(collectionDir, folder, `${spec.name}.yml`), requestFile(spec));
};
// Bookings already has "List bookings" (seq 1). Folders without a folder file sort by name: Auth, Bookings, Checks, Slow.
await write('Bookings', { name: 'Create booking', seq: 2, method: 'POST', url: '{{baseUrl}}/bookings', json: '{ "traveller": "Alex Example", "destination": "Porto" }', extract: { expression: 'res.body.id', name: 'bookingId' }, tests: 'test("created", function () { expect(res.status).to.equal(201); });' });
await write('Bookings', { name: 'Read booking', seq: 3, url: '{{baseUrl}}/bookings/{{bookingId}}', tests: 'test("is the new booking", function () { expect(res.body.destination).to.equal("Porto"); });' });
await write('Bookings', { name: 'Delete booking', seq: 4, method: 'DELETE', url: '{{baseUrl}}/bookings/{{bookingId}}' });
await write('Bookings', { name: 'Read deleted booking', seq: 5, url: '{{baseUrl}}/bookings/{{bookingId}}', tests: 'test("is gone", function () { expect(res.status).to.equal(404); });' });
await write('Checks', { name: 'Echo', seq: 1, url: '{{baseUrl}}/echo', auth: false });
await write('Checks', { name: 'Scripted', seq: 2, url: '{{baseUrl}}/echo', auth: false, script: 'const r = await bru.sendRequest(bru.getEnvVar("baseUrl") + "/status/204"); bru.setVar("childStatus", String(r.status));', tests: 'test("the script request ran", function () { expect(bru.getVar("childStatus")).to.equal("204"); });' });
await write('Checks', { name: 'Missing page', seq: 3, url: '{{baseUrl}}/status/404', auth: false });
await write('Checks', { name: 'Unresolved', seq: 4, url: '{{baseUrl}}/{{notDefinedAnywhere}}', auth: false });
await write('Slow', { name: 'Hang', seq: 1, url: '{{baseUrl}}/hang', auth: false, timeout: 2500 });
await write('Slow', { name: 'After hang', seq: 2, url: '{{baseUrl}}/echo', auth: false });

const server = createFixtureServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// A collection for data files: the environment's name is overridden by each row; its test fails without a row.
const dataDir = join(wsDir, 'data-runs');
await fs.mkdir(join(dataDir, 'environments'), { recursive: true });
await fs.writeFile(join(dataDir, 'opencollection.yml'), 'opencollection: 1.0.0\n\ninfo:\n  name: Data Runs\n');
await fs.writeFile(join(dataDir, 'environments', 'local.yml'), `name: local\nvariables:\n  - name: baseUrl\n    value: ${base}\n  - name: name\n    value: from-env\n  - name: city\n    value: nowhere\n`);
await fs.writeFile(join(dataDir, 'Greet.yml'), requestFile({ name: 'Greet', seq: 1, url: '{{baseUrl}}/echo?name={{name}}&city={{city}}', auth: false, tests: 'test("uses the row", function () { expect(res.body.query.name).to.not.equal("from-env"); });' }));
const csv = join(tmp, 'people.csv');
await fs.writeFile(csv, '\uFEFFname,city\r\nAsha,Chennai\r\nRavi,"Pune, MH"\r\n"Meera ""M""",Delhi\r\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1440, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `collection-runner-${name}.png`) });
const dlg = page.getByRole('dialog', { name: 'Collection runner' });
const steps = dlg.locator('tbody tr.runner-step');
const stepTexts = async () => (await steps.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
const summary = () => dlg.getByRole('status', { name: 'Run summary' }).innerText().then((t) => t.replace(/\s+/g, ' '));
const finished = () => dlg.getByRole('button', { name: 'Run again' }).waitFor({ timeout: 30000 });
const contextMenu = async (kind, name) => page.locator(`.tree-row.${kind}`, { hasText: name }).first().click({ button: 'right' });
const historyOf = (name) => page.evaluate(async (n) => {
  const snap = await window.yept.workspace.restore();
  const find = (nodes) => { for (const x of nodes) { if (x.name === n && x.kind === 'request') return x; const c = x.children && find(x.children); if (c) return c; } };
  return (await window.yept.history.list(find(snap.collections).id)).length;
}, name);

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  // Home: the collection card's menu offers the runner.
  const card = page.locator('.collection-card', { hasText: 'Sample Travel' });
  await card.locator('summary').click();
  await card.getByRole('button', { name: 'Run collection' }).click();
  await dlg.waitFor({ timeout: 5000 });
  check('Home card menu opens the runner for the collection', (await dlg.locator('h3').innerText()).includes('Run collection "Sample Travel"'));
  await dlg.getByRole('button', { name: 'Close' }).click();
  await card.locator('summary').click();
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();

  // Environment values on this machine, but "local" is NOT made the active environment: the runner chooses it.
  await contextMenu('collection', 'Sample Travel');
  await page.getByRole('button', { name: 'Environments…' }).click();
  const envDlg = page.getByRole('dialog', { name: 'Environments' });
  await envDlg.getByLabel('Local override for baseUrl').fill(base);
  await envDlg.getByLabel('Local override for baseUrl').press('Enter');
  await envDlg.getByLabel('Secret value for clientSecret').fill(CLIENT_SECRET);
  await envDlg.getByLabel('Secret value for clientSecret').press('Enter');
  await page.waitForTimeout(300);
  await envDlg.getByRole('button', { name: 'Close' }).click();

  // 1. Entry point: the collection overview. The dialog lists every request in sidebar order before running.
  await page.locator('.collection-overview').getByRole('button', { name: 'Run collection' }).click();
  await dlg.waitFor({ timeout: 5000 });
  const planned = (await stepTexts()).map((t) => t.replace(/^\d+ Waiting /, ''));
  const order = ['POST Login · Auth', 'GET List bookings · Bookings', 'POST Create booking · Bookings', 'GET Read booking · Bookings', 'DELETE Delete booking · Bookings', 'GET Read deleted booking · Bookings', 'GET Echo · Checks', 'GET Scripted · Checks', 'GET Missing page · Checks', 'GET Unresolved · Checks', 'GET Hang · Slow', 'GET After hang · Slow'];
  check('the plan lists the requests in sidebar order', JSON.stringify(planned) === JSON.stringify(order), planned.join(' | '));
  check('the environment defaults to the active one (none)', (await dlg.getByLabel('Environment').inputValue()) === '');
  await dlg.getByLabel('Environment').selectOption('local');
  check('stop on failure is off by default', !(await dlg.getByLabel('Stop after the first failure').isChecked()));
  await shot('01-plan');

  // 2. Run the whole collection, carrying on after failures.
  await dlg.getByRole('button', { name: 'Run 12 requests' }).click();
  await finished();
  const rows = await stepTexts();
  const statusOf = (name) => rows.find((r) => r.includes(` ${name} `)) ?? '';
  const expect = { 'Login': 'Passed', 'List bookings': 'Passed', 'Create booking': 'Passed', 'Read booking': 'Passed', 'Delete booking': 'No tests', 'Read deleted booking': 'Passed', 'Echo': 'No tests', 'Scripted': 'Passed', 'Missing page': 'Failed', 'Unresolved': 'Error', 'Hang': 'Error', 'After hang': 'No tests' };
  const wrong = Object.entries(expect).filter(([n, s]) => !statusOf(n).includes(s));
  check('each request has the expected result', wrong.length === 0, wrong.map(([n]) => `${n}: ${statusOf(n)}`).join(' | '));
  check('login → create → read → delete used the extracted values', statusOf('Read booking').includes(' 200 ') && statusOf('Delete booking').includes(' 204 ') && statusOf('Read deleted booking').includes(' 404 '), [statusOf('Read booking'), statusOf('Read deleted booking')].join(' | '));
  check('test counts per request', statusOf('Login').includes('3/3') && statusOf('List bookings').includes('2/2') && statusOf('Echo').includes('—'));
  const sum = await summary();
  check('summary keeps request errors apart from failed tests', sum.includes('Finished') && sum.includes('environment local') && /Requests: 6 passed 1 failed 2 errors 3 without tests/.test(sum) && /Tests: 9 passed 0 failed/.test(sum), sum);
  check('the active environment is unchanged', (await page.locator('.app-statusbar').innerText()).includes('Environment: none'));
  await shot('02-results');

  // Details: why a request failed or errored, and its tests.
  await steps.filter({ hasText: 'Missing page' }).click();
  check('a failed request without tests says why', (await dlg.locator('.runner-details').innerText()).includes('HTTP 404, and no tests to say that was expected'));
  await steps.filter({ hasText: 'Unresolved' }).click();
  check('a request error names the cause', (await dlg.locator('.runner-details').innerText()).includes('Not sent: Unresolved variable: notDefinedAnywhere'), await dlg.locator('.runner-details').innerText());
  await steps.filter({ hasText: 'Login' }).click();
  const loginDetails = await dlg.locator('.runner-details').innerText();
  check('a request lists its tests and assertions', loginDetails.includes('status is 200') && loginDetails.includes('returns a bearer token') && loginDetails.includes('assertion'));

  // 3. Dev tools and history: one Network row per request, plus the script's own request linked to its run.
  await dlg.locator('.runner-details').getByRole('button', { name: 'Show in Dev tools' }).click();
  // Network rows start with the time sent (the selected row's details have tables of their own).
  const netRows = page.locator('.dt-network tbody tr').filter({ hasText: /^\d\d:\d\d:\d\d\.\d{3}/ });
  await netRows.first().waitFor({ timeout: 3000 });
  check('Dev tools lists every request and the script request', (await netRows.count()) === 13, (await netRows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | '));
  check('the script request is marked as one', (await page.locator('.dt-network tbody .dt-script-tag').count()) === 1);
  check('Show in Dev tools selects the run', (await page.locator('.dt-network tbody tr.active').innerText()).includes('/auth/token'));
  // (Other fixture collections have a "Login" too.)
  const counts = [await historyOf('List bookings'), await historyOf('Read deleted booking'), await historyOf('Unresolved')];
  check('each request is in its history', counts.every((n) => n === 1), counts.join(', '));
  check('a script request has no history entry of its own', (await historyOf('Scripted')) === 1);
  await page.keyboard.press('Control+Shift+J');

  // 4. Stop on failure, from a folder's context menu, with an unsaved edit that the run must not send.
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill('echo');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Echo' }).waitFor();
  await page.getByLabel('URL', { exact: true }).fill('{{baseUrl}}/status/500');
  await contextMenu('folder', 'Checks');
  await page.getByRole('button', { name: 'Run folder…' }).click();
  await dlg.waitFor();
  check('the folder dialog names it', (await dlg.locator('h3').innerText()).includes('Run folder "Checks"'));
  check('unsaved edits are pointed out', (await dlg.innerText()).includes('1 request has unsaved edits. The run sends the saved version.'));
  check('the chosen environment is kept for the next run', (await dlg.getByLabel('Environment').inputValue()) === 'local');
  await dlg.getByLabel('Stop after the first failure').check();
  await dlg.getByRole('button', { name: 'Run 4 requests' }).click();
  await finished();
  const stopped = await stepTexts();
  check('the saved request was sent, not the draft', stopped[0].includes('No tests') && stopped[0].includes(' 200 '), stopped[0]);
  check('the run stops after the first failure', stopped[2].includes('Failed') && stopped[3].includes('Not run'), stopped.join(' | '));
  check('the summary says it stopped', (await summary()).includes('Stopped after a failure') && (await summary()).includes('1 not run'), await summary());
  await shot('03-stopped');
  await dlg.getByRole('button', { name: 'Close' }).click();

  // 5. Cancel stops the request in flight and sends nothing after it.
  await contextMenu('folder', 'Slow');
  await page.getByRole('button', { name: 'Run folder…' }).click();
  await dlg.getByRole('button', { name: 'Run 2 requests' }).click();
  await steps.filter({ hasText: 'Running' }).waitFor({ timeout: 3000 });
  await page.waitForTimeout(300);
  await dlg.getByRole('button', { name: 'Cancel run' }).click();
  await finished();
  const cancelled = await stepTexts();
  check('Cancel stops the request in flight', cancelled[0].includes('Cancelled') && cancelled[1].includes('Not run'), cancelled.join(' | '));
  check('the summary says it was cancelled', (await summary()).startsWith('Cancelled'), await summary());

  // 6. Closing the dialog keeps a run going; the status bar shows it and reopens the dialog.
  await dlg.getByRole('button', { name: 'Run again' }).click();
  await dlg.getByRole('button', { name: 'Close' }).click();
  const statusItem = page.locator('.app-statusbar').getByRole('button', { name: /Running 1\/2/ });
  await statusItem.waitFor({ timeout: 3000 });
  check('the status bar shows a run going on', await statusItem.isVisible());
  await statusItem.click();
  await dlg.getByRole('button', { name: 'Cancel run' }).click();
  await finished();
  check('the dialog reopens on the same run', (await summary()).startsWith('Cancelled'));

  await page.emulateMedia({ colorScheme: 'dark' });
  await dlg.getByRole('button', { name: 'Close' }).click();
  await page.locator('.collection-overview').getByRole('button', { name: 'Run collection' }).click().catch(async () => {
    await contextMenu('collection', 'Sample Travel');
    await page.getByRole('button', { name: 'Run collection…' }).click();
  });
  await shot('04-dark');
  // 7. A CSV data file: three iterations, a delay between requests, results grouped by iteration, and reports.
  await page.emulateMedia({ colorScheme: 'light' });
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, csv);
  await dlg.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  const dataCard = page.locator('.collection-card', { hasText: 'Data Runs' });
  await dataCard.locator('summary').click();
  await dataCard.getByRole('button', { name: 'Run collection' }).click();
  await dlg.waitFor();
  await dlg.getByLabel('Environment').selectOption('local');
  await dlg.getByRole('button', { name: 'Choose CSV or JSON…' }).click();
  const dataBox = dlg.getByRole('group', { name: 'Data file' });
  await dataBox.getByText('people.csv').waitFor({ timeout: 5000 });
  check('the data file shows its rows and variables', (await dataBox.innerText()).replace(/\s+/g, ' ').includes('3 rows · 2 variables'), await dataBox.innerText());
  const iterationsBox = dlg.getByLabel('Iterations');
  check('the iterations follow the file', (await iterationsBox.inputValue()) === '3' && (await iterationsBox.isDisabled()));
  await dlg.getByLabel('Delay between requests (ms)').fill('400');
  await dlg.getByLabel('Stop after the first failure').uncheck();
  const t0 = Date.now();
  await dlg.getByRole('button', { name: 'Run 1 request × 3' }).click();
  await finished();
  const took = Date.now() - t0;
  check('the delay is kept between requests', took >= 800, `${took} ms`);
  const dataSum = await summary();
  check('the summary shows the data file, iterations and delay', dataSum.includes('data file people.csv · 3 iterations · 400 ms between requests') && /Requests: 3 passed/.test(dataSum) && /Tests: 3 passed 0 failed/.test(dataSum), dataSum);
  const iterationRows = dlg.locator('tbody tr.runner-iteration');
  const iterationTexts = (await iterationRows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  check('results are grouped by iteration, passed ones closed', iterationTexts.length === 3 && iterationTexts.every((t, i) => t.includes(`Iteration ${i + 1}`) && t.includes('1 passed')) && (await steps.count()) === 0, iterationTexts.join(' | '));
  await iterationRows.filter({ hasText: 'Iteration 2' }).click();
  check('an iteration opens to show its requests', (await steps.count()) === 1 && (await stepTexts())[0].includes('Passed'), (await stepTexts()).join(' | '));
  await steps.first().click();
  check('the row values were sent', (await dlg.locator('.runner-details').innerText()).includes('uses the row'));
  await shot('05-data-file');

  // Reports: JUnit XML with a suite per request and iteration, and a self-contained HTML page.
  const junitPath = join(tmp, 'results.xml');
  const htmlPath = join(tmp, 'report.html');
  const stubSave = (f) => app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, f);
  await stubSave(junitPath);
  await dlg.getByRole('button', { name: 'JUnit XML…' }).click();
  await page.locator('.toast', { hasText: 'Saved the JUnit report' }).waitFor({ timeout: 5000 });
  const xml = await fs.readFile(junitPath, 'utf8');
  const parsed = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return { error: doc.querySelector('parsererror').textContent };
    return { suites: [...doc.querySelectorAll('testsuite')].map((x) => x.getAttribute('name')), cases: doc.querySelectorAll('testcase').length, failures: doc.documentElement.getAttribute('failures') };
  }, xml);
  check('the JUnit report is valid XML', !parsed.error, parsed.error);
  check('the JUnit report has a suite per request and iteration', JSON.stringify(parsed.suites) === JSON.stringify(['Greet (iteration 1)', 'Greet (iteration 2)', 'Greet (iteration 3)']) && parsed.cases === 3 && parsed.failures === '0', JSON.stringify(parsed));
  check('the JUnit report has the values sent', xml.includes('name=Meera%20%22M%22&amp;city=Delhi'), xml.slice(0, 400));
  await stubSave(htmlPath);
  await dlg.getByRole('button', { name: 'HTML report…' }).click();
  await page.locator('.toast', { hasText: 'Saved the HTML report' }).waitFor({ timeout: 5000 });
  const report = await fs.readFile(htmlPath, 'utf8');
  check('the HTML report is self-contained', report.startsWith('<!doctype html>') && report.includes('Iteration 3') && !/<(script|link|img)\b/i.test(report));

  // Without the file, the environment's value is back: the row values were for their iteration only.
  await dataBox.getByRole('button', { name: 'Remove' }).click();
  await dlg.getByLabel('Delay between requests (ms)').fill('0');
  await dlg.getByRole('button', { name: 'Run again' }).click();
  await finished();
  check('row values do not stay after the run', (await stepTexts())[0]?.includes('Failed'), (await stepTexts()).join(' | '));

} catch (e) {
  check('scenario completed', false, e.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
