// HTML and XML response bodies: Pretty formats them, Preview renders HTML in a sandboxed frame that runs no scripts and loads nothing.
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from '../fixtures/server/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-response-html-'));
const workspace = join(tmp, 'ws'); const profile = join(tmp, 'profile'); const out = join(root, 'e2e/out');
await fs.cp(join(root, 'fixtures/collections/sample-travel'), workspace, { recursive: true });
await fs.mkdir(profile); await fs.mkdir(out, { recursive: true });
await fs.writeFile(join(profile, 'preferences.json'), JSON.stringify({ lastWorkspace: workspace }));
const server = createFixtureServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const hits = async () => (await fetch(`${base}/html/stats`)).json();
let app, page;
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const copied = async () => {
  await page.locator('.response .statusbar').getByRole('button', { name: 'Copy', exact: true }).click();
  return app.evaluate(({ clipboard }) => clipboard.readText());
};
const mode = (name) => page.locator('.response .subtabs').getByRole('button', { name, exact: true });
const send = async (path) => {
  await page.getByLabel('URL', { exact: true }).fill(`${base}${path}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('.response .status', { hasText: '200' }).waitFor();
};
try {
  app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: profile } }); page = await app.firstWindow();
  page.on('pageerror', (e) => check('no renderer errors', false, e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.getByRole('button', { name: '+ New request' }).click(); await page.getByRole('dialog').getByRole('textbox').fill('HTML page'); await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'HTML page' }).waitFor();

  // Pretty (the default) indents the page with HTML highlighting.
  await send('/html');
  check('HTML opens in Pretty with Raw and Preview beside it', (await mode('Pretty').getAttribute('aria-pressed')) === 'true' && await mode('Preview').isVisible());
  await page.locator('.response .monaco-editor .view-lines', { hasText: '<title>Fixture page</title>' }).waitFor({ timeout: 5000 });
  // The editor renders lines out of order and wraps long ones, so compare what Copy copies: the text on screen.
  const pretty = await copied();
  check('Pretty indents nested elements', pretty.includes('\n  <h1>Booking summary</h1>\n') && pretty.includes('\n  <ul>\n    <li>Lisbon</li>\n    <li>Oslo</li>\n  </ul>\n'), pretty.slice(0, 300));
  check('Pretty highlights HTML', await page.locator('.response .monaco-editor .view-lines span[class*="mtk"]').evaluateAll((els) => new Set(els.map((e) => getComputedStyle(e).color)).size > 2));
  await page.screenshot({ path: join(out, 'response-html-pretty.png') });
  await mode('Raw').click();
  const received = await (await fetch(`${base}/html`)).text();
  check('Raw shows the body as received', (await copied()) === received);

  // Preview: rendered, styled by its inline CSS, with nothing run or fetched.
  const appUrl = page.url();
  const before = await hits();
  await mode('Preview').click();
  const frameEl = page.locator('.response iframe.html-preview');
  await frameEl.waitFor();
  check('preview frame is fully sandboxed', (await frameEl.getAttribute('sandbox')) === '');
  const frame = page.frameLocator('.response iframe.html-preview');
  await frame.getByRole('heading', { name: 'Booking summary' }).waitFor({ timeout: 5000 });
  check('inline styles apply', (await frame.getByRole('heading', { name: 'Booking summary' }).evaluate((h) => getComputedStyle(h).color)) === 'rgb(200, 30, 30)');
  check('preview note explains what is blocked', (await page.locator('.response').innerText()).includes('Nothing is loaded from the network'));
  await frame.getByRole('link', { name: 'details' }).click().catch(() => {});
  await frame.getByRole('button', { name: 'Submit' }).click().catch(() => {});
  await page.waitForTimeout(1800); // past the page's 1 s meta refresh
  check('the page script did not run', (await frame.locator('body').getAttribute('data-script')) === null && (await frame.locator('title').innerText().catch(() => '')) !== 'script ran');
  check('preview stays on the page after a link, a form and a refresh', await frame.getByRole('heading', { name: 'Booking summary' }).isVisible());
  const after = await hits();
  const fetched = Object.keys(after).filter((k) => after[k] !== before[k]);
  check('nothing was requested from the server (image, stylesheet, frame, link, form, refresh)', fetched.length === 0, fetched.join(', '));
  check('the app window was not navigated', page.url() === appUrl && await page.getByRole('button', { name: 'Send', exact: true }).isVisible());
  check('no extra windows opened', (await app.windows()).length === 1);
  await page.screenshot({ path: join(out, 'response-html-preview-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  check('preview keeps a white page in the dark theme', (await frameEl.evaluate((f) => getComputedStyle(f).backgroundColor)) === 'rgb(255, 255, 255)');
  await page.screenshot({ path: join(out, 'response-html-preview-dark.png') });
  await page.emulateMedia({ colorScheme: null });

  // Links: the OS only ever gets http(s) URLs, through main's check, and nothing at all from the preview, whose sandbox
  // blocks new windows and frame navigation. A stub stands in for shell.openExternal so no browser opens.
  const stubbed = await app.evaluate(({ shell }) => {
    globalThis.openedExternally = [];
    shell.openExternal = async (url) => { globalThis.openedExternally.push(url); };
    return shell.openExternal.toString().includes('openedExternally');
  });
  check('openExternal is stubbed', stubbed);
  const openedExternally = () => app.evaluate(() => globalThis.openedExternally);
  const linkNames = ['web page', 'local file', 'network share', 'settings', 'email', 'script', 'same server', 'top'];
  const hitsBeforeLinks = await hits();
  await send('/html/links');
  await frame.getByRole('heading', { name: 'Links' }).waitFor({ timeout: 5000 });
  for (const name of linkNames) {
    const link = frame.getByRole('link', { name, exact: true });
    await link.click();
    await link.click({ modifiers: ['Shift'] });
    await link.click({ modifiers: ['Control'] });
    await link.click({ button: 'middle' });
  }
  await page.waitForTimeout(800);
  check('no preview link reaches the operating system (plain, Shift, Ctrl and middle clicks)', stubbed && (await openedExternally()).length === 0, JSON.stringify(stubbed && await openedExternally()));
  check('preview links open no windows and leave the app and the preview where they were', (await app.windows()).length === 1 && page.url() === appUrl && await frame.getByRole('heading', { name: 'Links' }).isVisible());
  const hitsAfterLinks = await hits();
  check('preview links request nothing', ['newtab', 'top'].every((k) => hitsAfterLinks[k] === hitsBeforeLinks[k]), JSON.stringify(hitsAfterLinks));
  if (stubbed) {
    // A window the app itself asks for goes through the same check: web pages leave, the rest are dropped.
    await page.evaluate(() => {
      for (const url of ['file:///C:/Windows/win.ini', 'https://api.example.test/docs', '\\\\server.example.test\\share', 'ms-settings:privacy', 'mailto:someone@example.test', 'javascript:alert(1)', 'data:text/html,hi', 'http://127.0.0.1:9/page'])
        window.open(url);
    });
    const deadline = Date.now() + 3000;
    while ((await openedExternally()).length < 2 && Date.now() < deadline) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    const opened = await openedExternally();
    check('only http(s) URLs from window.open reach the operating system', JSON.stringify(opened) === JSON.stringify(['https://api.example.test/docs', 'http://127.0.0.1:9/page']), JSON.stringify(opened));
    check('window.open opens no Electron windows', (await app.windows()).length === 1 && page.url() === appUrl);
  }

  // A larger page (about 400 KB) is formatted in the worker; the window keeps responding meanwhile.
  await mode('Pretty').click();
  await send('/html/rows?n=10000');
  await page.locator('.response .truncated-note', { hasText: 'Formatting…' }).waitFor({ state: 'hidden', timeout: 15000 });
  const rows = await copied();
  check('a large page is formatted in the background', rows.includes('\n    <tr>\n      <td>9999</td>\n      <td>Row 9999</td>\n    </tr>\n  </table>\n'), `${rows.length} characters`);
  await mode('Preview').click();

  // Preview stays chosen for the tab; a response that isn't HTML falls back to Pretty without the Preview button.
  await send('/xml');
  check('XML has no Preview and shows Pretty', !(await mode('Preview').isVisible()) && (await mode('Pretty').getAttribute('aria-pressed')) === 'true');
  await page.locator('.response .monaco-editor .view-lines', { hasText: '<id>bk-1001</id>' }).waitFor({ timeout: 5000 });
  const xml = await copied();
  check('XML is indented without HTML rules', xml.includes('\n    <link>https://api.example.test/</link>\n') && xml.includes('\n      <id>bk-1001</id>\n'), xml);
  await send('/html');
  await frameEl.waitFor();
  check('Preview comes back for the next HTML response', (await mode('Preview').getAttribute('aria-pressed')) === 'true');
  check('Copy in Preview copies the body as received', (await copied()) === received);
} catch (e) { console.error(e); check('scenario completed', false); await page?.screenshot({ path: join(out, 'response-html-failure.png') }).catch(() => {}); }
finally { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
