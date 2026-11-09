// End-to-end: Git panel (diff, commit selected files only, push, rejected push), leak check before commit,
// import (Postman with secrets, Insomnia duplicates, OpenAPI), .bru -> YAML conversion, and single-file export.
// Usage: npm run build && node e2e/git-import.mjs   (screenshots go to e2e/out/)
import { _electron as electron } from 'playwright';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForFile } from './wait.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e', 'out');
await fs.mkdir(out, { recursive: true });
const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-e2e-'));
const remote = join(tmp, 'remote.git');
const repo = join(tmp, 'repo');
const userData = join(tmp, 'user-data');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const configure = (cwd) => {
  git(cwd, 'config', 'user.email', 'e2e@example.test');
  git(cwd, 'config', 'user.name', 'Yept E2E');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'core.autocrlf', 'false');
};

// A repository with the fixture collections under api/, pushed to a bare remote.
git(tmp, 'init', '--bare', '-b', 'main', remote);
git(tmp, 'clone', remote, repo);
configure(repo);
await fs.cp(join(root, 'fixtures', 'collections'), join(repo, 'api'), { recursive: true });
await fs.writeFile(join(repo, 'README.md'), 'team collections\n');
git(repo, 'add', '.');
git(repo, 'commit', '-m', 'init');
git(repo, 'push', '-u', 'origin', 'main');
// Something the user staged with another tool: Yept must leave it staged.
await fs.writeFile(join(repo, 'README.md'), 'staged elsewhere\n');
git(repo, 'add', 'README.md');

