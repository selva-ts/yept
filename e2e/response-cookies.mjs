// Read-only response cookies: recorded hops, explicit value reveal, jar link and redacted history after restart.
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-response-cookies-'));
const workspace = join(tmp, 'ws'); const profile = join(tmp, 'profile'); const out = join(root, 'e2e/out');
await fs.cp(join(root, 'fixtures/collections/sample-travel'), workspace, { recursive: true });
await fs.mkdir(profile); await fs.mkdir(out, { recursive: true });
await fs.writeFile(join(profile, 'preferences.json'), JSON.stringify({ lastWorkspace: workspace }));
const manualPath = join(workspace, 'Manual.yml');
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture.local').pathname;
  const send = (status, headers) => setTimeout(() => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end('{"ok":true}'); }, 120);
  if (path === '/set') return send(200, { 'Set-Cookie': ['sid=from-response==; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600', 'empty=; Path=/', 'locked=secure-value; Path=/private; Secure; SameSite=None'] });
  if (path === '/redirect') return send(302, { Location: '/final', 'Set-Cookie': 'sid=redirect-value; Path=/; HttpOnly' });
  if (path === '/final') return send(200, { 'Set-Cookie': 'done=last-hop; Path=/' });
  return send(200, {});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(manualPath, `info:\n  name: Manual\n  type: http\n  seq: 99\nhttp:\n  method: GET\n  url: ${base}/none\n  headers:\n    - name: Cookie\n      value: own=from-own-header==\n`);
