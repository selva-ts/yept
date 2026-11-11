// End-to-end: proxies. A request to a synthetic host goes through a local test proxy found in HTTP_PROXY (the default
// "System proxy settings"), then through a manual proxy with Basic sign-in set in Settings, and finally directly.
// Network shows which proxy each send used; the proxy password is stored encrypted, never in plain text.
// Usage: npm run build && node e2e/proxy.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from '../fixtures/server/server.mjs';
import { createTestProxy } from '../fixtures/server/proxy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e', 'out');
await fs.mkdir(out, { recursive: true });

const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-e2e-'));
const wsDir = join(tmp, 'ws');
const userData = join(tmp, 'user-data');
await fs.cp(join(root, 'fixtures', 'collections'), wsDir, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: wsDir }));

const listen = async (s) => {
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s.address().port;
};
const server = createFixtureServer();
const target = { host: '127.0.0.1', port: await listen(server) };
// Any host name the proxies are asked for reaches the fixture server, so api.example.test works only through them.
const envProxy = createTestProxy({ target });
const envPort = await listen(envProxy.server);
const PROXY_USER = 'sample-proxy-user';
const PROXY_PASSWORD = 'sample-proxy-password';
const signInProxy = createTestProxy({ target, username: PROXY_USER, password: PROXY_PASSWORD });
const signInPort = await listen(signInProxy.server);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const env = { ...process.env, YEPT_USER_DATA: userData, HTTP_PROXY: `http://127.0.0.1:${envPort}`, NO_PROXY: '' };
for (const k of ['http_proxy', 'https_proxy', 'HTTPS_PROXY', 'no_proxy']) delete env[k];
const app = await electron.launch({ args: [root], env });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1400, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `proxy-${name}.png`) });
const drawer = page.locator('section.devtools');
const settings = () => page.getByRole('dialog', { name: 'Settings' });
const openSettings = async () => {
  await page.locator('.app-statusbar').getByRole('button', { name: 'Settings', exact: true }).click();
  await settings().waitFor();
};
const saveSettings = async () => {
  await settings().getByRole('button', { name: 'Save', exact: true }).click();
  // Saved when nothing is left to save.
  await settings().locator('.dialog-actions button.primary:disabled').waitFor({ timeout: 5000 });
  await settings().getByRole('button', { name: 'Close', exact: true }).click();
};

async function send() {
  await page.keyboard.press('Control+Enter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
}

/** The Proxy row of the latest send's Connection tab. */
async function proxyShown() {
  await page.keyboard.press('Control+Shift+J');
  await drawer.waitFor({ timeout: 3000 });
  await drawer.getByRole('tab', { name: /^Network/ }).click();
  await page.locator('.dt-network tbody tr', { hasText: '/echo' }).first().click();
  await page.locator('.dt-details').getByRole('tab', { name: 'Connection' }).click();
  const conn = await page.locator('.dt-details .headers-list').innerText();
  await page.keyboard.press('Control+Shift+J');
  return conn.split('\n').find((l) => l.startsWith('Proxy')) ?? '';
}

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.getByRole('button', { name: '+ New request' }).click();
  await page.getByRole('dialog').locator('input').fill('Through a proxy');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Through a proxy' }).waitFor();
  await page.getByLabel('URL', { exact: true }).fill('http://api.example.test/echo');

  // 1. Default "System proxy settings": HTTP_PROXY is used.
  await send();
  await page.locator('.response .status', { hasText: '200' }).waitFor({ timeout: 10000 });
  check('HTTP_PROXY: sent through the environment proxy', envProxy.seen.some((s) => s.url === 'http://api.example.test/echo'));
  const fromEnv = await proxyShown();
  check('HTTP_PROXY: Network names the proxy and where it came from', fromEnv.includes(`127.0.0.1:${envPort} (environment variable)`), fromEnv);

  // 2. A manual proxy that needs a username and password.
  await openSettings();
  await settings().getByLabel('Proxy', { exact: true }).selectOption('manual');
  await settings().getByLabel('Proxy address').fill(`http://127.0.0.1:${signInPort}`);
  await settings().getByLabel('Bypass proxy for').fill('*.internal.example.test');
  await settings().getByLabel('Proxy username').fill(PROXY_USER);
  await settings().getByLabel('Proxy password').fill(PROXY_PASSWORD);
  await settings().getByRole('heading', { name: 'Proxy' }).scrollIntoViewIfNeeded();
  await shot('01-settings');
  await saveSettings();
  await send();
  await page.locator('.response .status', { hasText: '200' }).waitFor({ timeout: 10000 });
  check('manual: sent through the manual proxy with sign-in', signInProxy.seen.some((s) => s.url === 'http://api.example.test/echo' && s.auth));
  const manual = await proxyShown();
  check('manual: Network shows the manual proxy', manual.includes(`127.0.0.1:${signInPort} (manual proxy)`), manual);
  const stored = await fs.readFile(join(userData, 'settings.json'), 'utf8');
  check('the proxy password is not stored in plain text', !stored.includes(PROXY_PASSWORD) && /"proxyPassword": "[^"]+"/.test(stored));
  check('the proxy password never reaches the page', !(await page.content()).includes(PROXY_PASSWORD));
  const responseText = await page.locator('.response').innerText();
  check('the proxy sign-in is not in the response pane', !responseText.includes(Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString('base64')));

  // 3. Reopened, the password shows as saved; then no proxy at all: the synthetic host can't be found.
  await openSettings();
  check('a saved password is shown as saved, not filled in', (await settings().getByLabel('Proxy password').getAttribute('placeholder')) === 'Saved (type to replace)' && (await settings().getByLabel('Proxy password').inputValue()) === '');
  await settings().getByLabel('Proxy', { exact: true }).selectOption('off');
  await saveSettings();
  await send();
  await page.locator('.response', { hasText: 'Host not found' }).waitFor({ timeout: 10000 });
  check('off: connects directly, ignoring HTTP_PROXY', true);
  await shot('02-direct');
} catch (e) {
  check('scenario completed', false, e.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  for (const s of [server, envProxy.server, signInProxy.server]) {
    s.closeAllConnections();
    s.close();
  }
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