await fs.mkdir(userData, { recursive: true });
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: repo }));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1440, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `git-${name}.png`) });
const openByPalette = async (query, title) => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Go to request/).fill(query);
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: title }).waitFor();
};
const gitDlg = () => page.getByRole('complementary', { name: 'Git', exact: true });
const openGit = async () => {
  await page.getByRole('button', { name: /^Git/ }).first().click();
  await gitDlg().waitFor();
  await page.waitForTimeout(500);
};
const closeGit = () => gitDlg().getByRole('button', { name: 'Close Git panel' }).click();
const stubOpen = (file) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
const stubSave = (file) => app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, file);

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();

  // 1. Edit and save a request; the Git button counts it.
  await openByPalette('list bookings', 'List bookings');
  await page.getByLabel('URL', { exact: true }).fill('{{baseUrl}}/bookings?status=open');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  await page.locator('.git-count', { hasText: '1' }).waitFor({ timeout: 5000 });
  check('Git button counts the changed file', true);

  // 2. Git panel: diff, commit only that file; the README the user staged elsewhere stays staged.
  await openGit();
  await gitDlg().locator('.git-file', { hasText: 'List bookings.yml' }).click();
  await gitDlg().locator('.git-diff .monaco-diff-editor').waitFor();
  await page.waitForTimeout(500);
  check('diff of the changed file is shown', (await gitDlg().locator('.git-diff').innerText()).includes('status=open'));
  await shot('01-git-diff');
  await gitDlg().getByLabel('Commit message').fill('Open bookings only');
  await gitDlg().getByRole('button', { name: /^Commit 1 file/ }).click();
  await gitDlg().locator('.git-log .ok', { hasText: 'Committed 1 file' }).waitFor({ timeout: 10000 });
  check('commit reported with its hash', /as [0-9a-f]{7}/.test(await gitDlg().locator('.git-log').innerText()));
  check('only the selected file was committed', git(repo, 'show', '--name-only', '--format=', 'HEAD') === 'api/sample-travel/Bookings/List bookings.yml');
  check('other staged changes stay staged', git(repo, 'diff', '--cached', '--name-only') === 'README.md');

  // 3. Push.
  await gitDlg().getByRole('button', { name: /^Push/ }).click();
  await gitDlg().locator('.git-log .ok', { hasText: 'Pushed main to origin/main' }).waitFor({ timeout: 15000 });
  check('push reaches the remote', git(remote, 'log', '-1', '--format=%s', 'main') === 'Open bookings only');

  // 4. Rejected push: someone else pushed first.
  const other = join(tmp, 'other');
  git(tmp, 'clone', remote, other);
  configure(other);
  await fs.writeFile(join(other, 'NOTES.md'), 'theirs\n');
  git(other, 'add', 'NOTES.md');
  git(other, 'commit', '-m', 'theirs');
  git(other, 'push');
  await closeGit();
  await openByPalette('travel login', 'Login');
  await page.getByLabel('URL', { exact: true }).fill('{{baseUrl}}/auth/v2/token');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(600);
  await openGit();
  await gitDlg().getByLabel('Commit message').fill('Login v2');
  await gitDlg().getByRole('button', { name: /^Commit 1 file/ }).click();
  await gitDlg().locator('.git-log .ok', { hasText: 'Committed 1 file' }).waitFor({ timeout: 10000 });
  await gitDlg().getByRole('button', { name: /^Push/ }).click();
  await gitDlg().locator('.git-log .bad').first().waitFor({ timeout: 15000 });
  const logText = await gitDlg().locator('.git-log').innerText();
  check('rejected push explained in plain words', logText.includes("The remote has commits you don't have yet"));
  check('Git\'s own output is shown', /rejected/.test(logText));
  check('remote not overwritten', git(remote, 'log', '-1', '--format=%s', 'main') === 'theirs');
  await shot('02-git-rejected');
  await closeGit();

  // 5. Leak check: a literal JWT saved into a request blocks the commit.
  // Assembled at runtime so secret scanners don't flag this synthetic value.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2lnbmF0dXJlLXZhbHVlLXRlc3Q'].join('.');
  const leaky = join(repo, 'api', 'sample-travel', 'Leaky.yml');
  await fs.writeFile(leaky, `info:\n  name: Leaky\n  type: http\n  seq: 9\n\nhttp:\n  method: GET\n  url: "{{baseUrl}}/x"\n  auth:\n    type: bearer\n    token: ${jwt}\n`);
  await page.locator('.tree-row', { hasText: 'Leaky' }).waitFor({ timeout: 8000 });
  await openGit();
  await gitDlg().locator('.git-file', { hasText: 'Leaky.yml' }).locator('input').check();
  await gitDlg().getByLabel('Commit message').fill('Add leaky');
  await gitDlg().getByRole('button', { name: /^Commit/ }).click();
  await gitDlg().getByText('Commit blocked: this looks like a secret').waitFor({ timeout: 8000 });
  const leakText = await gitDlg().locator('.leak-pane').innerText();
  check('leak check blocks the commit and names the line', leakText.includes('Leaky.yml:11') && leakText.includes('JSON Web Token'));
  check('the token is masked in the finding', !leakText.includes(jwt));
  await shot('03-leak-blocked');
  check('nothing was committed', git(repo, 'log', '-1', '--format=%s') === 'Login v2');
  await gitDlg().getByLabel('Type the file name to commit anyway').fill('Leaky.yml');
  await gitDlg().getByRole('button', { name: 'Commit anyway' }).click();
  await gitDlg().locator('.git-log .ok', { hasText: 'leak check overridden' }).waitFor({ timeout: 10000 });
  check('commit anyway works after typing the file name', git(repo, 'log', '-1', '--format=%s') === 'Add leaky');
  await closeGit();

  // 6. Import a Postman collection with a literal token: the wizard offers to move it to a secret.
  const pm = JSON.parse(readFileSync(join(root, 'fixtures', 'import', 'postman-sample.postman_collection.json'), 'utf8'));
  pm.item[1].item[0].request.auth = { type: 'bearer', bearer: [{ key: 'token', value: jwt }] };
  const pmFile = join(tmp, 'travel.postman_collection.json');
  await fs.writeFile(pmFile, JSON.stringify(pm));
  await stubOpen(pmFile);
  await page.getByRole('button', { name: 'Import…' }).click();
  const imp = page.getByRole('dialog', { name: 'Import collection' });
  await imp.waitFor();
  check('import preview shows format and counts', (await imp.innerText()).includes('Postman collection · 3 requests'));
  check('literal token found and offered as a secret', (await imp.innerText()).includes('bearer token') && !(await imp.innerText()).includes(jwt));
  await shot('04-import-preview');
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.tree-row.collection', { hasText: 'Sample Postman Travel' }).waitFor({ timeout: 8000 });
  const listFile = readFileSync(join(repo, 'Sample Postman Travel', 'Bookings', 'List bookings.yml'), 'utf8');
  check('imported request refers to a variable, not the token', listFile.includes('{{accessToken}}') && !listFile.includes(jwt));
  const envFiles = existsSync(join(repo, 'Sample Postman Travel', 'environments')) ? await fs.readdir(join(repo, 'Sample Postman Travel', 'environments')) : [];
  check('a secret variable was declared in an environment', envFiles.length > 0 && readFileSync(join(repo, 'Sample Postman Travel', 'environments', envFiles[0]), 'utf8').includes('secret: true'));

  // 7. Insomnia: duplicates removed. OpenAPI: path params.
  await stubOpen(join(root, 'fixtures', 'import', 'insomnia-sample.json'));
  await page.getByRole('button', { name: 'Import…' }).click();
  await imp.waitFor();
  check('Insomnia duplicates removed and reported', (await imp.innerText()).includes('Removed 1 duplicate request'));
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.tree-row.collection', { hasText: 'Sample Insomnia Travel' }).waitFor({ timeout: 8000 });
  await stubOpen(join(root, 'fixtures', 'import', 'openapi-sample.yaml'));
  await page.getByRole('button', { name: 'Import…' }).click();
  await imp.waitFor();
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.tree-row.collection', { hasText: 'Sample Bookings API' }).waitFor({ timeout: 8000 });
  check('OpenAPI import adds a collection', true);

  // 8. Convert a .bru collection to YAML.
  const bru = join(repo, 'legacy');
  await fs.mkdir(join(bru, 'environments'), { recursive: true });
  await fs.writeFile(join(bru, 'bruno.json'), JSON.stringify({ version: '1', name: 'Legacy', type: 'collection' }));
  await fs.writeFile(join(bru, 'Ping.bru'), 'meta {\n  name: Ping\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{baseUrl}}/ping\n  body: none\n  auth: none\n}\n');
  await fs.writeFile(join(bru, 'environments', 'dev.bru'), 'vars {\n  baseUrl: http://localhost:5000\n}\n');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'Open Legacy' }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Open Legacy' }).click();
  await page.locator('.tree-row.collection', { hasText: 'Legacy' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Convert to YAML…' }).click();
  const conv = page.getByRole('dialog', { name: 'Convert to YAML' });
  await conv.waitFor();
  await conv.getByRole('button', { name: 'Convert', exact: true }).click();
  await page.locator('.tree-row.collection', { hasText: 'Legacy (YAML)' }).waitFor({ timeout: 8000 });
  check('.bru collection converted to an editable YAML collection', existsSync(join(repo, 'Legacy (YAML)', 'opencollection.yml')) && existsSync(join(bru, 'Ping.bru')));

  // 9. Export the travel collection as one file.
  const exportFile = join(tmp, 'travel-export.yml');
  await stubSave(exportFile);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Export as single file…' }).click();
  await page.getByRole('button', { name: 'With environments' }).click();
  const exported = await waitForFile(exportFile, (text) => text.includes('environments'));
  check('single-file export written', exported.includes('bundled: true') && exported.includes('List bookings') && exported.includes('environments'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await openGit();
  await shot('05-git-dark');
  await closeGit();
} catch (e) {
  check('scenario completed', false, e.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
