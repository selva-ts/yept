import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'yept-ui-review-'));
const workspace = join(directory, 'workspace');
await cp(fileURLToPath(new URL('../../../fixtures/collections/sample-travel', import.meta.url)), workspace, { recursive: true });
await mkdir(join(directory, 'user-data', 'User'), { recursive: true });
await writeFile(join(directory, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Default Dark Modern', 'window.title': 'Yept UI review', 'chat.disableAIFeatures': true, 'window.commandCenter': false, 'workbench.startupEditor': 'none' }));
console.log(`REVIEW_DIRECTORY=${directory}`);
try {
  await runTests({ version: '1.144.0', cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath: fileURLToPath(new URL('../', import.meta.url)),
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/review.cjs', import.meta.url)),
    extensionTestsEnv: { YEPT_REVIEW_DIR: directory },
    launchArgs: [workspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--user-data-dir', join(directory, 'user-data'), '--extensions-dir', join(directory, 'extensions')]
  });
} finally {
  // Remove the profile and synthetic workspace; anything a reviewer saved in the review directory stays.
  for (const name of ['user-data', 'extensions', 'workspace']) await rm(join(directory, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
