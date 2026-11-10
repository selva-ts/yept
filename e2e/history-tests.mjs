// End-to-end: tests and assertions, response history (survives restart, follows renames, redacted on disk),
// viewing old runs, restore, orphaned history, and the history limits in Settings.
// Usage: npm run build && node e2e/m3.mjs   (screenshots go to e2e/out/)
import { _electron as electron } from 'playwright';
import { promises as fs, readFileSync, readdirSync, existsSync } from 'node:fs';
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

const server = createFixtureServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

let app;
let page;
const launch = async () => {
  app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData }, timeout: 60000 });
  page = await app.firstWindow();
  page.on('pageerror', (e) => check('no renderer errors', false, e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
};
const quit = async () => {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
const shot = (name) => page.screenshot({ path: join(out, `history-${name}.png`) });
const openByPalette = async (query, title) => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill(query);
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: title }).waitFor();
};
const historyButton = (count) => page.getByRole('button', { name: `History · ${count}`, exact: true });
const send = async (count) => {
  await page.keyboard.press('Control+Enter');
  // An old response can stay visible while the next request runs.
  await historyButton(count).waitFor();
  await page.locator('.statusbar .status').waitFor();
};
const status = () => page.locator('.statusbar .status').innerText();
const sub = (name) => page.locator('.editor-section .subtab', { hasText: name }).first();
const respTab = (name) => page.locator('.response .subtab', { hasText: name }).first();
const setTests = async (code) => {
  await sub('Tests').click();
  const editor = page.locator('.tests-editor .monaco-editor').first();
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(code); // insertText avoids Monaco's auto-closing of brackets and quotes
};

