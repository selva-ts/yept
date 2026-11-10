// Response tools: the JSONPath filter, "Set as variable" (used by the next request), "Save to file" (bytes as received,
// named from Content-Disposition), image and PDF preview without network, and comparing two runs from history.
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer, CLIENT_SECRET } from '../fixtures/server/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-response-tools-'));
const workspace = join(tmp, 'ws'); const profile = join(tmp, 'profile'); const out = join(root, 'e2e/out');
await fs.cp(join(root, 'fixtures/collections/sample-travel'), workspace, { recursive: true });
await fs.mkdir(profile); await fs.mkdir(out, { recursive: true });
await fs.writeFile(join(profile, 'preferences.json'), JSON.stringify({ lastWorkspace: workspace }));
const server = createFixtureServer();
let served = 0;
server.on('request', () => { served++; });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let app, page;
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const nbsp = (s) => s.replaceAll(String.fromCharCode(160), ' ');
const statusbar = () => page.locator('.response .statusbar');
const filterBox = () => page.getByLabel('Filter with JSONPath');
const filterStatus = () => page.locator('.json-filter-status');
const copied = async () => {
  await statusbar().getByRole('button', { name: 'Copy', exact: true }).click();
  return app.evaluate(({ clipboard }) => clipboard.readText());
};
const send = async () => {
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('.response .status').waitFor();
};
const newRequest = async (name, url) => {
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'New request', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: name }).waitFor();
  await page.getByLabel('URL', { exact: true }).fill(url);
};
const openByPalette = async (query, title) => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill(query);
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: title }).waitFor();
};
async function filesContaining(dir, value) {
  const found = [];
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && (await fs.readFile(join(e.parentPath, e.name))).toString('latin1').includes(value)) found.push(e.name);
  }
  return found;
}

