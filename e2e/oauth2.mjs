// End-to-end: OAuth2 client credentials. Auth tab fields, token status, Get token and Forget token, the token cached
// between sends, one automatic retry of a GET after a 401, no automatic re-send of a POST, masking and the saved file.
// Usage: npm run build && node e2e/oauth2.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer, CLIENT_ID, CLIENT_SECRET } from '../fixtures/server/server.mjs';
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
const tokenRequests = async () => (await (await fetch(`${base}/auth/stats`)).json()).tokenRequests;
const revokeAll = () => fetch(`${base}/auth/revoke`, { method: 'POST' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1400, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `oauth2-${name}.png`) });
const tokenPanel = () => page.getByLabel('OAuth2 token', { exact: true });
const statusMetric = () => page.locator('.response .statusbar').innerText();

async function send(expected) {
  const before = await page.locator('.dt-network tbody tr').count().catch(() => 0);
  await page.keyboard.press('Control+Enter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
  await page.locator('.response .status', { hasText: String(expected) }).waitFor({ timeout: 10000 });
  return before;
}

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.getByRole('button', { name: '+ New request' }).click();
  await page.getByRole('dialog').locator('input').fill('OAuth bookings');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'OAuth bookings' }).waitFor();
  await page.getByLabel('URL', { exact: true }).fill(`${base}/bookings`);

  // 1. Auth tab: OAuth2 client credentials fields.
  await page.locator('.subtab', { hasText: 'Auth' }).first().click();
  await page.getByLabel('Auth type').selectOption('oauth2');
  await page.getByLabel('Token URL').fill(`${base}/auth/token`);
  await page.getByLabel('Client ID').fill(CLIENT_ID);
  await page.getByLabel('Client secret').fill(CLIENT_SECRET);
  await page.getByLabel('Scope').fill('bookings.read');
  check('literal client secret gets the local-secret hint', await page.getByRole('button', { name: 'Store as local secret' }).isVisible());
  await tokenPanel().waitFor();
  await tokenPanel().getByText(/No token yet: one is fetched on the next send/).waitFor({ timeout: 5000 });
  check('token panel says a token will be fetched on send', true);
  await shot('01-auth-tab');

  // 2. First send fetches a token; the second reuses it.
  const before = await tokenRequests();
  await send(200);
  check('first send fetches a token', (await statusMetric()).includes('OAuth2: new token'));
  await tokenPanel().getByText(/Ready · expires in 60 min · scope bookings\.read/).waitFor({ timeout: 5000 });
  check('token panel shows expiry and granted scope', true);
  await send(200);
  check('second send reuses the cached token', (await statusMetric()).includes('OAuth2: cached token') && (await tokenRequests()) - before === 1, `token requests: ${(await tokenRequests()) - before}`);

  // 3. Neither the token nor the secret is shown anywhere (input values aren't part of the page text).
  await page.locator('.response .subtab', { hasText: 'Timeline' }).click();
  // The response pane (timeline, headers, tests): the editor itself shows what was typed into its fields.
  const text = await page.locator('.response').innerText();
  const at = text.indexOf(CLIENT_SECRET);
  check('client secret never shown in the response', at < 0, at < 0 ? '' : JSON.stringify(text.slice(Math.max(0, at - 120), at + 40)));
  check('token shown masked in the request that was sent', text.includes('Authorization') && text.includes('••••••'));

  // 4. A revoked token: a GET is retried once with a new one.
  await revokeAll();
  await send(200);
  check('GET after a 401 is re-sent with a new token', (await statusMetric()).includes('OAuth2: renewed after 401'));
  check('timeline explains the retry', (await page.locator('.response').innerText()).includes('Re-sent once with a new token'));

  // 5. A POST is not re-sent automatically; the next send works.
  await page.getByLabel('Method').selectOption('POST');
  await send(201);
  await revokeAll();
  await send(401);
  check('POST after a 401 is not re-sent, and says why', (await page.locator('.oauth2-note').innerText()).includes("POST requests aren't re-sent automatically"));
  await send(201);
  check('the next POST gets a new token', (await statusMetric()).includes('OAuth2: new token'));
  await shot('02-post-401');
  await page.getByLabel('Method').selectOption('GET');

  // 6. Forget token and Get token.
  await page.locator('.subtab', { hasText: 'Auth' }).first().click();
  await tokenPanel().getByRole('button', { name: 'Forget token', exact: true }).click();
  await tokenPanel().getByText(/No token yet/).waitFor({ timeout: 5000 });
  check('Forget token drops it', true);
  const beforeGet = await tokenRequests();
  await tokenPanel().getByRole('button', { name: 'Get token', exact: true }).click();
  await tokenPanel().getByText(/^Ready/).waitFor({ timeout: 5000 });
  check('Get token fetches one', (await tokenRequests()) - beforeGet === 1);
  await page.getByLabel('Client secret').fill('wrong-secret-value');
  await tokenPanel().getByRole('button', { name: 'Get token', exact: true }).click();
  await tokenPanel().getByRole('alert').waitFor({ timeout: 5000 });
  const err = await tokenPanel().getByRole('alert').innerText();
  check('a rejected client is explained without the secret', err.includes('invalid_client') && !err.includes('wrong-secret-value'), err);
  await page.getByLabel('Client secret').fill(CLIENT_SECRET);

  // 7. Dev tools console notes the token.
  await page.keyboard.press('Control+Shift+J');
  await page.locator('section.devtools').waitFor();
  check('console notes the OAuth2 token', (await page.locator('.dt-line', { hasText: 'OAuth2:' }).count()) >= 4);
  await shot('03-console');
  await page.keyboard.press('Control+Shift+J');

  // 8. Saved as Bruno's OAuth2 client credentials, with the literal secret flagged on save.
  await page.keyboard.press('Control+s');
  const file = await waitForFile(join(wsDir, 'sample-travel', 'OAuth bookings.yml'), (text) => text.includes('scope: bookings.read'));
  check('saved as OAuth2 client credentials', file.includes('type: oauth2') && file.includes('flow: client_credentials') && file.includes('scope: bookings.read'), file.split('\n').slice(9, 16).join(' | '));

  // 9. Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('.subtab', { hasText: 'Auth' }).first().click();
  await shot('04-dark');
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
