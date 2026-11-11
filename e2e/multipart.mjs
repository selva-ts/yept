// End-to-end: multipart / form-data bodies. The Body tab's Multipart table, text and file fields, the file picker
// (a file inside the collection is saved relative to it; one outside is kept on this computer only), sending, the
// Network tab summary and Copy as cURL, a missing file, and the saved request file. Also a body type Yept doesn't
// support (Bruno's binary file and SPARQL bodies): shown read-only and kept unchanged when other fields are saved.
// Usage: npm run build && node e2e/multipart.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const collectionDir = join(wsDir, 'sample-travel');
await fs.cp(join(root, 'fixtures', 'collections'), wsDir, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: wsDir }));

// One file inside the collection folder, one elsewhere on this computer.
const MARKER = 'e2e-file-contents-marker';
const inside = join(collectionDir, 'files', 'boarding-pass.txt');
const outsideDir = join(tmp, 'my-documents');
const outside = join(outsideDir, 'passport-scan.png');
await fs.mkdir(dirname(inside), { recursive: true });
await fs.mkdir(outsideDir, { recursive: true });
await fs.writeFile(inside, `boarding pass ${MARKER}\n`);
await fs.writeFile(outside, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(MARKER)]));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// A request written by Bruno with a binary file body, which Yept doesn't support.
const binaryBody = `  body: # fixture file
    type: "file"
    data:
      - filePath: "./files/ticket-scan.bin"
        contentType: application/octet-stream
        selected: true
`;
const binaryRequest = join(collectionDir, 'Binary ticket scan.yml');
await fs.writeFile(binaryRequest, `info:
  name: Binary ticket scan
  type: http
  seq: 9

http:
  method: POST
  url: https://api.example.test/scan
${binaryBody}
settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: true
`);
const sparqlBody = `  body: {type: sparql, data: "SELECT * WHERE { ?s ?p ?o }"}\n`;
const sparqlRequest = join(collectionDir, 'Query catalogue.yml');
await fs.writeFile(sparqlRequest, `info:
  name: Query catalogue
  type: http
  seq: 10
http:
  method: POST
  url: https://api.example.test/query
${sparqlBody}`);

const server = createFixtureServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData }, timeout: 60000 });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1400, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `multipart-${name}.png`) });
const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());
const stubOpen = (files) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f }); }, files);
const responseText = async () => (await page.locator('.response .monaco-editor .view-lines').innerText()).replaceAll(String.fromCharCode(160), ' ');
const rows = () => page.locator('.multipart tbody tr');

