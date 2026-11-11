// End-to-end: workspace, editor and sending. Drives the real Electron app with Playwright against the local fixture server.
// Usage: npm run build && node e2e/smoke.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from '../fixtures/server/server.mjs';
import { waitForFile } from './wait.mjs';

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
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
page.on('console', (m) => m.type() === 'warning' && console.log('renderer warning:', m.text()));
await page.setViewportSize({ width: 1400, height: 860 });
const shot = (name) => page.screenshot({ path: join(out, `requests-${name}.png`) });

try {
  // 1. Workspace restores and the tree shows both collections.
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  check('workspace restored with collections', (await page.getByText('DummyJSON').count()) > 0);
  await shot('01-tree');
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();

  // 2. Open a saved request: {{baseUrl}} is unresolved without an environment, and Send is blocked.
  await page.locator('.tree-row', { hasText: 'List bookings' }).click();
  await page.locator('.doc-title', { hasText: 'List bookings' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.resolved')?.textContent?.includes('missing'), null, { timeout: 4000 });
  check('unresolved variable warning shown', (await page.locator('.resolved').first().innerText()).includes('missing {{baseUrl}}'));
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('.status', { hasText: 'Not sent' }).waitFor({ timeout: 5000 });
  check('send blocked with prepare error', await page.locator('.error-card').getByText('Unresolved variables: baseUrl, accessToken').isVisible());
  await shot('02-unresolved');

  // 3. Create a request through the context menu and the prompt dialog.
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'New request' }).click();
  await page.getByRole('dialog').locator('input').fill('Echo test');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Echo test' }).waitFor();
  check('new request file created', existsSync(join(wsDir, 'sample-travel', 'Echo test.yml')));

  // 4. Edit method, URL (query params sync), header and JSON body; send.
  await page.getByLabel('Method').selectOption('POST');
  await page.getByLabel('URL', { exact: true }).fill(`${base}/echo?page=2&q=hello world`);
  check('query params synced from URL', (await page.locator('.subtab', { hasText: 'Params' }).innerText()).includes('2'));
  await page.locator('.subtab', { hasText: 'Headers' }).click();
  await page.getByPlaceholder('Add header').fill('X-Trace');
  await page.keyboard.type('-Id');
  const headerName = await page.locator('.kv tbody tr').first().locator('input[type="text"]').first().inputValue();
  check('typing continues in a newly added row', headerName === 'X-Trace-Id', headerName);
  await page.locator('.subtab', { hasText: 'Body' }).click();
  await page.getByLabel('JSON').check();
  await page.locator('.monaco-host .monaco-editor').first().click();
  await page.keyboard.type('{"name": "Yept"');
  await page.keyboard.press('Control+Enter');
  await page.locator('.status', { hasText: '200' }).waitFor({ timeout: 10000 });
  await page.locator('.response .monaco-editor .view-lines', { hasText: 'method' }).waitFor({ timeout: 5000 });
  // Monaco renders spaces as non-breaking spaces.
  const bodyText = (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
  check('POST echoed with JSON body', bodyText.includes('"method": "POST"') && bodyText.includes('Yept'));
  check('URL encoded once', bodyText.includes('"q": "hello world"'));
  await shot('03-response');

  // 5. Unsaved marker, then Ctrl+S writes the file.
  check('unsaved dot shown', (await page.locator('.tab.active .dirty-dot').count()) === 1);
  await page.locator('.doc-title').click();
  await page.keyboard.press('Control+s');
  const saved = await waitForFile(join(wsDir, 'sample-travel', 'Echo test.yml'), (text) => text.includes('X-Trace-Id') && text.includes('"name": "Yept"'));
  check('saved to disk', saved.includes('method: POST') && saved.includes('X-Trace-Id') && saved.includes('"name": "Yept"'));
  await page.locator('.tab.active .dirty-dot').waitFor({ state: 'detached' });
  check('unsaved dot cleared', (await page.locator('.tab.active .dirty-dot').count()) === 0);

  // 6. Outcome types: HTTP error, timeout, cancel, connection refused.
  const sendTo = async (url) => {
    await page.getByLabel('URL', { exact: true }).fill(url);
    await page.keyboard.press('Control+Enter');
  };
  await page.getByLabel('Method').selectOption('GET');
  await sendTo(`${base}/status/503`);
  await page.locator('.status', { hasText: '503' }).waitFor();
  check('HTTP 503 shown as a status', true);
  await sendTo('http://127.0.0.1:1/nothing');
  await page.locator('.status', { hasText: 'Connection failed' }).waitFor();
  check('connection refused shown without a status code', await page.getByText('No HTTP response was received').isVisible());
  await shot('04-network-error');
  await sendTo(`${base}/hang`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.status', { hasText: 'Cancelled' }).waitFor();
  check('cancel works', true);
  await page.locator('.subtab', { hasText: 'Settings' }).click();
  await page.locator('input[type="number"]').first().fill('400');
  await sendTo(`${base}/hang`);
  await page.locator('.status', { hasText: 'Timed out' }).waitFor({ timeout: 5000 });
  check('timeout works', true);

  // 7. External change to a clean tab reloads it; to a dirty tab raises a conflict.
  await page.keyboard.press('Control+s');
  const file = join(wsDir, 'sample-travel', 'Echo test.yml');
  await page.locator('.tab.active .dirty-dot').waitFor({ state: 'detached' });
  await fs.writeFile(file, readFileSync(file, 'utf8').replace(/url: .*/, `url: "${base}/echo?external=1"`));
  await page.waitForFunction(() => document.querySelector('input[aria-label="URL"]')?.value.includes('external=1'));
  check('external edit reloads a clean tab', true);
  await page.getByLabel('URL', { exact: true }).fill(`${base}/echo?mine=1`);
  await page.locator('.tab.active .dirty-dot').waitFor();
  await fs.writeFile(file, readFileSync(file, 'utf8').replace(/url: .*/, `url: "${base}/echo?theirs=1"`));
  await page.getByText('This file changed on disk').waitFor();
  check('external edit to a dirty tab shows a conflict', true);
  await shot('05-conflict');
  await page.getByRole('button', { name: 'Keep my edits' }).click();
  await page.keyboard.press('Control+s');
  check('keep my edits then save overwrites', (await waitForFile(file, (text) => text.includes('mine=1'))).includes('mine=1'));

  // 8. Rename keeps the tab; command palette finds requests.
  await page.locator('.tree-row', { hasText: 'Echo test' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Rename…' }).click();
  await page.getByRole('dialog').locator('input').fill('Echo renamed');
  await page.keyboard.press('Enter');
  await page.locator('.tree-row', { hasText: 'Echo renamed' }).waitFor();
  check('rename moves the file', existsSync(join(wsDir, 'sample-travel', 'Echo renamed.yml')) && !existsSync(file));
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill('login dummy');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Login' }).waitFor();
  check('command palette opens a request', (await page.locator('.doc-path').innerText()).startsWith('dummyjson/'));

  // 9. Paste cURL from the app menu: preview, what isn't imported, then a request that sends as curl would.
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: 'Paste cURL…' }).click();
  const curlDialog = page.getByRole('dialog', { name: 'Paste cURL' });
  await curlDialog.getByLabel('cURL command').fill([
    `curl -X POST '${base}/echo?source=paste' \\`,
    `  -H 'X-Pasted: yes' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --data-raw '{"city":"Oslo"}' \\`,
    '  -k'
  ].join('\n'));
  check('paste cURL previews the request', (await curlDialog.locator('.curl-summary').innerText()).includes(`${base}/echo?source=paste`));
  check('paste cURL lists what is not imported', (await curlDialog.locator('.curl-notes').innerText()).includes('-k is not imported'));
  check('paste cURL suggests a name', (await curlDialog.getByLabel('Request name').inputValue()) === 'POST echo');
  await curlDialog.getByLabel('Save in').selectOption({ label: 'Sample Travel' });
  await shot('06-paste-curl');
  await curlDialog.getByRole('button', { name: 'Create request' }).click();
  await page.locator('.doc-title', { hasText: 'POST echo' }).waitFor();
  const pastedFile = join(wsDir, 'sample-travel', 'POST echo.yml');
  check('pasted request saved', existsSync(pastedFile) && readFileSync(pastedFile, 'utf8').includes('X-Pasted'));
  await page.keyboard.press('Control+Enter');
  await page.locator('.status', { hasText: '200' }).waitFor({ timeout: 10000 });
  await page.locator('.response .monaco-editor .view-lines', { hasText: 'x-pasted' }).waitFor({ timeout: 5000 });
  const pastedBody = (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
  check('pasted request sends method, header and body', pastedBody.includes('"method": "POST"') && pastedBody.includes('"x-pasted": "yes"') && pastedBody.includes('Oslo'));

  // 10. Paste cURL from the command palette: a multi-line command pasted there opens the dialog with all of it.
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill('curl https://api.example.test/typed');
  check('command palette offers a typed curl command', await page.locator('.palette-item', { hasText: 'Create request from this cURL command' }).isVisible());
  await page.getByPlaceholder(/Go to request/).fill('');
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `curl '${base}/echo?via=palette' \\\n  -H 'Accept: application/json'`);
  await page.keyboard.press('Control+v');
  await curlDialog.waitFor();
  check('command palette paste keeps the whole command', (await curlDialog.getByLabel('cURL command').inputValue()).includes("\n  -H 'Accept: application/json'"));
  await curlDialog.getByLabel('Save in').selectOption({ label: 'Sample Travel' });
  await curlDialog.getByRole('button', { name: 'Create request' }).click();
  await page.locator('.doc-title', { hasText: 'GET echo' }).waitFor();
  check('command palette creates the request', existsSync(join(wsDir, 'sample-travel', 'GET echo.yml')));

  // 11. Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot('06-dark');
} catch (e) {
  check('scenario completed', false, e.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
} finally {
  // Exit directly: a normal close would (correctly) stop at the unsaved-changes prompt.
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
