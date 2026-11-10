// Source control against real local remotes: fetch/pull/Sync, drafts, branches, staging and confirmed discard.
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForFile } from './wait.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-sync-'));
const workspace = join(tmp, 'workspace');
const repo = join(workspace, 'team');
const remote = join(tmp, 'remote.git');
const other = join(tmp, 'other');
const userData = join(tmp, 'user-data');
const out = join(root, 'e2e/out');
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig') };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
const configure = (cwd) => {
  git(cwd, 'config', 'user.email', 'test@example.test'); git(cwd, 'config', 'user.name', 'Yept E2E');
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.autocrlf', 'false');
};
await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(out, { recursive: true });
git(tmp, 'init', '--bare', '-b', 'main', remote); git(workspace, 'clone', remote, repo); configure(repo);
await fs.cp(join(root, 'fixtures/collections/sample-travel'), join(repo, 'collection'), { recursive: true });
await fs.writeFile(join(repo, 'README.md'), 'team\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial'); git(repo, 'push', '-u', 'origin', 'main');
git(repo, 'branch', 'feature/local'); git(tmp, 'clone', '--no-hardlinks', remote, other); configure(other);
// A second repository proves the picker never carries selection/diffs across repositories.
const second = join(workspace, 'second'); await fs.mkdir(second);
git(second, 'init', '-b', 'main'); configure(second);
await fs.cp(join(root, 'fixtures/collections/sample-aspnet'), join(second, 'collection'), { recursive: true });
git(second, 'add', '.'); git(second, 'commit', '-m', 'second repo');
const repoLabel = await fs.realpath(repo);
const secondLabel = await fs.realpath(second);
await fs.mkdir(userData); await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: workspace }));
const checks = [];
const check = (name, ok) => { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
const app = await electron.launch({ args: [root], env: { ...env, YEPT_USER_DATA: userData }, timeout: 60000 });
const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 });
page.on('pageerror', (e) => { console.error(e); check('no renderer error', false); });
const panel = page.getByRole('complementary', { name: 'Git', exact: true });
const refresh = async () => {
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
};
const waitLog = async (text) => {
  await panel.locator('.git-log > div').first().filter({ hasText: text }).waitFor({ timeout: 60000 });
  await panel.and(page.locator('[aria-busy="false"]')).waitFor();
};
const request = join(repo, 'collection/Bookings/List bookings.yml');
const peerRequest = join(other, 'collection/Bookings/List bookings.yml');
const selectFiles = async (name) => {
  await panel.locator('.git-file.all input').uncheck();
  await panel.locator('.git-file', { hasText: name }).getByRole('checkbox').check();
};
const saveAndSelectRequest = async (query) => {
  await page.getByLabel('URL', { exact: true }).fill(`{{baseUrl}}/bookings?${query}`);
  await page.locator('.tab.active .dirty-dot').waitFor();
  await page.keyboard.press('Control+s');
  await page.locator('.tab.active .dirty-dot').waitFor({ state: 'detached' });
  const saved = await waitForFile(request, (text) => text.includes(query));
  if (!saved.includes(query)) throw new Error(`Git fixture request was not saved with ${query}`);
  await refresh();
  await selectFiles('List bookings.yml');
};
try {
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.keyboard.press('Control+k'); await page.getByPlaceholder(/Go to request/).fill('list bookings'); await page.keyboard.press('Enter');
  await page.getByLabel('URL', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Git/ }).first().click(); await panel.waitFor();
  await panel.getByLabel('Repository', { exact: true }).selectOption({ label: repoLabel });
  check('source control is a non-modal side panel', await page.getByLabel('URL', { exact: true }).isVisible());
  check('repository picker shown for multiple repositories', await panel.getByLabel('Repository', { exact: true }).isVisible());
  check('clean repository allows local branch switching', await panel.getByLabel('Branch', { exact: true }).isEnabled());

  await page.getByLabel('URL', { exact: true }).fill('{{baseUrl}}/bookings?draft=kept');
  check('unsaved request drafts block branch switching', await panel.getByLabel('Branch', { exact: true }).isDisabled());
  const original = await fs.readFile(peerRequest, 'utf8');
  await fs.writeFile(peerRequest, original.replace('/bookings', '/bookings?remote=one'));
  git(other, 'commit', '-am', 'remote one'); git(other, 'push');
  await panel.getByRole('button', { name: 'Fetch', exact: true }).click(); await waitLog('Fetched upstream');
  check('fetch updates behind count', (await panel.getByLabel('Ahead and behind').innerText()).includes('↓1'));
  await panel.getByRole('button', { name: 'Pull', exact: true }).click(); await waitLog('Pulled (fast-forward only)');
  await page.getByText('This file changed on disk while you were editing it.').waitFor({ timeout: 10000 });
  check('pull keeps dirty editor drafts', (await page.getByLabel('URL', { exact: true }).inputValue()).includes('draft=kept'));
  check('pull changes the file on disk', (await fs.readFile(request, 'utf8')).includes('remote=one'));
  await page.getByRole('button', { name: /Reload from disk/ }).click();
  check('reload resolves the editor conflict', (await page.getByLabel('URL', { exact: true }).inputValue()).includes('remote=one'));

  await fs.writeFile(peerRequest, original.replace('/bookings', '/bookings?remote=two'));
  git(other, 'commit', '-am', 'remote two'); git(other, 'push');
  await panel.getByRole('button', { name: 'Pull', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="URL"]')?.value.includes('remote=two'));
  await waitLog('Pulled (fast-forward only)');
  check('pull silently reloads clean request tabs', true);

  await saveAndSelectRequest('local=three');
  await panel.getByRole('button', { name: 'Stage selected', exact: true }).click(); await waitLog('Staged selected files');
  check('stage writes only the selected file to the index', git(repo, 'diff', '--cached', '--name-only') === 'collection/Bookings/List bookings.yml');
  await panel.getByRole('button', { name: 'Unstage selected', exact: true }).click(); await waitLog('Unstaged selected files');
  check('unstage preserves working changes', git(repo, 'diff', '--cached', '--name-only') === '' && (await fs.readFile(request, 'utf8')).includes('local=three'));
  await panel.getByRole('button', { name: 'Discard selected', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  check('cancel discard leaves files unchanged', (await fs.readFile(request, 'utf8')).includes('local=three'));
  await panel.getByRole('button', { name: 'Discard selected', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click(); await waitLog('Discarded selected changes');
  check('confirmed discard restores HEAD', (await fs.readFile(request, 'utf8')).includes('remote=two'));

  await fs.writeFile(join(repo, 'README.md'), 'outside collection\n'); await refresh();
  check('dirty files outside collections block branch switching', await panel.getByLabel('Branch', { exact: true }).isDisabled());
  git(repo, 'restore', 'README.md'); await refresh();
  await panel.getByLabel('Branch', { exact: true }).selectOption('feature/local'); await waitLog('Switched to feature/local');
  check('branch switch changes HEAD and reloads clean tabs', git(repo, 'branch', '--show-current') === 'feature/local');
  await panel.getByLabel('Branch', { exact: true }).selectOption('main'); await waitLog('Switched to main');
  await page.waitForFunction(() => document.querySelector('input[aria-label="URL"]')?.value.includes('remote=two'));

  await saveAndSelectRequest('sync=yes');
  await panel.getByLabel('Commit message').fill('sync from panel'); await panel.getByRole('button', { name: /^Commit 1 file/ }).click(); await waitLog('Committed 1 file');
  await panel.getByRole('button', { name: /^Sync / }).click(); await waitLog('Sync complete');
  check('Sync pushes local commits after pull', git(remote, 'log', '-1', '--format=%s', 'main') === 'sync from panel');
  check('Sync leaves ahead/behind at zero', (await panel.getByLabel('Ahead and behind').innerText()) === '↑0 ↓0');

  // A teammate renames, moves and edits the open request: after a pull the same tab follows it to the new file.
  git(other, 'pull', '-q'); await fs.mkdir(join(other, 'collection/Reports'));
  git(other, 'mv', 'collection/Bookings/List bookings.yml', 'collection/Reports/All bookings.yml');
  const movedPeer = join(other, 'collection/Reports/All bookings.yml');
  await fs.writeFile(movedPeer, (await fs.readFile(movedPeer, 'utf8')).replace('sync=yes', 'sync=renamed').replace('name: List bookings', 'name: All bookings'));
  git(other, 'commit', '-qam', 'rename bookings'); git(other, 'push', '-q');
  const tabsBefore = await page.locator('.tab').count();
  await panel.getByRole('button', { name: 'Pull', exact: true }).click(); await waitLog('Pulled (fast-forward only)');
  check('pull reports the followed rename', (await panel.locator('.git-log').first().innerText()).includes('collection/Bookings/List bookings.yml → collection/Reports/All bookings.yml'));
  await page.waitForFunction(() => document.querySelector('input[aria-label="URL"]')?.value.includes('sync=renamed'));
  check('the open tab follows the renamed request', (await page.locator('.tab').count()) === tabsBefore && await page.locator('.tab', { hasText: 'All bookings' }).isVisible()
    && (await page.locator('.doc-path, .doc-title').allInnerTexts()).join(' ').includes('All bookings'));
  await page.screenshot({ path: join(out, 'git-sync-panel.png') });
  await page.setViewportSize({ width: 900, height: 560 });
  await page.screenshot({ path: join(out, 'git-sync-small.png') });
  check('small window keeps source-control actions reachable', await panel.getByRole('button', { name: 'Stage selected', exact: true }).isVisible());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByLabel('Repository', { exact: true }).selectOption({ label: secondLabel });
  check('repository switch clears previous repository output', !(await panel.innerText()).includes('Sync complete'));
  check('no-upstream repository disables Sync', await panel.getByRole('button', { name: /^Sync / }).isDisabled());
} catch (e) {
  console.error(e); check('scenario completed', false); await page.screenshot({ path: join(out, 'git-sync-failure.png') }).catch(() => {});
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});
  // A file still held open by the closing app must not fail a run whose checks passed.
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((e) => console.log(`warning: temp folder not removed: ${e.message}`));
}
console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
