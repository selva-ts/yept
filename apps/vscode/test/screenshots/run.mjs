// Captures the store screenshots in apps/vscode/images. Windows only; run after `npm run build`:
//   node apps/vscode/test/screenshots/run.mjs <output-folder> [<x,y of the runner's Run button>]
// Without the button's place it captures the runner page (runner-before.png) so the place can be read from it.
// It uses the cached VS Code test build, a throwaway profile, the synthetic sample collection and the local fixture
// server, and briefly brings the window to the front to click Run.
import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from '../../../../fixtures/server/server.mjs';

const [output, runButton = ''] = process.argv.slice(2);
if (!output) throw new Error('Usage: node run.mjs <output-folder> [<x,y>]');
const extension = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(resolve(output), { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'yept-shots-'));
const server = createFixtureServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const workspace = join(profile, 'api-workspace');
await cp(fileURLToPath(new URL('../../../../fixtures/collections/sample-travel', import.meta.url)), join(workspace, 'sample-travel'), { recursive: true });
const environment = join(workspace, 'sample-travel', 'environments', 'local.yml');
await writeFile(environment, (await readFile(environment, 'utf8')).replace('http://localhost:4010', `http://localhost:${server.address().port}`));
await mkdir(join(profile, 'user-data', 'User'), { recursive: true });
await writeFile(join(profile, 'user-data', 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': 'Default Dark Modern', 'window.title': 'Yept screenshots', 'chat.disableAIFeatures': true,
  'window.commandCenter': false, 'workbench.startupEditor': 'none', 'editor.minimap.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.layoutControl.enabled': false,
  'workbench.tips.enabled': false, 'http.proxySupport': 'off'
}));
try {
  await runTests({
    version: '1.144.0',
    cachePath: join(extension, '.vscode-test'),
    extensionDevelopmentPath: extension,
    extensionTestsPath: fileURLToPath(new URL('./suite.cjs', import.meta.url)),
    extensionTestsEnv: { YEPT_SHOTS_OUT: resolve(output), YEPT_SHOTS_RUN_BUTTON: runButton },
    launchArgs: [workspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates',
      '--user-data-dir', join(profile, 'user-data'), '--extensions-dir', join(profile, 'extensions')]
  });
} finally {
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
