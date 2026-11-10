// End-to-end: Digest, AWS Signature v4 and NTLM auth. Each mode picked in the Auth tab and sent to the fixture
// server (which checks the credentials itself), the secret masked in Network and in Copy as cURL, and the saved file.
// Usage: npm run build && node e2e/auth-modes.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DIGEST_PASSWORD, DIGEST_USER, NTLM_DOMAIN, NTLM_PASSWORD, NTLM_USER, createFixtureServer
} from '../fixtures/server/server.mjs';
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
const SESSION_TOKEN = 'sample-session-token-for-fixture';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1400, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `auth-modes-${name}.png`) });
const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());
const drawer = page.locator('section.devtools');
const authTab = () => page.locator('.subtab', { hasText: 'Auth' }).first();
/** The response body as shown, once it includes `marker`. */
async function responseBody(marker) {
  await page.locator('.response .monaco-editor .view-lines', { hasText: marker }).waitFor({ timeout: 5000 }).catch(() => {});
  return (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
}

async function send(expected) {
  await page.keyboard.press('Control+Enter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
  await page.locator('.response .status', { hasText: String(expected) }).waitFor({ timeout: 10000 });
}

/** Opens the drawer on the latest send to `path`, checks masking there and in Copy as cURL, then closes it. */
async function checkMasked(label, path, secrets, expectHops) {
  const responseText = await page.locator('.response').innerText();
  check(`${label}: secrets never shown in the response pane`, secrets.every((s) => !responseText.includes(s)));
  await page.keyboard.press('Control+Shift+J');
  await drawer.waitFor({ timeout: 3000 });
  await drawer.getByRole('tab', { name: /^Network/ }).click();
  await page.locator('.dt-network tbody tr', { hasText: path }).first().click();
  if (expectHops) {
    const hops = (await page.locator('.dt-hop').allInnerTexts()).map((t) => t.trim().split(/\s+/)[0]).join(',');
    check(`${label}: the 401 challenge and the second send are both listed`, hops === '401,200', hops);
    check(`${label}: the list says it was sent again, not redirected`, (await page.locator('.dt-network tbody tr', { hasText: path }).first().innerText()).includes('sent again after 401'));
    await page.locator('.dt-hop').last().click();
  }
  const sent = await page.locator('.dt-details .headers-list').first().innerText();
  check(`${label}: Authorization masked in Network`, /Authorization\s+••••••/.test(sent), sent.split('\n').find((l) => l.startsWith('Authorization')));
  check(`${label}: no secret in Network`, secrets.every((s) => !sent.includes(s)));
  await page.getByRole('button', { name: 'Copy as cURL' }).click();
  const curl = await clipboard();
  check(`${label}: Copy as cURL masks the Authorization header`, curl.includes("-H 'Authorization: ••••••'") && secrets.every((s) => !curl.includes(s)), curl.split('\n').find((l) => l.includes('Authorization')));
  await page.keyboard.press('Control+Shift+J');
  return { sent, curl };
}

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.getByRole('button', { name: '+ New request' }).click();
  await page.getByRole('dialog').locator('input').fill('Secure resource');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Secure resource' }).waitFor();

  // 1. Digest (SHA-256, qop=auth).
  await page.getByLabel('URL', { exact: true }).fill(`${base}/auth/digest?algorithm=SHA-256`);
  await authTab().click();
  await page.getByLabel('Auth type').selectOption('digest');
  await page.getByLabel('Digest username').fill(DIGEST_USER);
  await page.getByLabel('Digest password').fill(DIGEST_PASSWORD);
  check('digest: a literal password gets the local-secret hint', await page.getByRole('button', { name: 'Store as local secret' }).isVisible());
  await shot('01-digest');
  await send(200);
  const digestBody = await responseBody('algorithm');
  check('digest: the server accepted the answer', digestBody.includes('"algorithm": "SHA-256"'));
  await checkMasked('digest', '/auth/digest', [DIGEST_PASSWORD], true);

  // 2. AWS Signature v4, with a session token.
  await page.getByLabel('URL', { exact: true }).fill(`${base}/auth/aws/items?page=2&sort=name`);
  await authTab().click();
  await page.getByLabel('Auth type').selectOption('awsv4');
  await page.getByLabel('AWS access key ID').fill(AWS_ACCESS_KEY_ID);
  await page.getByLabel('AWS secret access key').fill(AWS_SECRET_ACCESS_KEY);
  await page.getByLabel('AWS session token').fill(SESSION_TOKEN);
  await page.getByLabel('AWS service').fill('execute-api');
  await page.getByLabel('AWS region').fill('eu-west-1');
  await shot('02-aws');
  await send(200);
  const awsBody = await responseBody('service');
  check('aws: the server verified the signature', awsBody.includes('"service": "execute-api"') && awsBody.includes('"sessionToken": true'));
  const aws = await checkMasked('aws', '/auth/aws/items', [AWS_SECRET_ACCESS_KEY, SESSION_TOKEN], false);
  check('aws: session token masked in Network and cURL', /X-Amz-Security-Token\s+••••••/i.test(aws.sent) && aws.curl.includes("X-Amz-Security-Token: ••••••"));
  check('aws: X-Amz-Date is sent', /X-Amz-Date\s+\d{8}T\d{6}Z/.test(aws.sent));

  // 3. NTLM.
  await page.getByLabel('URL', { exact: true }).fill(`${base}/auth/ntlm`);
  await authTab().click();
  await page.getByLabel('Auth type').selectOption('ntlm');
  await page.getByLabel('NTLM username').fill(NTLM_USER);
  await page.getByLabel('NTLM password').fill(NTLM_PASSWORD);
  await page.getByLabel('NTLM domain').fill(NTLM_DOMAIN);
  await shot('03-ntlm');
  await send(200);
  const ntlmBody = await responseBody('NTLM');
  check('ntlm: the handshake completed', ntlmBody.includes('"authenticated": true') && ntlmBody.includes(NTLM_USER));
  await checkMasked('ntlm', '/auth/ntlm', [NTLM_PASSWORD], true);

  // 4. A wrong password ends with the server's 401.
  await authTab().click();
  await page.getByLabel('NTLM password').fill('not-the-password');
  await send(401);
  check('ntlm: a wrong password shows the 401', true);
  await page.getByLabel('NTLM password').fill('{{ntlmPassword}}');

  // 5. Saved in Bruno's shape.
  await page.keyboard.press('Control+s');
  const file = await waitForFile(join(wsDir, 'sample-travel', 'Secure resource.yml'), (text) => text.includes('type: ntlm'), 20000);
  check('saved as Bruno NTLM auth', /type: ntlm\n\s+username: sample-user\n\s+password: "\{\{ntlmPassword\}\}"\n\s+domain: SAMPLE/.test(file), file.split('\n').slice(6, 14).join(' | '));

  // 6. Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await authTab().click();
  await shot('04-dark');
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