try {
  app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: profile } }); page = await app.firstWindow();
  page.on('pageerror', (e) => check('no renderer errors', false, e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();

  // The local environment, pointed at the fixture server, with the client secret.
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Environments…' }).click();
  const envDialog = page.getByRole('dialog', { name: 'Environments' });
  await envDialog.getByLabel('Local override for baseUrl').fill(base);
  await envDialog.getByLabel('Local override for baseUrl').press('Enter');
  await envDialog.getByLabel('Secret value for clientSecret').fill(CLIENT_SECRET);
  await envDialog.getByLabel('Secret value for clientSecret').press('Enter');
  await envDialog.getByRole('button', { name: 'Use this environment' }).click();
  await page.waitForTimeout(300);
  await envDialog.getByRole('button', { name: 'Close' }).click();

  // 1. Filter: matches, an invalid expression, clear.
  await openByPalette('auth login', 'Login');
  await send();
  await page.locator('.response .monaco-editor .view-lines', { hasText: 'access_token' }).waitFor({ timeout: 10000 });
  const body = JSON.parse(await copied());
  const token = body.access_token;
  check('login returns a token', typeof token === 'string' && token.length > 10);
  await filterBox().fill('$.access_token');
  await filterStatus().filter({ hasText: '1 match' }).waitFor();
  check('a filter shows its matches', JSON.stringify(JSON.parse(await copied())) === JSON.stringify([token]));
  await filterBox().fill('$..*');
  await filterStatus().filter({ hasText: 'matches' }).waitFor();
  check('recursive descent counts every value', (await filterStatus().innerText()) === `${Object.keys(body).length} matches`, await filterStatus().innerText());
  await filterBox().fill('$.items[?(@.price <');
  await filterStatus().filter({ hasText: 'Expected' }).waitFor();
  check('an invalid expression shows a message', (await filterStatus().getAttribute('class')).includes('bad-text'), await filterStatus().innerText());
  check('an invalid expression leaves the body shown', JSON.stringify(JSON.parse(await copied())) === JSON.stringify(body));
  await filterBox().fill('$.token_type');
  await page.getByRole('button', { name: 'Clear filter' }).click();
  check('clearing returns to the whole body', (await filterBox().inputValue()) === '' && (await filterStatus().innerText()) === '' && JSON.stringify(JSON.parse(await copied())) === JSON.stringify(body));
  await page.screenshot({ path: join(out, 'response-tools-filter.png') });

  // 2. Set as variable: the filter's one match, as a runtime variable; then used by the next request.
  await filterBox().fill('$.access_token');
  await filterStatus().filter({ hasText: '1 match' }).waitFor();
  await page.getByRole('button', { name: 'Set as variable…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Set as variable' });
  check('the name comes from the path', (await dlg.getByLabel('Variable name').inputValue()) === 'access_token');
  check('a token is offered as a local secret, its value hidden', await dlg.getByRole('radio', { name: /Local secret/ }).isChecked() && !(await dlg.innerText()).includes(token) && (await dlg.getByLabel('Value').innerText()).includes('hidden'));
  await page.screenshot({ path: join(out, 'response-tools-set-variable.png') });
  await dlg.getByLabel('Variable name').fill('bookingToken');
  await dlg.getByRole('radio', { name: /Runtime variable/ }).check();
  check('a runtime value is shown', (await dlg.getByLabel('Value').innerText()) === token);
  await dlg.getByRole('button', { name: 'Set variable' }).click();
  await page.locator('.toast', { hasText: 'Set {{bookingToken}} as a runtime variable of "local"' }).waitFor();
  check('the dialog says which variable was set', true);
  await newRequest('Bookings by token', '{{baseUrl}}/bookings-by-query?access_token={{bookingToken}}');
  await send();
  check('the next request uses the variable', (await page.locator('.response .status').innerText()).startsWith('200'), await page.locator('.response .status').innerText());

  // The same value as a local secret: declared in the environment file, the value only on this machine, masked.
  await openByPalette('auth login', 'Login');
  await page.locator('.response .monaco-editor .view-lines', { hasText: 'access_token' }).waitFor({ timeout: 10000 });
  await filterBox().fill('$.access_token');
  await filterStatus().filter({ hasText: '1 match' }).waitFor();
  await page.getByRole('button', { name: 'Set as variable…' }).click();
  await dlg.getByLabel('Variable name').fill('savedToken');
  await dlg.getByRole('button', { name: 'Set variable' }).click();
  await page.locator('.toast', { hasText: 'Stored {{savedToken}} as a local secret of "local"' }).waitFor();
  const envFile = await fs.readFile(join(workspace, 'environments', 'local.yml'), 'utf8');
  check('the secret is declared in the environment file without its value', envFile.includes('name: savedToken') && !envFile.includes(token));
  check('the secret value is nowhere in the collection', (await filesContaining(workspace, token)).length === 0);
  const localStore = await fs.readFile(join(profile, 'local-environments.json'), 'utf8');
  check('the secret value is stored encrypted', localStore.includes('savedToken') && !localStore.includes(token));

  // 3. Save to file: the bytes as received, named from Content-Disposition.
  await newRequest('Download', `${base}/download`);
  await send();
  const target = join(tmp, 'saved-download.bin');
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async (...args) => { globalThis.saveOptions = args.at(-1); return { canceled: false, filePath: f }; };
  }, target);
  await statusbar().getByRole('button', { name: 'Save to file…' }).click();
  await page.locator('.toast', { hasText: 'Saved to' }).waitFor();
  const saveOptions = await app.evaluate(() => globalThis.saveOptions);
  check('the file name comes from Content-Disposition', saveOptions?.defaultPath === 'sample-export.bin', JSON.stringify(saveOptions));
  const expected = Buffer.from(await (await fetch(`${base}/download`)).arrayBuffer());
  check('the saved file has the bytes as received', (await fs.readFile(target)).equals(expected));
  await newRequest('Binary', `${base}/binary`);
  await send();
  const binaryTarget = join(tmp, 'saved-binary.bin');
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async (...args) => { globalThis.saveOptions = args.at(-1); return { canceled: false, filePath: f }; };
  }, binaryTarget);
  await statusbar().getByRole('button', { name: 'Save to file…' }).click();
  await page.locator('.toast', { hasText: binaryTarget }).waitFor();
  check('without Content-Disposition the URL names the file', (await app.evaluate(() => globalThis.saveOptions))?.defaultPath === 'binary.bin');
  check('/binary is saved byte for byte', (await fs.readFile(binaryTarget)).equals(Buffer.from(await (await fetch(`${base}/binary`)).arrayBuffer())));

  // 4. Image and PDF preview: from the received bytes, in a fully sandboxed frame, with no request anywhere.
  const requests = [];
  page.on('request', (r) => { if (/^https?:/i.test(r.url()) && !r.url().startsWith('http://localhost:5173')) requests.push(r.url()); });
  await newRequest('Image', `${base}/media/image.png`);
  await send();
  const servedAfterSend = served;
  const requestsAfterSend = requests.length;
  const media = page.locator('.response iframe.media-preview');
  await media.waitFor({ timeout: 10000 });
  check('an image opens in the preview frame', (await media.getAttribute('title')) === 'Image preview');
  check('the image frame is fully sandboxed', (await media.getAttribute('sandbox')) === '');
  const image = page.frameLocator('.response iframe.media-preview').getByRole('img', { name: 'Response image' });
  await image.waitFor();
  const size = await image.evaluate((img) => new Promise((r) => (img.complete ? r([img.naturalWidth, img.naturalHeight]) : img.addEventListener('load', () => r([img.naturalWidth, img.naturalHeight])))));
  check('the image is drawn from the received bytes', JSON.stringify(size) === '[24,16]', JSON.stringify(size));
  check('the frame carries the no-network policy', (await page.frameLocator('.response iframe.media-preview').locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).includes("default-src 'none'"));
  await page.waitForTimeout(500);
  check('the image preview made no network request', served === servedAfterSend && requests.length === requestsAfterSend, `${served - servedAfterSend} served, ${requests.slice(requestsAfterSend).join(', ')}`);
  await page.screenshot({ path: join(out, 'response-tools-image.png') });

  await newRequest('PDF', `${base}/media/doc.pdf`);
  await send();
  const servedAfterPdf = served;
  const requestsAfterPdf = requests.length;
  await page.locator('.response iframe.media-preview[title="PDF preview"]').waitFor({ timeout: 20000 });
  const pageImage = page.frameLocator('.response iframe.media-preview').getByRole('img', { name: 'Page 1' });
  await pageImage.waitFor();
  const pageWidth = await pageImage.evaluate((img) => img.naturalWidth);
  check('a PDF page is drawn into the preview', pageWidth > 300, String(pageWidth));
  check('the PDF note says how it is shown', (await page.locator('.response .truncated-note').first().innerText()).includes('1 page'));
  await page.waitForTimeout(500);
  check('the PDF preview made no network request', served === servedAfterPdf && requests.length === requestsAfterPdf, `${served - servedAfterPdf} served, ${requests.slice(requestsAfterPdf).join(', ')}`);
  check('no extra windows opened', (await app.windows()).length === 1);
  await page.screenshot({ path: join(out, 'response-tools-pdf.png') });

  // 5. Compare two runs from history: a changed header, the redacted cookie, the body difference.
  // Taller, so the diff editor renders every header line.
  await page.setViewportSize({ width: 1440, height: 1600 });
  await newRequest('Changing', `${base}/changing`);
  await send();
  await send();
  await statusbar().getByRole('button', { name: /^History/ }).click();
  await page.locator('.history-item').nth(1).waitFor();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.locator('.history-item').nth(0).click();
  await page.locator('.history-item').nth(1).click();
  const compare = page.locator('.history-compare');
  await compare.waitFor();
  await compare.locator('.monaco-diff-editor').waitFor({ timeout: 10000 });
  const changes = (await page.getByLabel('Header changes').innerText()).toLowerCase();
  check('the comparison lists the changed header', changes.includes('x-run-count changed') && !changes.includes('x-fixed'), changes);
  check('the comparison says it uses redacted stored data', (await compare.locator('.compare-note').innerText()).includes('redacted'));
  await page.waitForFunction(() => document.querySelectorAll('.history-compare .monaco-diff-editor .char-insert, .history-compare .monaco-diff-editor .line-insert').length > 0, null, { timeout: 10000 });
  const headerText = nbsp(await compare.locator('.monaco-diff-editor').innerText()).toLowerCase();
  check('the diff shows both header values', headerText.includes('x-run-count: 1') && headerText.includes('x-run-count: 2'), headerText);
  check('cookies stay redacted in the comparison', headerText.includes('set-cookie: «redacted»') && !/visit=v\d/.test(headerText));
  await page.screenshot({ path: join(out, 'response-tools-compare.png') });
  await compare.getByRole('tab', { name: /Body/ }).click();
  check('the body is marked changed', (await compare.getByRole('tab', { name: /Body/ }).innerText()).includes('changed'));
  await page.waitForFunction(() => document.querySelector('.history-compare .monaco-diff-editor')?.textContent?.includes('run'), null, { timeout: 10000 });
  check('the body diff shows the JSON', nbsp(await compare.locator('.monaco-diff-editor').innerText()).includes('"run": 2'));
  await compare.getByRole('button', { name: 'Close comparison' }).click();
  check('closing the comparison shows the response again', await page.locator('.response .subtabs').first().isVisible() && !(await compare.isVisible()));
} catch (e) { console.error(e); check('scenario completed', false); await page?.screenshot({ path: join(out, 'response-tools-failure.png') }).catch(() => {}); }
finally { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
