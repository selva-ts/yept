import { app, BrowserWindow, dialog, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { runSelfTests, selfTestProgress } from './self-test';
import { createHandlers } from '../../main/handlers';
import { createDesktopHost } from '../desktop';
import { bindIpc } from '../ipc';
import { windowColours, type WindowColours } from '@yept/core/shared/appearance';

const headlessSelfTest = process.argv.includes('--self-test');
// Automated tests run against an isolated profile so they never touch the user's settings or history.
const isolatedData = process.env.YEPT_USER_DATA;
if (isolatedData) app.setPath('userData', isolatedData);
else {
  const appData = app.getPath('appData');
  // Earlier releases kept their data under the previous name "getnect" (and pre-releases under "vela");
  // copy the newest one once so settings, secrets and history carry over. The old folder is left untouched.
  const oldProfile = ['getnect', 'vela'].map((name) => join(appData, name)).find((dir) => existsSync(dir)) ?? join(appData, 'getnect');
  const newProfile = join(appData, 'yept');
  if (!existsSync(newProfile) && existsSync(oldProfile)) {
    const staging = join(appData, `yept-migration-${process.pid}`);
    try {
      cpSync(oldProfile, staging, { recursive: true, errorOnExist: true, force: false });
      renameSync(staging, newProfile);
    } catch {
      // Keep using the existing profile if copying fails; no local settings or secrets are discarded.
      app.setPath('userData', oldProfile);
    }
  }
  if (app.getPath('userData') !== oldProfile) {
    mkdirSync(newProfile, { recursive: true });
    app.setPath('userData', newProfile);
  }
}
// A self-test that fails before it can report still leaves its error in the results file and on stderr.
if (headlessSelfTest) {
  selfTestProgress('main process loaded');
  process.on('exit', (code) => selfTestProgress(`exit ${code}`));
  const failed = (e: unknown): void => {
    const text = `FAIL start-up: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
    selfTestProgress(text);
    console.error(text);
    try {
      writeFileSync(join(app.getPath('userData'), 'selftest.txt'), text + '\n');
    } catch {
      // The error is on stderr.
    }
    app.exit(1);
  };
  process.on('uncaughtException', failed);
  process.on('unhandledRejection', failed);
}
let mainWindow: BrowserWindow | null = null;
const isMac = process.platform === 'darwin';

// The window draws its own themed title bar (renderer `.titlebar`); Windows keeps the caption buttons,
// overlaid in the theme colours. macOS keeps its traffic lights on the left, centred in the bar. The colours come
// from the chosen theme (shared/appearance.ts), in step with .titlebar and --panel / --ink in styles.css.
// One pixel shorter than the bar so its bottom border runs under the caption buttons.
const TITLEBAR_HEIGHT = 35;
const titleBarColours = (): WindowColours => windowColours(ipc.settings().palette, nativeTheme.shouldUseDarkColors);

/** Follows a light/dark switch (Windows or the app setting) and a theme change. */
function applyWindowColours(): void {
  const { color, symbolColor, background } = titleBarColours();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isMac) win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
    win.setBackgroundColor(background);
  }
}

// Windows: no visible menu bar; every action lives in the app. The menu stays installed, hidden, so the usual
// editing and zoom shortcuts keep working. macOS always shows the menu bar, so it also gets the standard app
// menu (About, Hide, Quit) and Window menu. There is deliberately no Reload: it would drop unsaved drafts.
function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        // Ctrl+= (no Shift) on most keyboards; the zoomIn role only listens for Ctrl+Plus.
        { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions])
      ]
    },
    ...(isMac ? [{ role: 'windowMenu' } as MenuItemConstructorOptions] : [])
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const colours = titleBarColours();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    title: 'Yept',
    icon: app.isPackaged ? join(process.resourcesPath, 'yept-icon.png') : join(app.getAppPath(), 'build', 'yept-icon.png'),
    backgroundColor: colours.background,
    titleBarStyle: 'hidden',
    // On macOS this only turns on the titlebar-area-* CSS values (used to clear the traffic lights).
    titleBarOverlay: { color: colours.color, symbolColor: colours.symbolColor, height: TITLEBAR_HEIGHT },
    ...(isMac ? { trafficLightPosition: { x: 13, y: 11 } } : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));
  // No other Electron windows: a web link opens in the OS browser, and anything that isn't http(s) is dropped.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    host.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  // The only frames are the response HTML preview (a sandboxed srcdoc): a link or refresh in the page goes nowhere.
  mainWindow.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && e.url !== 'about:srcdoc' && e.url !== 'about:blank') e.preventDefault();
  });
  // The renderer blocks unload while tabs have unsaved edits; ask natively instead of closing silently or not at all.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Discard changes and close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'Some requests have unsaved changes.',
      detail: 'Close Yept and lose them?'
    });
    if (choice === 0) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

const host = createDesktopHost(() => mainWindow, applyWindowColours);
const ipc = createHandlers(host);
bindIpc(ipc.handlers);
if (headlessSelfTest) selfTestProgress('handlers bound');

void app.whenReady().then(async () => {
  // Headless check for CI and installer smoke tests: `Yept.exe --self-test` writes results and exits.
  if (headlessSelfTest) {
    selfTestProgress('app ready');
    const results = await runSelfTests();
    const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms} ms): ${r.detail}`);
    console.log(lines.join('\n'));
    writeFileSync(join(app.getPath('userData'), 'selftest.txt'), lines.join('\n') + '\n');
    selfTestProgress('results written');
    app.exit(results.every((r) => r.ok) ? 0 : 1);
    return;
  }
  nativeTheme.themeSource = ipc.settings().theme;
  installMenu();
  nativeTheme.on('updated', applyWindowColours);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