let app, page;
const results = [];
const check = (name, ok) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
const launch = async () => {
  app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: profile } }); page = await app.firstWindow();
  page.on('pageerror', (e) => { console.error(e); check('no renderer errors', false); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
};
const close = async () => { await app.evaluate(({ app }) => app.exit(0)); await app.close().catch(() => {}); };
const panel = () => page.getByLabel('Response cookies', { exact: true });
const cookiesTab = () => page.locator('.response').getByRole('tab', { name: /^Cookies/ });
const send = async (path) => {
  await page.getByLabel('URL', { exact: true }).fill(`${base}${path}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('.response .status', { hasText: '200' }).waitFor();
};
const open = async (query) => { await page.keyboard.press('Control+k'); await page.getByPlaceholder(/Go to request/).fill(query); await page.keyboard.press('Enter'); await page.locator('.doc-title', { hasText: query }).waitFor(); };
try {
  await launch();
  await page.getByRole('button', { name: '+ New request' }).click(); await page.getByRole('dialog').getByRole('textbox').fill('Cookies response'); await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Cookies response' }).waitFor();
  await send('/none'); await cookiesTab().click();
  check('response Cookies sits beside Headers', (await page.locator('.response [role=tab]').allInnerTexts()).slice(0, 3).map((s) => s.replace(/\d/g, '').trim()).join(',') === 'Body,Headers,Cookies');
  check('empty response distinguishes no cookies from unavailable details', (await panel().innerText()).includes('No cookies sent') && !(await panel().innerText()).includes('older run'));

  await send('/set');
  await panel().getByRole('table', { name: 'Cookies received on hop 1', exact: true }).waitFor();
  check('received cookies and attributes are visible with values hidden', (await panel().innerText()).includes('HttpOnly') && (await panel().innerText()).includes('Secure') && (await panel().innerText()).includes('SameSite=lax') && !(await panel().innerText()).includes('from-response=='));
  check('response cookie tables are read-only', await panel().getByRole('button', { name: /^(Add|Edit|Delete|Clear)/ }).count() === 0);
  await panel().getByRole('button', { name: 'Reveal received cookie sid on hop 1', exact: true }).click();
  await panel().getByRole('button', { name: 'Hide received cookie sid on hop 1', exact: true }).waitFor();
  check('received value is revealed only after clicking', (await panel().innerText()).includes('from-response=='));
  await panel().getByRole('button', { name: 'Hide received cookie sid on hop 1', exact: true }).click();
  check('value can be hidden again', !(await panel().innerText()).includes('from-response=='));
  await panel().getByRole('button', { name: 'Reveal received cookie empty on hop 1', exact: true }).click();
  await panel().getByRole('button', { name: 'Hide received cookie empty on hop 1', exact: true }).waitFor();
  check('empty values can be revealed', (await panel().innerText()).includes('(empty)'));

  await send('/redirect');
  await panel().getByLabel('Cookie hop 2', { exact: true }).waitFor();
  check('redirect hops show both sent and received cookie entries', await panel().getByRole('table', { name: 'Cookies sent on hop 1', exact: true }).count() === 1 && await panel().getByRole('table', { name: 'Cookies received on hop 2', exact: true }).count() === 1);
  check('new run resets reveals and identifies jar provenance', (await panel().innerText()).includes('Cookie jar') && !(await panel().innerText()).includes('from-response==') && !(await panel().innerText()).includes('redirect-value'));
  await panel().getByRole('button', { name: 'Reveal sent cookie sid on hop 1', exact: true }).click();
  await panel().getByRole('button', { name: 'Hide sent cookie sid on hop 1', exact: true }).waitFor();
  check('first-hop reveal uses the recorded value, not the updated jar', (await panel().innerText()).includes('from-response=='));
  await panel().getByRole('button', { name: 'Reveal sent cookie sid on hop 2', exact: true }).click();
  await panel().getByRole('button', { name: 'Hide sent cookie sid on hop 2', exact: true }).waitFor();
  check('second-hop reveal shows the cookie set by the redirect', (await panel().innerText()).includes('redirect-value'));
  await panel().getByRole('button', { name: 'Hide sent cookie sid on hop 1', exact: true }).click();
  await panel().getByRole('button', { name: 'Hide sent cookie sid on hop 2', exact: true }).click();
  await page.screenshot({ path: join(out, 'response-cookies-redirect.png') });
  await page.getByLabel('Environment', { exact: true }).selectOption('local');
  await panel().getByRole('button', { name: 'Open current cookie jar in Dev Tools', exact: true }).click();
  await page.locator('.devtools').getByRole('tab', { name: /^Cookies/ }).waitFor();
  await page.locator('.devtools .dt-toolbar').getByText('local', { exact: true }).waitFor();
  check('jar link opens Dev Tools in the current environment', (await page.locator('.devtools .dt-toolbar').innerText()).includes('local') && (await panel().innerText()).includes('no environment'));
  await page.locator('.devtools').getByRole('button', { name: 'Close dev tools' }).click();

  await open('Manual'); await send('/none'); await cookiesTab().click();
  check('own Cookie header is identified instead of the jar', (await panel().innerText()).includes('Request Cookie header') && !(await panel().innerText()).includes('Cookie jar'));
  await panel().getByRole('button', { name: 'Reveal sent cookie own on hop 1', exact: true }).click();
  await panel().getByRole('button', { name: 'Hide sent cookie own on hop 1', exact: true }).waitFor();
  check('own header values preserve equals characters', (await panel().innerText()).includes('from-own-header=='));
  await open('Cookies response');
  await page.keyboard.press('Control+s');
  // An older run from this session: its values are still in memory, but history must not reveal them.
  // (The newest entry is the run already on screen, which opens the live result rather than the stored copy.)
  await page.getByRole('button', { name: /^History/ }).click(); await page.locator('.history-item').nth(1).click(); await cookiesTab().click();
  check('history shows metadata and disables reveal even in the same session', (await panel().innerText()).includes('metadata only') && await panel().getByRole('button', { name: /^Reveal/ }).first().isDisabled());
  await close();
  const db = (await fs.readFile(join(profile, 'history.db'))).toString('latin1');
  check('history database contains no recorded or literal Cookie values', !['from-response==', 'redirect-value', 'last-hop', 'from-own-header==', 'secure-value'].some((value) => db.includes(value)));
  await launch(); await open('Cookies response');
  await page.getByRole('button', { name: /^History/ }).click(); await page.locator('.history-item').first().click(); await cookiesTab().click();
  check('cookie metadata survives restart without recovering values', (await panel().innerText()).includes('sid') && await panel().getByRole('button', { name: /^Reveal/ }).first().isDisabled());
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(out, 'response-cookies-history-dark.png') });
} catch (e) { console.error(e); check('scenario completed', false); await page?.screenshot({ path: join(out, 'response-cookies-failure.png') }).catch(() => {}); }
finally { await close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
