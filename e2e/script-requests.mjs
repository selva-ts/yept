// End-to-end: bru.sendRequest in scripts. A pre-request script logs in and the request uses the token; the script's
// requests show in Dev tools Network with links to and from the run that sent them, masked, with Copy as cURL; the
// Console and Timeline list them; history has one entry and no secret; the shared time limit and Cancel stop them.
// Usage: npm run build && node e2e/script-requests.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
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

const requestFile = (name, seq, url, script) => `info:
  name: ${name}
  type: http
  seq: ${seq}

http:
  method: GET
  url: "${url}"
  auth:
    type: bearer
    token: "{{accessToken}}"

runtime:
  scripts:
    - type: before-request
      code: |-
${script.trim().split('\n').map((l) => `        ${l.trim()}`).join('\n')}

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: false
`;
const bookingsDir = join(wsDir, 'sample-travel', 'Bookings');
await fs.writeFile(join(bookingsDir, 'Scripted login.yml'), requestFile('Scripted login', 2, '{{baseUrl}}/bookings', `
  const login = await bru.sendRequest({
    method: "POST",
    url: bru.getEnvVar("baseUrl") + "/auth/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: { grant_type: "client_credentials", client_id: bru.getEnvVar("clientId"), client_secret: bru.getEnvVar("clientSecret") }
  });
  bru.setEnvVar("accessToken", login.data.access_token);
  console.log("login", login.status, login.data.access_token);
  await bru.sendRequest({ url: bru.getEnvVar("baseUrl") + "/status/404" }, (err, res) => {
    console.log("missing", err.status);
  });
`));
await fs.writeFile(join(bookingsDir, 'Hanging script.yml'), requestFile('Hanging script', 3, '{{baseUrl}}/echo', `
  await bru.sendRequest(bru.getEnvVar("baseUrl") + "/hang");
`));