try {
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.getByRole('button', { name: '+ New request' }).click();
  await page.getByRole('dialog').locator('input').fill('Upload documents');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Upload documents' }).waitFor();
  await page.getByLabel('Method').selectOption('POST');
  await page.getByLabel('URL', { exact: true }).fill(`${base}/upload`);

  // 1. Body tab: Multipart, a text field and a file field.
  await page.locator('.subtab', { hasText: 'Body' }).first().click();
  await page.getByLabel('Multipart', { exact: true }).check();
  check('Multipart is a body option', await page.locator('.multipart').isVisible());
  await page.getByRole('button', { name: '+ Text field' }).click();
  await rows().nth(0).getByLabel('Field name').fill('traveller');
  await rows().nth(0).getByLabel('Field value').fill('Alex Example');
  await page.getByRole('button', { name: '+ File field' }).click();
  await rows().nth(1).getByLabel('Field name').fill('documents');
  check('an empty file field says no file is chosen', await rows().nth(1).getByText('No file chosen on this computer').isVisible());

  // 2. The picker: inside the collection -> relative path; outside -> this computer only.
  await stubOpen([inside, outside]);
  await rows().nth(1).getByRole('button', { name: 'Choose files…' }).click();
  await rows().nth(1).getByLabel('File path').waitFor();
  await rows().nth(1).locator('.mp-file.local', { hasText: 'passport-scan.png' }).waitFor();
  check('a file inside the collection is shown relative to it', (await rows().nth(1).getByLabel('File path').inputValue()) === 'files/boarding-pass.txt');
  check('a file outside the collection is marked this computer only', await rows().nth(1).locator('.mp-file.local', { hasText: 'passport-scan.png' }).getByText('this computer only').isVisible());
  await shot('01-body');

  // 3. Send: both files arrive intact with their names and types.
  await page.keyboard.press('Control+Enter');
  await page.locator('.response .status', { hasText: '200' }).waitFor();
  // The response editor loads after the status line, so wait for its text rather than reading it at once.
  await page.locator('.response .monaco-editor .view-lines', { hasText: 'traveller' }).waitFor();
  check('the response shows the parts the server received', (await responseText()).includes('"traveller"'));
  const echo = await (await fetch(`${base}/upload/last`)).json();
  const parts = echo.parts ?? [];
  check('Content-Length matches the body sent', echo.contentLength === echo.received, `${echo.contentLength} vs ${echo.received}`);
  check('the server gets the text field', parts[0]?.name === 'traveller' && parts[0]?.value === 'Alex Example', JSON.stringify(parts[0]));
  check('the file inside the collection arrives intact', parts[1]?.fileName === 'boarding-pass.txt' && parts[1]?.contentType === 'text/plain' && parts[1]?.sha256 === sha(inside), JSON.stringify(parts[1]));
  check('the file kept on this computer arrives intact', parts[2]?.fileName === 'passport-scan.png' && parts[2]?.contentType === 'image/png' && parts[2]?.sha256 === sha(outside), JSON.stringify(parts[2]));

  // 4. Network tab: a summary with file names and sizes, never contents; cURL with -F.
  await page.keyboard.press('Control+Shift+J');
  const drawer = page.locator('section.devtools');
  await drawer.waitFor();
  await drawer.getByRole('tab', { name: /^Network/ }).click();
  await page.locator('.dt-network tbody tr').first().click();
  const details = await page.locator('.dt-details').innerText();
  check('Network shows field names, file names and sizes', details.includes('multipart/form-data, 3 parts') && details.includes('documents: file boarding-pass.txt (') && details.includes('documents: file passport-scan.png ('), details.split('\n').filter((l) => l.includes('multipart') || l.includes(': file')).join(' | '));
  check('Network never shows file contents', !details.includes(MARKER));
  await shot('02-network');
  await page.getByRole('button', { name: 'Copy as cURL' }).click();
  const curl = await clipboard();
  check('Copy as cURL uses -F for the files', curl.includes("--form-string 'traveller=Alex Example'") && curl.includes('-F \'documents=@"') && curl.includes('filename="passport-scan.png"') && !/content-type: multipart/i.test(curl), curl.split('\n').slice(-3).join(' '));
  await page.keyboard.press('Control+Shift+J');
  check('the response pane shows no file contents', !(await page.locator('.response').innerText()).includes(MARKER));

  // 5. Save: the relative path is in the shared file; the outside file is not.
  await page.keyboard.press('Control+s');
  const file = await waitForFile(join(collectionDir, 'Upload documents.yml'), (text) => text.includes('- files/boarding-pass.txt'));
  check('saved as a Bruno multipart body', file.includes('type: multipart-form') && file.includes('- files/boarding-pass.txt'), file.split('\n').slice(6, 20).join(' | '));
  check('the outside file is not in the shared file', !file.includes('passport-scan') && !file.includes(tmp) && !file.includes(tmp.replaceAll('\\', '/')));

  // 6. A missing file: nothing is sent, and the message names the field and the path.
  await fs.rename(inside, `${inside}.moved`);
  await page.keyboard.press('Control+Enter');
  const error = await page.locator('.response .error-card').innerText();
  check('a missing file stops the send, naming the field and the path', error.includes('Multipart field "documents": files/boarding-pass.txt was not found') && error.includes('Nothing was sent'), error.split('\n').join(' | '));
  await shot('03-missing-file');
  await fs.rename(`${inside}.moved`, inside);

  // 7. Reopening the request keeps the file chosen on this computer.
  await page.keyboard.press('Control+w');
  await page.locator('.doc-title', { hasText: 'Upload documents' }).waitFor({ state: 'hidden', timeout: 5000 });
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill('Upload documents');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Upload documents' }).waitFor({ timeout: 5000 });
  await page.locator('.subtab', { hasText: 'Body' }).first().click();
  check('the local file is still chosen after reopening', await page.locator('.mp-file.local', { hasText: 'passport-scan.png' }).isVisible());

  // 8. An unsupported body type: read-only notice, nothing sent, kept unchanged when the URL is edited and saved.
  await page.locator('.tree-row', { hasText: 'Query catalogue' }).click();
  await page.locator('.doc-title', { hasText: 'Query catalogue' }).waitFor({ timeout: 5000 });
  await page.locator('.tree-row', { hasText: 'Binary ticket scan' }).click();
  await page.locator('.doc-title', { hasText: 'Binary ticket scan' }).waitFor({ timeout: 5000 });
  await page.locator('.subtab', { hasText: 'Body' }).first().click();
  const unsupportedNote = page.getByText("This body type isn't editable in Yept yet", { exact: false });
  check('the binary body is shown as read-only', await unsupportedNote.isVisible());
  check('no body type is selected for it', !(await page.getByLabel('No body', { exact: true }).isChecked()));
  await shot('05-unsupported-body');
  await page.keyboard.press('Control+Enter');
  const unsupported = await page.locator('.response .error-card').innerText();
  check('sending it stops with an explanation', unsupported.includes(`Body type "file" isn't supported`) && unsupported.includes('Nothing was sent'), unsupported.split('\n').join(' | '));
  await page.getByLabel('URL', { exact: true }).fill('https://api.example.test/scan/v2');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const binaryFile = await waitForFile(binaryRequest, (text) => text.includes('scan/v2'));
  check('saving other fields keeps the body byte for byte', binaryFile.includes('url: https://api.example.test/scan/v2') && binaryFile.includes(`\n${binaryBody}\n`), binaryFile.split('\n').slice(6, 16).join(' | '));
  await page.getByLabel('JSON', { exact: true }).check();
  check('choosing another body type replaces the notice', !(await unsupportedNote.isVisible()) && (await page.locator('.monaco-host').isVisible()));

  await page.locator('.tab', { hasText: 'Query catalogue' }).click();
  await page.locator('.doc-title', { hasText: 'Query catalogue' }).waitFor({ timeout: 5000 });
  await page.locator('.subtab', { hasText: 'Body' }).first().click();
  check('the SPARQL body is shown as read-only', await unsupportedNote.isVisible());
  await page.getByLabel('URL', { exact: true }).fill('https://api.example.test/query/v2');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const sparqlFile = await waitForFile(sparqlRequest, (text) => text.includes('query/v2'));
  check('saving the URL keeps the SPARQL body byte for byte', sparqlFile.includes('query/v2') && sparqlFile.includes(sparqlBody));

  // 9. Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
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
  // A file still held open by the closing app must not fail a run whose checks passed.
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((e) => console.log(`warning: temp folder not removed: ${e.message}`));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
