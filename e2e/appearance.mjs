// End-to-end: themes (token set, window colours, Monaco), light/dark, installed fonts and code size; applied at
// once, kept across a restart, and reset to defaults.
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(join(tmpdir(), 'yept-appearance-'));
const workspace = join(temp, 'workspace');
const userData = join(temp, 'profile');
await fs.cp(join(root, 'fixtures', 'collections'), workspace, { recursive: true });
await fs.mkdir(userData);
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: workspace }));
// A hand-edited settings file with an unusable font name: it must be ignored, not injected into the page's CSS. The
// theme id is the old default's, which earlier builds saved: it moves to the current default.
await fs.writeFile(join(userData, 'settings.json'), JSON.stringify({ theme: 'light', palette: 'navy-teal', uiFont: 'Arial"; color: red', codeFontSize: 99 }));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`); };
let app;
let page;
const launch = async () => {
  app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
  page = await app.firstWindow();
  // Let prefers-color-scheme follow nativeTheme, as in the real app, instead of Playwright's emulated light scheme.
  await page.emulateMedia({ colorScheme: null });
  await page.locator('.collection-card').first().waitFor({ timeout: 15000 });
};
const bodyFont = () => page.evaluate(() => getComputedStyle(document.body).fontFamily.replace(/"/g, ''));
const quit = async () => {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(), name);
const windowBackground = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase());
const settingsFile = async () => JSON.parse(await fs.readFile(join(userData, 'settings.json'), 'utf8'));
const settings = () => page.getByRole('dialog', { name: 'Settings' });
const openSettings = async () => {
  await page.locator('.app-statusbar').getByRole('button', { name: 'Settings', exact: true }).click();
  await settings().waitFor();
};
const editorStyle = () => page.evaluate(() => {
  const lines = document.querySelector('.monaco-editor .view-lines');
  const bg = document.querySelector('.monaco-editor .monaco-editor-background');
  return { size: lines ? getComputedStyle(lines).fontSize : '', family: lines ? getComputedStyle(lines).fontFamily : '', background: bg ? getComputedStyle(bg).backgroundColor : '' };
});
// {{variable}} text colours as [r, g, b]: a resolved one in the URL, a missing one in the body editor.
const varColours = () => page.evaluate(() => {
  const rgb = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const c = getComputedStyle(el).color;
    const n = (c.match(/[\d.]+/g) ?? []).map(Number);
    return c.startsWith('color(') ? n.slice(0, 3).map((v) => Math.round(v * 255)) : n.slice(0, 3);
  };
  return { resolved: rgb('.urlbar .var-tok.var-ok'), editorMissing: rgb('.monaco-editor .view-line .mvar-missing') };
});
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const near = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 1);
// Resolved variables are the theme's accent, 80% of the way from its ink.
const primaryVar = async () => {
  const [accent, ink] = [hexRgb(await token('--accent')), hexRgb(await token('--ink'))];
  return accent.map((v, i) => Math.round(v * 0.8 + ink[i] * 0.2));
};

try {
  await launch();
  const cleaned = await settingsFile().catch(() => ({}));
  check('starts on the default Blue theme', await page.evaluate(() => document.documentElement.dataset.palette) === 'blue'
    && await token('--accent') === '#1a4fa8' && await token('--accent-soft') === '#dde6f5');
  check('an unusable font name from the settings file is ignored', !(await page.evaluate(() => document.documentElement.style.getPropertyValue('--sans'))) && !(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).includes('color'));
  check('an out-of-range code size is clamped', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--code-size').trim())) === '24px', JSON.stringify(cleaned));

  // A request body editor, to see Monaco follow the theme and fonts.
  await page.getByRole('button', { name: 'Open DummyJSON' }).click();
  await page.locator('.tree-row', { hasText: 'Login' }).click();
  await page.locator('.subtab', { hasText: 'Body' }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();

  const cursor = () => page.evaluate(() => getComputedStyle(document.querySelector('.monaco-editor') ?? document.body).getPropertyValue('--vscode-editorCursor-foreground').trim().toLowerCase());
  check('Monaco uses the Blue editor theme', await cursor() === '#1a4fa8', await cursor());
  await page.getByLabel('Environment', { exact: true }).selectOption('public');
  await page.locator('.urlbar .var-tok.var-ok').waitFor();
  await page.locator('.monaco-editor .mvar-missing').first().waitFor();
  let vars = await varColours();
  check('resolved variables are in the Blue primary colour', near(vars.resolved, await primaryVar()), JSON.stringify(vars));
  check('missing variables in the body editor keep their own colour over Monaco string colours', near(vars.editorMissing, hexRgb(await token('--bad'))), JSON.stringify(vars));

  await openSettings();
  check('Blue is listed first, Navy/Teal is still offered', (await settings().getByLabel('Theme', { exact: true }).locator('option').allInnerTexts()).slice(0, 2).join(',') === 'Blue,Navy/Teal');
  await settings().getByLabel('Theme', { exact: true }).selectOption('warm-paper');
  await page.waitForTimeout(300);
  check('Warm Paper applies at once to the page', await token('--bg') === '#f3eee4' && await page.evaluate(() => document.documentElement.dataset.palette) === 'warm-paper');
  check('Warm Paper uses serif headings', (await token('--serif')).includes('georgia'));
  check('Warm Paper colours the window behind the page and title bar', await windowBackground() === '#f3eee4', await windowBackground());
  check('Monaco follows the theme', (await editorStyle()).background === 'rgb(255, 253, 248)', (await editorStyle()).background);
  vars = await varColours();
  check('Warm Paper: variables follow its primary colour, missing ones are crimson', near(vars.resolved, await primaryVar()) && near(vars.editorMissing, hexRgb('#a8155a')), JSON.stringify(vars));

  await settings().getByLabel('Light or dark', { exact: true }).selectOption('dark');
  await page.waitForTimeout(300);
  check('dark Warm Paper', await token('--bg') === '#17150f' && await windowBackground() === '#17150f');
  await settings().getByLabel('Theme', { exact: true }).selectOption('high-contrast');
  await page.waitForTimeout(300);
  check('High Contrast dark is black and white', await token('--bg') === '#000000' && await token('--ink') === '#ffffff' && await windowBackground() === '#000000');
  check('Monaco uses the high-contrast editor theme', (await editorStyle()).background === 'rgb(0, 0, 0)', (await editorStyle()).background);
  vars = await varColours();
  check('dark High Contrast: variables follow its primary colour', near(vars.resolved, await primaryVar()), JSON.stringify(vars));

  // Fonts: a curated installed font, then a name that isn't installed.
  const uiFonts = await settings().getByLabel('Interface font', { exact: true }).locator('option').allInnerTexts();
  check('only installed curated fonts are offered', uiFonts.includes('Arial') && uiFonts.includes('Other installed font…'), uiFonts.join(', '));
  await settings().getByLabel('Interface font', { exact: true }).selectOption('Arial');
  await page.waitForTimeout(200);
  check('the interface font applies at once', (await bodyFont()).startsWith('Arial,'));
  await settings().getByLabel('Code font', { exact: true }).selectOption('(other)');
  await settings().getByLabel('Code font name').fill('No Such Font Yept');
  await settings().getByLabel('Code font name').press('Enter');
  await page.waitForTimeout(300);
  check('a font that is not installed is flagged', await settings().getByText("isn't installed on this computer").isVisible());
  check('a missing code font falls back to the default stack', (await editorStyle()).family.includes('No Such Font Yept') && (await editorStyle()).family.includes('monospace'));
  await settings().getByLabel('Code font size', { exact: true }).fill('16');
  await settings().getByLabel('Code font size', { exact: true }).press('Enter');
  await page.waitForTimeout(300);
  check('code font size applies to editors', (await editorStyle()).size === '16px', (await editorStyle()).size);
  const saved = await settingsFile();
  check('appearance is saved locally', saved.palette === 'high-contrast' && saved.theme === 'dark' && saved.uiFont === 'Arial' && saved.codeFont === 'No Such Font Yept' && saved.codeFontSize === 16, JSON.stringify(saved));
  await settings().getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Menu' }).click();
  check('menu shows the current theme and mode', await page.getByRole('menuitemradio', { name: 'High Contrast theme' }).getAttribute('aria-checked') === 'true' && await page.getByRole('menuitemradio', { name: 'Dark mode' }).getAttribute('aria-checked') === 'true');
  await page.getByRole('menuitemradio', { name: 'Navy/Teal theme' }).click();
  await page.waitForTimeout(300);
  check('theme from the menu: dark Navy/Teal', await token('--bg') === '#0d1625' && await token('--accent') === '#4bd6b0' && await windowBackground() === '#0d1625');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitemradio', { name: 'Blue theme' }).click();
  await page.waitForTimeout(300);
  check('dark Blue keeps the navy window and a light-blue accent', await token('--bg') === '#0d1625' && await token('--accent') === '#8ab4f8' && await windowBackground() === '#0d1625');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitemradio', { name: 'Warm Paper theme' }).click();
  await page.locator('.app-statusbar').getByRole('button', { name: 'Mode: Dark' }).click();
  await page.waitForTimeout(300);
  check('footer switches light/dark', await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'system' && (await page.locator('.app-statusbar').getByRole('button', { name: 'Mode: System' }).count()) === 1);
  await page.locator('.app-statusbar').getByRole('button', { name: 'Mode: System' }).click();
  await page.waitForTimeout(300);
  await quit();

  await launch();
  check('theme, mode and fonts survive a restart', await page.evaluate(() => document.documentElement.dataset.palette) === 'warm-paper'
    && await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'light' && await token('--bg') === '#f3eee4'
    && (await bodyFont()).startsWith('Arial,'));
  check('the window starts in the theme colours', await windowBackground() === '#f3eee4', await windowBackground());
  await openSettings();
  await settings().getByRole('button', { name: 'Reset appearance to defaults' }).click();
  await page.waitForTimeout(300);
  const reset = await settingsFile();
  check('reset restores the defaults', reset.palette === 'blue' && reset.theme === 'system' && reset.uiFont === '' && reset.codeFont === '' && reset.codeFontSize === 12.5
    && !(await page.evaluate(() => document.documentElement.style.getPropertyValue('--sans'))), JSON.stringify(reset));
  check('reset leaves other settings alone', reset.historyRunsPerRequest === 20 && reset.cookies === true);
} catch (e) {
  check(`scenario completed: ${e.message.split('\n')[0]}`, false);
} finally {
  if (app) await quit();
  await fs.rm(temp, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