const server = createFixtureServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1440, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `script-requests-${name}.png`) });
const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());
const drawer = page.locator('section.devtools');
const devTab = (name) => drawer.getByRole('tab', { name: new RegExp(`^${name}`) });
const rows = page.locator('.dt-network tbody tr');
const details = page.locator('.dt-details');
const openByPalette = async (query, title) => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill(query);
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: title }).waitFor();
};
const send = async () => {
  await page.keyboard.press('Control+Enter');
  await page.locator('.statusbar .status').waitFor();
  await page.waitForFunction(() => !document.querySelector('.statusbar .spinner'), null, { timeout: 20000 });
};
const status = () => page.locator('.statusbar .status').innerText();

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  // Environment: local override for baseUrl, the client secret as a local secret, activate.
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Environments…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Environments' });
  await dlg.getByLabel('Local override for baseUrl').fill(base);
  await dlg.getByLabel('Local override for baseUrl').press('Enter');
  await dlg.getByLabel('Secret value for clientSecret').fill(CLIENT_SECRET);
  await dlg.getByLabel('Secret value for clientSecret').press('Enter');
  await dlg.getByRole('button', { name: 'Use this environment' }).click();
  await page.waitForTimeout(300);
  await dlg.getByRole('button', { name: 'Close' }).click();

  // 1. The pre-request script logs in with bru.sendRequest; the request uses the token.
  await openByPalette('scripted login', 'Scripted login');
  await send();
  check('request sent with the token from the scripted login', (await status()).startsWith('200'), await status());

  // 2. Console: the script's requests and output, the token masked.
  await page.keyboard.press('Control+Shift+J');
  await drawer.waitFor({ timeout: 3000 });
  await devTab('Console').click();
  await page.locator('.dt-line', { hasText: 'bru.sendRequest: POST' }).waitFor({ timeout: 5000 });
  const lines = await page.locator('.dt-line').allInnerTexts();
  check('console lists the login request', lines.some((l) => /bru\.sendRequest: POST http:\/\/127\.0\.0\.1:\d+\/auth\/token → 200/.test(l)));
  check('console lists the 404 request', lines.some((l) => /bru\.sendRequest: GET .*\/status\/404 → 404/.test(l)));
  check('script output keeps the token masked', lines.some((l) => l.includes('login 200 ••••••')), lines.find((l) => l.includes('login 200')));
  check('callback form saw err.status', lines.some((l) => l.includes('missing 404')));
  await shot('01-console');

  // 3. Network: the parent and its two script requests, marked and linked.
  await devTab('Network').click();
  check('network lists the run and both script requests', (await rows.count()) === 3, `${await rows.count()} rows`);
  check('script requests are marked', (await page.locator('.dt-network tbody .dt-script-tag').count()) === 2);
  await rows.filter({ hasText: '/auth/token' }).click();
  const childText = await details.innerText();
  check('a script request names the script that sent it', childText.replace(/\s+/g, ' ').includes('Sent by bru.sendRequest in the pre-request script of Scripted login'), childText.slice(0, 160).replace(/\s+/g, ' '));
  check('its form body masks the client secret', childText.includes('client_secret=••••••') && !childText.includes(CLIENT_SECRET));
  await shot('02-network-child');
  await details.getByRole('button', { name: 'Copy as cURL' }).click();
  const masked = await clipboard();
  check('Copy as cURL keeps the secret masked', masked.startsWith('curl ') && !masked.includes(CLIENT_SECRET));
  await details.getByRole('button', { name: '…with secrets' }).click();
  check('Copy as cURL with secrets works for a script request', (await clipboard()).includes(`client_secret=${CLIENT_SECRET}`));
  await details.getByRole('tab', { name: 'Response' }).click();
  check('the script request response is shown', (await details.innerText()).includes('access_token'));

  await details.getByRole('button', { name: 'Show the run that sent it' }).click();
  await page.locator('.dt-links', { hasText: 'Scripts sent:' }).waitFor({ timeout: 3000 });
  const parentRow = await page.locator('.dt-network tbody tr.active').innerText();
  check('the link selects the run that sent it', parentRow.includes('/bookings') && !parentRow.includes('script'), parentRow.replace(/\s+/g, ' '));
  const links = page.locator('.dt-links .dt-hop');
  check('the run lists the requests its scripts sent', (await links.allInnerTexts()).map((t) => t.trim().replace(/\s+/g, ' ')).join(' | ') === '200 POST /auth/token | 404 GET /status/404');
  await shot('03-network-parent');
  await links.nth(1).click();
  check('a listed script request can be opened', (await page.locator('.dt-network tbody tr.active').innerText()).includes('/status/404'));

  // 4. Response timeline lists the script requests.
  await page.locator('.response .subtab', { hasText: 'Timeline' }).first().click();
  const timeline = await page.locator('.response').innerText();
  check('timeline lists the script requests', /Script request[\s\S]*pre-request: POST .*\/auth\/token → 200/.test(timeline));

  // 5. History: one entry for the run, nothing secret on disk.
  const historyCount = await page.evaluate(async () => {
    const snap = await window.yept.workspace.restore();
    const find = (nodes, name) => { for (const n of nodes) { if (n.name === name && n.kind === 'request') return n; const c = n.children && find(n.children, name); if (c) return c; } };
    return (await window.yept.history.list(find(snap.collections, 'Scripted login').id)).length;
  });
  check('script requests have no history entries of their own', historyCount === 1, `${historyCount} entries`);
  const dbBytes = readdirSync(userData).filter((f) => f.startsWith('history.db')).map((f) => readFileSync(join(userData, f)).toString('latin1')).join('');
  check('history on disk has no client secret', dbBytes.length > 0 && !dbBytes.includes(CLIENT_SECRET));

  // 6. Cancel stops the script and the request it waits for.
  await openByPalette('hanging script', 'Hanging script');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.statusbar .spinner'), null, { timeout: 5000 });
  check('Cancel stops a script waiting for bru.sendRequest', (await status()).includes('Cancelled'), await status());

  // 7. A request a script waits for shares the script's 5 s limit.
  const started = Date.now();
  await send();
  const took = Date.now() - started;
  const err = await page.locator('.response').innerText();
  check('the script time limit stops a hanging script request', err.includes('timed out after 5000 ms') && err.includes('waiting for bru.sendRequest') && took < 9000, `${took} ms`);
  await devTab('Network').click();
  const latest = await rows.first().innerText();
  check('the stopped script request shows as cancelled', latest.includes('/hang') && latest.includes('Cancelled'), latest.replace(/\s+/g, ' '));

  await page.emulateMedia({ colorScheme: 'dark' });
  await rows.filter({ hasText: '/auth/token' }).click();
  await shot('04-network-dark');
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
