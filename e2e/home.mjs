import { _electron as electron } from 'playwright';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'));
const temp = await fs.mkdtemp(join(tmpdir(), 'yept-home-'));
const workspace = join(temp, 'workspace');
const userData = join(temp, 'profile');
await fs.cp(join(root, 'fixtures', 'collections'), workspace, { recursive: true });
await fs.mkdir(userData);
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: workspace }));
const results = [];
const check = (name, ok) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
let app;
let page;
const launch = async () => {
  app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
  page = await app.firstWindow();
  // Wait for the restored tiles: the heading also shows on the empty state while the workspace loads.
  await page.locator('.collection-card').first().waitFor({ timeout: 15000 });
};
const quit = async () => {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};

try {
  await launch();
  check('Home shows the restored collections', await page.locator('.collection-card').count() === 3);
  const positions = () => page.evaluate(() => [...document.querySelectorAll('.view-toggle button'), document.querySelector('.collection-symbol')].map((el) => Math.round(el.getBoundingClientRect().x)).join(','));
  const gridPositions = await positions();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  check('list view changes the collection layout', await page.locator('.collection-browser.list').isVisible());
  check('toggle buttons and tile icons keep their place', await positions() === gridPositions, `${gridPositions} → ${await positions()}`);
  // A window just tall enough for the grid: the longer list then scrolls, and its scrollbar must not shift anything.
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  const fit = await page.evaluate(() => { const home = document.querySelector('.home'); return { width: window.innerWidth, height: document.querySelector('.home-content').offsetHeight + window.innerHeight - home.clientHeight }; });
  await page.setViewportSize(fit);
  await page.waitForTimeout(150);
  const fittedGrid = await positions();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.waitForTimeout(150);
  const listScrolls = await page.evaluate(() => { const home = document.querySelector('.home'); return home.scrollHeight > home.clientHeight; });
  check('Grid ↔ List moves nothing sideways when only the list scrolls', listScrolls && await positions() === fittedGrid, `${listScrolls} ${fittedGrid} → ${await positions()}`);
  await quit();

  await launch();
  check('list preference survives restart', await page.locator('.collection-browser.list').isVisible());
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  check('opening a tile focuses one collection', await page.locator('.tree-row.collection').count() === 1);
  await page.locator('.tree-row', { hasText: 'List bookings' }).click();
  await page.getByLabel('URL', { exact: true }).fill('{{baseUrl}}/bookings?draft=1');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'Open DummyJSON' }).click();
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.locator('.tab', { hasText: 'List bookings' }).click();
  check('draft survives collection switching', (await page.getByLabel('URL', { exact: true }).inputValue()).includes('draft=1'));
  check('{{variables}} in the URL are highlighted', await page.locator('.urlbar .var-layer .var-tok', { hasText: '{{baseUrl}}' }).count() === 1);
  await page.getByLabel('URL', { exact: true }).fill(`{{baseUrl}}/bookings?draft=1&${'long_parameter=value&'.repeat(40)}`);
  await page.getByLabel('URL', { exact: true }).press('End');
  check('a long URL does not widen the editor or hide Send', await page.evaluate(() => {
    const section = document.querySelector('.editor-section');
    const send = [...document.querySelectorAll('.urlbar button')].find((b) => b.textContent?.trim() === 'Send');
    return !!section && !!send && section.scrollWidth <= section.clientWidth + 1 && send.getBoundingClientRect().right <= section.getBoundingClientRect().right;
  }));
  await page.getByLabel('URL', { exact: true }).fill('{{baseUrl}}/bookings?draft=1');

  // Sidebar tree: connectors, keyboard and remembered expand state.
  check('requests sit inside their folder group', await page.locator('.tree-children .tree-children .tree-row', { hasText: 'List bookings' }).count() === 1);
  await page.locator('.tree-row.folder', { hasText: 'Auth' }).click();
  check('collapsing a folder hides its requests', await page.locator('.tree-row', { hasText: 'Login' }).count() === 0);
  await page.locator('.tree-row.folder', { hasText: 'Auth' }).focus();
  await page.keyboard.press('ArrowRight');
  check('ArrowRight expands a folder', await page.locator('.tree-row', { hasText: 'Login' }).count() === 1);
  await page.keyboard.press('ArrowDown');
  check('ArrowDown moves to the next row', await page.evaluate(() => document.activeElement?.textContent?.includes('Login') ?? false));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft on a child returns to its folder, then collapses it', await page.locator('.tree-row', { hasText: 'Login' }).count() === 0);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  check('collapsed folders stay collapsed after going Home', await page.locator('.tree-row', { hasText: 'Login' }).count() === 0);

  // App menu, footer, theme.
  await page.getByRole('button', { name: 'Menu' }).click();
  check('menu lists workspace, theme and app items', await page.getByRole('menuitem', { name: 'Open folder…' }).isVisible() && await page.getByRole('menuitemradio', { name: 'Dark mode' }).isVisible());
  await page.keyboard.press('Escape');
  check('Escape closes the menu', await page.getByRole('menu').count() === 0);
  check('footer shows the app version', await page.locator('.app-statusbar .status-version').innerText() === `v${version}`);
  await page.locator('.app-statusbar').getByRole('button', { name: 'About', exact: true }).click();
  check('footer About opens About', await page.getByRole('dialog', { name: 'About Yept' }).isVisible());
  await page.getByRole('dialog', { name: 'About Yept' }).getByRole('button', { name: 'Close' }).click();
  await page.locator('.app-statusbar').getByRole('button', { name: 'Settings', exact: true }).click();
  check('footer Settings opens Settings', await page.getByRole('dialog', { name: 'Settings' }).waitFor({ timeout: 5000 }).then(() => true, () => false));
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark mode' }).click();
  await page.waitForTimeout(300);
  check('Dark mode applies to the window', await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'dark');
  await quit();
  await launch();
  check('theme survives restart', await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'dark' && (await page.locator('.app-statusbar').getByRole('button', { name: 'Mode: Dark' }).count()) === 1);

  await page.getByRole('button', { name: '+ New collection' }).click();
  await page.getByRole('dialog').locator('input').fill('Fresh API');
  await page.keyboard.press('Enter');
  const card = page.locator('.collection-card', { hasText: 'Fresh API' });
  await card.waitFor();
  check('New collection writes valid YAML', existsSync(join(workspace, 'Fresh API', 'opencollection.yml')));
  check('New collection stays on Home', (await page.locator('.collection-crumb').count()) === 0);

  await card.locator('.collection-more summary').click();
  check('tile menu opens', await card.locator('.collection-menu').isVisible());
  await page.locator('.home-heading h1').click();
  await page.waitForTimeout(100);
  check('tile menu closes on outside click', !(await card.locator('.collection-menu').isVisible()));

  await card.locator('.collection-more summary').click();
  await card.getByRole('button', { name: 'Move to Recycle Bin' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Recycle Bin' }).click();
  await card.waitFor({ state: 'detached' });
  check('collection moves to the Recycle Bin', !existsSync(join(workspace, 'Fresh API')));
} catch (e) {
  check(`scenario completed: ${e.message.split('\n')[0]}`, false);
} finally {
  if (app) await quit();
  await fs.rm(temp, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
