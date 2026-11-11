// End-to-end: environments, local secrets, login -> token extraction -> protected call, env switching,
// failed login, "store as local secret", and the sample ASP.NET API over https://localhost (if dotnet is installed).
// Usage: npm run build && node e2e/environments.mjs   (screenshots go to e2e/out/)
import { _electron as electron } from 'playwright';
import { promises as fs, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer, CLIENT_SECRET } from '../fixtures/server/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Build before allocating test resources. Missing dotnet is optional; a failed build must be visible.
const sampleApi = join(root, 'samples', 'SampleApi');
const build = spawnSync('dotnet', ['build', '--nologo', '--verbosity', 'quiet'], { cwd: sampleApi, stdio: 'inherit' });
const hasDotnet = build.error?.code !== 'ENOENT';
if (hasDotnet) {
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('The ASP.NET sample failed to build. Install the .NET 10 SDK and check the build output above.');
} else {
  console.log('SKIP ASP.NET checks: dotnet is not on PATH');
}

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
const resolvedText = async (needle) => {
  try {
    await page.waitForFunction((n) => document.querySelector('.resolved')?.textContent?.includes(n), needle, { timeout: 4000 });
    return true;
  } catch {
    console.log('resolved line was:', await page.locator('.resolved').first().innerText());
    return false;
  }
};
await page.setViewportSize({ width: 1440, height: 880 });
const shot = (name) => page.screenshot({ path: join(out, `environments-${name}.png`) });
const openByPalette = async (query, title) => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill(query);
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: title }).waitFor();
};
const send = async () => {
  await page.keyboard.press('Control+Enter');
  await page.locator('.statusbar .status').waitFor();
  await page.waitForFunction(() => !document.querySelector('.statusbar .spinner'), null, { timeout: 15000 });
};
const status = () => page.locator('.statusbar .status').innerText();
const envSelect = () => page.getByLabel('Environment', { exact: true });
const openEnvEditor = async (collection) => {
  await page.locator('.tree-row.collection', { hasText: collection }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Environments…' }).click();
  await page.getByRole('dialog', { name: 'Environments' }).waitFor();
};
const closeEnvEditor = () => page.getByRole('dialog', { name: 'Environments' }).getByRole('button', { name: 'Close' }).click();

let dotnet = null;
try {
  if (hasDotnet) {
    dotnet = spawn('dotnet', ['run', '--no-build', '--urls', 'https://localhost:7443'], { cwd: sampleApi, stdio: 'ignore' });
    dotnet.on('error', (error) => check('ASP.NET sample starts', false, error.message));
  }
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();

  // 1. Environment editor: local override for baseUrl, local secret for clientSecret, activate.
  await openEnvEditor('Sample Travel');
  const dlg = page.getByRole('dialog', { name: 'Environments' });
  await dlg.getByLabel('Local override for baseUrl').fill(base);
  await dlg.getByLabel('Local override for baseUrl').press('Enter');
  await dlg.getByLabel('Secret value for clientSecret').fill(CLIENT_SECRET);
  await dlg.getByLabel('Secret value for clientSecret').press('Enter');
  await dlg.getByRole('button', { name: 'Use this environment' }).click();
  await dlg.locator('.env-item.active .badge', { hasText: 'active' }).waitFor();
  await page.waitForTimeout(300);
  check('secret shows as stored, value hidden', (await dlg.getByLabel('Secret value for clientSecret').getAttribute('placeholder'))?.includes('stored'));
  await shot('01-env-editor');
  await closeEnvEditor();

  // 2. Login: Basic auth from env + secret, form body, extraction into the accessToken secret.
  await openByPalette('travel login', 'Login');
  check('environment selected next to Send', (await envSelect().inputValue()) === 'local');
  check('resolved URL shows the override', await resolvedText(`${base}/auth/token`));
  await send();
  check('login returns 200', (await status()).startsWith('200'));
  check('token stored as a secret (badge)', await page.getByText('accessToken stored as secret').isVisible());
  await page.locator('.response .subtab', { hasText: 'Scripts' }).click();
  check('scripts tab explains the extraction', await page.getByText('stored as a local secret for this environment').isVisible());
  await shot('02-login-extracted');

  // 3. Protected request uses the token.
  await openByPalette('list bookings', 'List bookings');
  await send();
  check('protected request succeeds with the extracted token', (await status()).startsWith('200'));

  // 4. Shared file has no secrets; local store has no plaintext.
  const envFile = readFileSync(join(wsDir, 'sample-travel', 'environments', 'local.yml'), 'utf8');
  check('environment file contains no secret values', !envFile.includes(CLIENT_SECRET) && !envFile.includes(base));
  const localFile = readFileSync(join(userData, 'local-environments.json'), 'utf8');
  check('local store has no plaintext secret', !localFile.includes(CLIENT_SECRET));

  // 5. No environment: the token does not leak; send is blocked.
  await envSelect().selectOption('');
  await page.waitForTimeout(300);
  await send();
  check('without an environment the request is not sent', (await status()) === 'Not sent');
  check('missing variables are named', await page.locator('.error-card').getByText(/Unresolved variables: baseUrl, accessToken/).isVisible());
  await shot('03-no-env');
  await envSelect().selectOption('local');

  // 6. Failed login clears the old token.
  await openEnvEditor('Sample Travel');
  await dlg.getByLabel('Secret value for clientSecret').fill('wrong-secret');
  await dlg.getByLabel('Secret value for clientSecret').press('Enter');
  await page.waitForTimeout(200);
  await closeEnvEditor();
  await openByPalette('travel login', 'Login');
  await send();
  check('wrong secret gives 401', (await status()).startsWith('401'));
  check('extraction failure is reported', await page.getByText('extraction failed').isVisible());
  await openByPalette('list bookings', 'List bookings');
  await send();
  check('old token was cleared, not reused', (await status()) === 'Not sent' && (await page.locator('.error-card').innerText()).includes('accessToken'));

  // 7. "Store as local secret" for a literal token.
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'New request' }).click();
  await page.getByRole('dialog').locator('input').fill('Token test');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Token test' }).waitFor();
  await page.locator('.subtab', { hasText: 'Auth' }).first().click();
  await page.getByLabel('Auth type').selectOption('bearer');
  // Assembled at runtime so secret scanners don't flag this synthetic value.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2lnbmF0dXJlLXZhbHVlLXRlc3Q'].join('.');
  await page.getByLabel('Bearer token').fill(jwt);
  await page.getByText('This looks like a real credential').waitFor();
  await shot('04-secret-hint');
  await page.getByRole('button', { name: 'Store as local secret' }).click();
  await page.getByRole('dialog').locator('input').fill('demoToken');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Bearer token"]')?.value === '{{demoToken}}', null, { timeout: 5000 });
  check('literal token replaced by a variable', true);
  const envAfter = readFileSync(join(wsDir, 'sample-travel', 'environments', 'local.yml'), 'utf8');
  check('variable declared secret in the shared file, without its value', envAfter.includes('name: demoToken') && !envAfter.includes('eyJhbGci'));

  // 8. Sample ASP.NET API over https://localhost with the dev certificate.
  if (hasDotnet) {
    for (let i = 0; i < 60; i++) {
      try {
        await fetch('https://localhost:7443/weatherforecast');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await page.getByRole('button', { name: 'Open Sample ASP.NET API' }).click();
    await openEnvEditor('Sample ASP.NET API');
    await dlg.getByLabel('Secret value for password').fill('demo-password');
    await dlg.getByLabel('Secret value for password').press('Enter');
    await dlg.getByRole('button', { name: 'Use this environment' }).click();
    await page.waitForTimeout(300);
    await closeEnvEditor();
    await page.locator('.tree-row', { hasText: 'Me' }).filter({ hasNotText: 'DummyJSON' }).last().waitFor();
    await openByPalette('asp login', 'Login');
    await send();
    check('ASP.NET login over https://localhost (dev cert)', (await status()).startsWith('200'), await status());
    await openByPalette('aspnet me', 'Me');
    check('preview resolves the ASP.NET base URL', await resolvedText('https://localhost:7443/api/me'));
    await send();
    await page.locator('.response .monaco-editor .view-lines', { hasText: 'username' }).waitFor({ timeout: 5000 });
    const body = (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
    check('ASP.NET protected endpoint with inherited collection bearer auth', (await status()).startsWith('200') && body.includes('"username": "demo"'), body.slice(0, 80));
    await shot('05-aspnet');
  }

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await openEnvEditor('Sample Travel');
  await shot('06-env-editor-dark');
  await closeEnvEditor();
} catch (e) {
  check('scenario completed', false, e.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  dotnet?.kill();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