try {
  await launch();
  // Environment (as in environments.mjs): override baseUrl, set the secret, activate.
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Environments…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Environments' });
  await dlg.getByLabel('Local override for baseUrl').fill(base);
  await dlg.getByLabel('Local override for baseUrl').press('Enter');
  await dlg.getByLabel('Secret value for clientSecret').fill(CLIENT_SECRET);
  await dlg.getByLabel('Secret value for clientSecret').press('Enter');
  await dlg.getByRole('button', { name: 'Use this environment' }).click();
  await dlg.getByRole('button', { name: 'Use this environment' }).waitFor({ state: 'detached' });
  await dlg.getByRole('button', { name: 'Close' }).click();

  // 1. Login has 2 tests + 1 assertion in the fixture file.
  await openByPalette('travel login', 'Login');
  await send(1);
  check('login 200', (await status()).startsWith('200'));
  check('tests badge shows 3/3 passed', await page.getByText('Tests 3/3 passed').isVisible());
  // The code editor fills in just after the status bar settles.
  await page.waitForFunction(() => !!document.querySelector('.response .monaco-editor .view-lines')?.textContent?.includes('access_token'), null, { timeout: 10000 });
  const liveBody = (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
  const token = /"access_token": "([0-9a-f-]{36})"/.exec(liveBody)?.[1];
  check('live response shows the real token (to the user)', !!token);
  await respTab('Tests').click();
  check('tests tab lists passed tests and the assertion', (await page.locator('.tests-table tr').count()) === 3 && (await page.locator('.tstatus.passed').count()) === 3);
  await shot('01-tests-passed');

  // 2. List bookings: a failing assertion, a Jest-style matcher (error) and a passing test.
  await openByPalette('list bookings', 'List bookings');
  await sub('Tests').click();
  await page.getByPlaceholder('Add expression, e.g. res.status').fill('res.status');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('eq 201');
  await setTests('test("has items", () => expect(res.body.items).to.have.length(2));\ntest("jest style", () => expect(res.status).toBe(200));');
  await send(1);
  await respTab('Tests').click();
  const rows = await page.locator('.tests-table tr').allInnerTexts();
  check('failed assertion shown as failed', rows.some((r) => r.includes('failed') && r.includes('res.status eq 201')), rows.join(' | '));
  check('Jest matcher shown as error, not failed', rows.some((r) => r.includes('error') && r.includes('jest style')));
  check('passing test shown as passed', rows.some((r) => r.includes('passed') && r.includes('has items')));
  check('badge reports the error', (await page.locator('.statusbar').innerText()).includes('1 error'));
  await shot('02-tests-mixed');

  // 3. Runaway test script is stopped (5 s limit) and shown as an error.
  await setTests('test("spin", () => { while (true) {} });');
  await send(2);
  await respTab('Tests').click();
  check('runaway test stopped and shown as error', (await page.locator('.tests-table').innerText()).includes('timed out after 5000 ms'));

  // 4. History panel: 2 runs of List bookings; open the older one: original results, nothing re-sent.
  await page.getByRole('button', { name: /^History/ }).click();
  await page.locator('.history-item').first().waitFor();
  check('history lists every run', (await page.locator('.history-item').count()) === 2, `${await page.locator('.history-item').count()} items`);
  await shot('03-history-panel');
  await page.locator('.history-item').nth(1).click();
  await page.getByText('Nothing was re-sent').waitFor();
  await respTab('Tests').click();
  check('old run shows its original test results', (await page.locator('.tests-table').innerText()).includes('jest style'));
  await shot('04-viewing-old-run');
  await page.getByRole('button', { name: 'Restore request' }).click();
  await sub('Tests').click();
  const restored = await page.locator('.tests-editor .monaco-editor .view-lines').innerText();
  check('restore request copies that run\'s tests into the editor', restored.replaceAll(String.fromCharCode(160), ' ').includes('jest style'));

  // 5. History on disk contains no secrets (client secret, extracted token).
  const dbBytes = readdirSync(userData).filter((f) => f.startsWith('history.db')).map((f) => readFileSync(join(userData, f)).toString('latin1')).join('');
  check('history.db contains no client secret', dbBytes.length > 0 && !dbBytes.includes(CLIENT_SECRET));
  check('history.db contains no extracted token', !!token && !dbBytes.includes(token));

  // 6. Rename in the app: history follows. (Save first: Yept refuses to rename a request with unsaved edits.)
  await page.locator('.urlbar').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.doc-title .dirty-dot').waitFor({ state: 'detached', timeout: 5000 });
  await page.locator('.tree-row', { hasText: 'List bookings' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Rename…' }).click();
  await page.getByRole('dialog').locator('input').fill('All bookings');
  await page.keyboard.press('Enter');
  await page.locator('.tree-row', { hasText: 'All bookings' }).waitFor();
  await page.keyboard.press('Control+w');

  // 7. Restart: history survives and keeps its test results.
  await quit();
  await launch();
  await openByPalette('all bookings', 'All bookings');
  await historyButton(2).waitFor();
  check('history survives a restart and follows the rename', (await page.getByRole('button', { name: /^History/ }).innerText()).includes('2'));
  await page.getByRole('button', { name: /^History/ }).click();
  await page.locator('.history-item').first().click();
  await respTab('Tests').click();
  check('restored history keeps the test results', (await page.locator('.tests-table').innerText()).includes('timed out'));
  // One more run so the 'keep 2' limit below has something to trim.
  await send(3);

  // 8. Orphaned history: change and rename the Login file outside Yept so it can't be matched.
  const loginFile = join(wsDir, 'sample-travel', 'Auth', 'Login.yml');
  await fs.writeFile(join(wsDir, 'sample-travel', 'Auth', 'Sign in.yml'), readFileSync(loginFile, 'utf8').replace('/auth/token', '/auth/token?v=2').replace('name: Login', 'name: Sign in'));
  await fs.rm(loginFile);
  await page.locator('.tree-row', { hasText: 'Sign in' }).waitFor();
  await openByPalette('sign in', 'Sign in');
  await page.locator('.app-statusbar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'History of deleted or moved requests…' }).click();
  await page.getByRole('dialog', { name: 'Orphaned history' }).getByText('Login').first().waitFor({ timeout: 5000 });
  check('orphaned history listed for the unmatched request', true);
  await shot('05-orphans');
  await page.getByRole('button', { name: 'Attach to "Sign in"' }).click();
  await page.getByText('Nothing here: all history belongs to existing requests.').waitFor({ timeout: 5000 });
  await page.getByRole('dialog', { name: 'Orphaned history' }).getByRole('button', { name: 'Close' }).click();
  check('reattached history shows on the new request', (await page.getByRole('button', { name: /^History/ }).innerText()).includes('1'));

  // 9. Settings: keep 2 runs per request; the 3-run history of All bookings is trimmed.
  await page.locator('.app-statusbar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Runs kept per request').fill('2');
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Save' }).click();
  await page.getByText('Settings saved', { exact: true }).waitFor();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click();
  await openByPalette('all bookings', 'All bookings');
  const counts = await page.evaluate(async () => {
    const snap = await window.yept.workspace.restore();
    const find = (nodes, name) => { for (const n of nodes) { if (n.name === name && n.kind === 'request') return n; const c = n.children && find(n.children, name); if (c) return c; } };
    return (await window.yept.history.list(find(snap.collections, 'All bookings').id)).length;
  });
  check('runs-per-request limit trims history', counts === 2, `${counts} runs`);

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: /^History/ }).click().catch(() => {});
  await shot('06-dark');
} catch (e) {
  check('scenario completed', false, e.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
} finally {
  await quit();
  server.closeAllConnections();
  server.close();
  // A file still held open by the closing app must not fail a run whose checks passed.
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((e) => console.log(`warning: temp folder not removed: ${e.message}`));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
