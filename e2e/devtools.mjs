// End-to-end: Dev tools drawer (Console, Network, Cookies, Performance) and automatic cookies.
// Drives the real Electron app with Playwright against the local fixture server.
// Usage: npm run build && node e2e/devtools.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from '../fixtures/server/server.mjs';

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
await page.setViewportSize({ width: 1400, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `devtools-${name}.png`) });
const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());
const drawer = page.locator('section.devtools');
const devTab = (name) => drawer.getByRole('tab', { name: new RegExp(`^${name}`) });

async function sendTo(url) {
  await page.getByLabel('URL', { exact: true }).fill(url);
  const before = await page.locator('.dt-network tbody tr').count().catch(() => 0);
  await page.keyboard.press('Control+Enter');
  await page.locator('.response .status').filter({ hasNotText: '…' }).first().waitFor({ timeout: 10000 });
  return before;
}

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();

  // 1. Footer button and shortcut.
  check('footer has a Dev tools button', await page.locator('.app-statusbar').getByRole('button', { name: 'Dev tools' }).isVisible());
  await page.keyboard.press('Control+Shift+J');
  await drawer.waitFor({ timeout: 3000 });
  check('Ctrl+Shift+J opens the drawer', await drawer.isVisible());
  check('drawer has the four tabs', (await drawer.getByRole('tab').allInnerTexts()).map((t) => t.replace(/\d+$/, '').trim()).join(',') === 'Console,Network,Cookies,Performance');
  check('cookie count starts at zero', (await page.locator('.app-statusbar').getByRole('button', { name: '0 cookies' }).count()) === 1);

  // 2. A request that sets cookies: Console shows the run.
  await page.getByRole('button', { name: '+ New request' }).click();
  await page.getByRole('dialog').locator('input').fill('Cookie check');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Cookie check' }).waitFor();
  await sendTo(`${base}/cookies/set?sid=abc123&theme=dark`);
  await page.locator('.response .status', { hasText: '200' }).waitFor({ timeout: 10000 });
  await page.locator('.dt-line', { hasText: '200 OK' }).waitFor({ timeout: 5000 });
  const lines = await page.locator('.dt-line').allInnerTexts();
  check('console shows the run start', lines.some((l) => l.includes('GET Cookie check · env none')), lines[0]);
  check('console shows the result', lines.some((l) => l.includes('200 OK')));
  await page.locator('.app-statusbar').getByRole('button', { name: '2 cookies' }).waitFor({ timeout: 5000 });
  check('footer counts the stored cookies', true);
  await shot('01-console');

  // 3. A redirect that sets another cookie; the jar's cookies go with it.
  await sendTo(`${base}/cookies/redirect`);
  await page.locator('.response .status', { hasText: '200' }).waitFor({ timeout: 10000 });
  await page.locator('.response .monaco-editor .view-lines', { hasText: 'hop' }).waitFor({ timeout: 5000 });
  const body = (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
  check('jar cookies and the redirect cookie reach the final hop', body.includes('"sid": "abc123"') && body.includes('"hop": "1"'), body.slice(0, 200));

  // 4. Network tab: rows, redirect chain, headers, timing, connection.
  await devTab('Network').click();
  const rows = page.locator('.dt-network tbody tr');
  check('network lists both sends', (await rows.count()) === 2);
  await rows.first().click();
  check('redirect chain shown', (await page.locator('.dt-hop').allInnerTexts()).map((t) => t.trim().split(/\s+/)[0]).join(',') === '302,200');
  const sent = await page.locator('.dt-details .headers-list').first().innerText();
  check('Cookie header sent and masked', /Cookie\s+••••••/.test(sent), sent.split('\n').find((l) => l.startsWith('Cookie')));
  check('headers the HTTP stack adds are listed', /User-Agent\s+Yept\//.test(sent) && /Host\s+127\.0\.0\.1/.test(sent));
  check('cookie source explained', (await page.locator('.dt-details').innerText()).includes('from the cookie jar (sid, theme)'));
  await shot('02-network-request');
  await page.locator('.dt-details').getByRole('tab', { name: 'Timing' }).click();
  check('timing phases shown', (await page.locator('.dt-phase').count()) === 6);
  await shot('03-network-timing');
  await page.locator('.dt-details').getByRole('tab', { name: 'Connection' }).click();
  const conn = await page.locator('.dt-details .headers-list').innerText();
  check('connection shows remote address and HTTP version', conn.includes(`127.0.0.1:${server.address().port}`) && conn.includes('1.1'), conn.split('\n').slice(0, 2).join(' | '));
  await page.locator('.dt-details').getByRole('tab', { name: 'Response' }).click();
  await page.locator('.dt-hop').first().click();
  const hopResponse = await page.locator('.dt-details .dt-pane').innerText();
  check('redirect hop response shows its Set-Cookie masked', /set-cookie\s+••••••/.test(hopResponse) && !hopResponse.includes('hop=1'));
  await page.locator('.dt-details .masked').first().click();
  check('a masked value can be revealed', (await page.locator('.dt-details .dt-pane').innerText()).includes('hop=1'));

  // 5. Copy as cURL, masked and with secrets.
  await page.locator('.dt-hop').last().click();
  await page.getByRole('button', { name: 'Copy as cURL' }).click();
  const masked = await clipboard();
  check('Copy as cURL keeps secrets masked', masked.startsWith('curl ') && masked.includes("'Cookie: ••••••'") && !masked.includes('abc123'), masked.split('\n')[0]);
  await page.getByRole('button', { name: '…with secrets' }).click();
  const full = await clipboard();
  check('Copy as cURL with secrets includes the cookies', full.includes('sid=abc123'));

  // 5a. Copy as another language: masked by default, with secrets only when ticked in the menu.
  const copyAs = async (language, withSecrets = false) => {
    await page.getByRole('button', { name: 'Copy as', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Copy as' });
    if (withSecrets) await menu.getByRole('menuitemcheckbox', { name: 'Include secrets and cookies' }).click();
    if (language === 'C# HttpClient' && !withSecrets) await shot('03b-copy-as');
    await menu.getByRole('menuitem', { name: language }).click();
    await page.waitForTimeout(200);
    return clipboard();
  };
  const csharp = await copyAs('C# HttpClient');
  check('Copy as C# keeps secrets masked', csharp.includes('new HttpRequestMessage(new HttpMethod("GET")') && csharp.includes('"Cookie", "••••••"') && !csharp.includes('abc123'), csharp.split('\n').find((l) => l.includes('Cookie')));
  check('Copy as C# with secrets includes the cookies', (await copyAs('C# HttpClient', true)).includes('sid=abc123'));
  const powershell = await copyAs('PowerShell');
  check('Copy as PowerShell keeps secrets masked', powershell.includes('Invoke-RestMethod @params') && powershell.includes("'Cookie' = '••••••'") && !powershell.includes('abc123'), powershell.split('\n').find((l) => l.includes('Cookie')));
  check('Copy as PowerShell with secrets includes the cookies', (await copyAs('PowerShell', true)).includes('sid=abc123'));
  check('the secrets tick does not stay on', !(await copyAs('Python requests')).includes('abc123'));

  // 5b. Raw HTTP view: request and response heads as text, masked and labelled as reconstructed.
  await page.locator('.dt-details').getByRole('tab', { name: 'Request' }).click();
  await page.locator('.dt-details').getByRole('button', { name: 'Raw', exact: true }).click();
  const rawReq = await page.getByLabel('Raw request').innerText();
  const firstLine = (s) => s.split('\n')[0];
  check('raw request starts with the request line', /^GET \/\S* HTTP\/1\.1\n/.test(rawReq), firstLine(rawReq));
  check('raw request lists headers with Cookie masked', rawReq.includes(`Host: 127.0.0.1:${server.address().port}`) && rawReq.includes('Cookie: ••••••') && !rawReq.includes('abc123'));
  check('raw view says it is reconstructed', await page.locator('.dt-details').getByText('Reconstructed from the recorded request').isVisible());
  await page.locator('.dt-raw-actions').getByRole('button', { name: 'Copy', exact: true }).click();
  check('Copy copies the masked raw request', await clipboard() === rawReq);
  await page.locator('.dt-raw-actions').getByRole('button', { name: '…with secrets' }).click();
  await page.waitForTimeout(200);
  const rawFull = await clipboard();
  check('raw request with secrets includes the cookies', rawFull.startsWith('GET ') && rawFull.includes('sid=abc123'), firstLine(rawFull));
  await page.locator('.dt-hop').first().click();
  check('raw request of a redirect hop', (await page.getByLabel('Raw request').innerText()).startsWith('GET /cookies/redirect HTTP/1.1'));
  check('secrets copy only for the last request of a chain', await page.locator('.dt-raw-actions').getByRole('button', { name: '…with secrets' }).isDisabled());
  await page.locator('.dt-details').getByRole('tab', { name: 'Response' }).click();
  const rawRes = await page.getByLabel('Raw response').innerText();
  check('raw response has the status line and masked Set-Cookie', rawRes.startsWith('HTTP/1.1 302 Found') && /set-cookie: hop=••••••/i.test(rawRes) && !rawRes.includes('hop=1'), firstLine(rawRes));
  await page.getByLabel('Show cookie values').check();
  check('cookie values can be shown in the raw response', (await page.getByLabel('Raw response').innerText()).includes('hop=1'));
  await rows.nth(1).click();
  check('Raw stays selected for another run', await page.getByLabel('Raw request').isVisible());
  await shot('02b-network-raw');
  await page.locator('.dt-details').getByRole('button', { name: 'Table', exact: true }).click();

  // 6. Cookies tab: grouped, masked, add, edit, delete, clear.
  await page.locator('.app-statusbar').getByRole('button', { name: '3 cookies' }).click();
  await page.locator('.dt-cookies').waitFor();
  check('footer count opens the Cookies tab', await devTab('Cookies').getAttribute('aria-selected') === 'true');
  const jar = await page.locator('.dt-cookies').innerText();
  check('cookies grouped by domain with values masked', jar.includes('127.0.0.1') && jar.includes('3 cookies') && !jar.includes('abc123'));
  await shot('04-cookies');
  await page.getByRole('button', { name: 'Add cookie' }).click();
  await page.getByLabel('Cookie name').fill('lang');
  await page.getByLabel('Cookie value').fill('en');
  await page.getByRole('button', { name: 'Save cookie' }).click();
  await page.locator('.app-statusbar').getByRole('button', { name: '4 cookies' }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Edit cookie theme' }).click();
  await page.getByLabel('Cookie value').fill('light');
  await page.getByRole('button', { name: 'Save cookie' }).click();
  await page.getByRole('button', { name: 'Delete cookie hop' }).click();
  await page.locator('.app-statusbar').getByRole('button', { name: '3 cookies' }).waitFor({ timeout: 3000 });
  await sendTo(`${base}/cookies/echo`);
  await page.locator('.response .monaco-editor .view-lines', { hasText: 'lang' }).waitFor({ timeout: 5000 });
  const echo = (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
  check('added and edited cookies are sent, deleted ones are not', echo.includes('"lang": "en"') && echo.includes('"theme": "light"') && !echo.includes('"hop"'), echo.slice(0, 160));

  // 7. "Don't send stored cookies" on this request.
  await page.locator('.subtab', { hasText: 'Settings' }).first().click();
  await page.getByLabel("Don't send stored cookies").check();
  await sendTo(`${base}/cookies/echo`);
  // The previous step also called /cookies/echo: wait for this response, not the one already on screen.
  // A timeout falls through to the check below, which then reports what was actually received.
  await page.locator('.response .monaco-editor .view-lines', { hasText: /"header":\s*""/ }).waitFor({ timeout: 5000 }).catch(() => {});
  const none = (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
  check("'Don't send stored cookies' sends none", none.includes('"header": ""'), none.slice(0, 120));
  await page.getByLabel("Don't send stored cookies").uncheck();

  // 8. Clear all, with confirmation.
  await devTab('Cookies').click();
  await drawer.getByRole('button', { name: 'Clear all' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear all' }).click();
  await page.locator('.app-statusbar').getByRole('button', { name: '0 cookies' }).waitFor({ timeout: 3000 });
  check('Clear all empties the jar', true);

  // 9. Console: filters and opening a run.
  await devTab('Console').click();
  const total = await page.locator('.dt-line').count();
  await drawer.getByRole('checkbox', { name: 'info' }).uncheck();
  check('level filter hides info lines', (await page.locator('.dt-line').count()) < total);
  await drawer.getByRole('checkbox', { name: 'info' }).check();
  await drawer.getByLabel('Filter console').fill('302');
  await drawer.getByLabel('Filter console').fill('');
  await page.locator('.tree-row', { hasText: 'List bookings' }).click();
  await page.locator('.doc-title', { hasText: 'List bookings' }).waitFor();
  await page.locator('.dt-line', { hasText: 'Cookie check' }).first().click();
  await page.locator('.doc-title', { hasText: 'Cookie check' }).waitFor({ timeout: 3000 });
  check('clicking a console line opens its request', true);

  // 10. Performance, then the drawer remembers its tab.
  await devTab('Performance').click();
  await page.locator('.dt-stats', { hasText: 'Uptime' }).waitFor({ timeout: 5000 });
  const perf = await drawer.innerText();
  check('performance lists the main process and window', perf.includes('Main') && perf.includes('Window'));
  await shot('05-performance');
  await drawer.getByRole('button', { name: 'Close dev tools' }).click();
  check('close button hides the drawer', !(await drawer.isVisible()));
  await page.keyboard.press('Control+Shift+J');
  check('reopens on the last tab', (await devTab('Performance').getAttribute('aria-selected')) === 'true');

  // 11. Clear forgets this session's activity.
  await devTab('Network').click();
  await drawer.getByRole('button', { name: 'Clear' }).click();
  check('Clear empties the network list', (await page.locator('.dt-network tbody tr').count()) === 0);

  // 12. Dark theme.
  await devTab('Console').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await sendTo(`${base}/status/404`);
  await page.locator('.dt-line.warn').first().waitFor({ timeout: 5000 });
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
