import { createFixtureServer } from '../../../fixtures/server/server.mjs';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDevelopmentPath = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'yept-vscode-test-'));
const server = createFixtureServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const workspace = join(profile, 'workspace');
await cp(fileURLToPath(new URL('../../../fixtures/collections/sample-travel', import.meta.url)), workspace, { recursive: true });
const environment = join(workspace, 'environments', 'local.yml');
let yaml = (await readFile(environment, 'utf8')).replace(/\r\n/g, '\n');
yaml = yaml.replace('http://localhost:4010', `http://127.0.0.1:${server.address().port}`).replace('- secret: true\n    name: clientSecret', '- name: clientSecret\n    value: sample-secret').replace('- secret: true\n    name: accessToken', '- name: accessToken\n    value: ""');
await writeFile(environment, yaml);
// The environments suite keeps the sample's secrets as secrets and enters them through the extension.
const environments = join(profile, 'environments');
await cp(fileURLToPath(new URL('../../../fixtures/collections/sample-travel', import.meta.url)), environments, { recursive: true });
const environmentsFile = join(environments, 'environments', 'local.yml');
await writeFile(environmentsFile, (await readFile(environmentsFile, 'utf8')).replace('http://localhost:4010', `http://127.0.0.1:${server.address().port}`));
// The panels suite changes and removes requests in its own copy.
const panelsWorkspace = join(profile, 'panels');
await cp(workspace, panelsWorkspace, { recursive: true });
// The history suite runs requests, seeds history and removes a request in its own copy. VS Code's proxy support slows
// a large download in the extension host to a few MB a second, so it is off here: the suite measures the panel.
const historyWorkspace = join(profile, 'history');
await cp(workspace, historyWorkspace, { recursive: true });
const historySettings = join(profile, 'history-user-data', 'User');
await mkdir(historySettings, { recursive: true });
await writeFile(join(historySettings, 'settings.json'), JSON.stringify({ 'http.proxySupport': 'off' }));
// The runner suite runs every sample collection, each pointed at the fixture server, and one that never gets an answer.
const runnerWorkspace = join(profile, 'runner');
await cp(fileURLToPath(new URL('../../../fixtures/collections', import.meta.url)), runnerWorkspace, { recursive: true });
for (const [collection, file, from] of [['sample-travel', 'local.yml', 'http://localhost:4010'], ['sample-aspnet', 'local.yml', 'https://localhost:7443'], ['dummyjson', 'public.yml', 'https://dummyjson.com']]) {
  const path = join(runnerWorkspace, collection, 'environments', file);
  await writeFile(path, (await readFile(path, 'utf8')).replace(from, `http://127.0.0.1:${server.address().port}`));
}
await mkdir(join(runnerWorkspace, 'slow', 'environments'), { recursive: true });
await writeFile(join(runnerWorkspace, 'slow', 'opencollection.yml'), 'opencollection: 1.0.0\n\ninfo:\n  name: Slow\n');
await writeFile(join(runnerWorkspace, 'slow', 'environments', 'local.yml'), `name: local\nvariables:\n  - name: baseUrl\n    value: http://127.0.0.1:${server.address().port}\n`);
await writeFile(join(runnerWorkspace, 'slow', 'Hang.yml'), 'info:\n  name: Hang\n  type: http\n  seq: 1\n\nhttp:\n  method: GET\n  url: "{{baseUrl}}/hang"\n\nsettings:\n  encodeUrl: true\n  timeout: 0\n  followRedirects: true\n  maxRedirects: 5\n  forwardAuthorizationHeader: false\n');
// The import and export suite imports into its own folder, which starts with one sample collection.
const importWorkspace = join(profile, 'import');
await mkdir(importWorkspace);
await cp(workspace, join(importWorkspace, 'Travel'), { recursive: true });
// The leak check suite writes and removes leaky requests in its own copy, and makes its Git repositories in the profile.
const leaksWorkspace = join(profile, 'leaks');
await cp(workspace, leaksWorkspace, { recursive: true });
const actionsWorkspace = join(profile, 'actions');
await mkdir(actionsWorkspace);
await cp(workspace, join(actionsWorkspace, 'Writable'), { recursive: true });
await cp(workspace, join(actionsWorkspace, 'Other'), { recursive: true });
const readOnly = join(actionsWorkspace, 'ReadOnly');
await mkdir(readOnly);
await writeFile(join(readOnly, 'bruno.json'), JSON.stringify({ version: '1', name: 'ReadOnly', type: 'collection' }));
await writeFile(join(readOnly, 'Example.bru'), 'meta {\n  name: Example\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://api.example.test/ping\n  body: none\n  auth: none\n}\n');
// The trust suite runs with Workspace Trust on, leaving its copy of the workspace untrusted.
const untrusted = join(profile, 'untrusted');
await cp(workspace, untrusted, { recursive: true });
const trustSettings = join(profile, 'trust-user-data', 'User');
await mkdir(trustSettings, { recursive: true });
await writeFile(join(trustSettings, 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never', 'security.workspace.trust.emptyWindow': false }));
const second = join(profile, 'second');
const added = join(profile, 'added');
const empty = join(profile, 'empty');
await mkdir(empty);
await cp(workspace, second, { recursive: true });
await cp(workspace, added, { recursive: true });
const workspaceFile = join(profile, 'multi.code-workspace');
await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace, name: 'First' }, { path: second, name: 'Second' }] }));
const bare = join(profile, 'remote.git');
const clone = join(profile, 'clone');
const git = (cwd, ...args) => {
  let result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && /permission denied/i.test(result.stderr)) {
    console.error('Git first run failed:', result.stderr);
    result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    console.error('Git retry:', result.status === 0 ? 'passed' : result.stderr);
  }
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
};
git(profile, 'init', '--bare', bare);
git(added, 'init', '-b', 'main');
git(added, 'config', 'user.name', 'Synthetic Test');
git(added, 'config', 'user.email', 'test@api.example.test');
git(added, 'add', '.');
git(added, 'commit', '-m', 'Initial synthetic collection');
git(added, 'remote', 'add', 'origin', bare);
git(added, 'push', '-u', 'origin', 'main');
git(profile, 'clone', '-b', 'main', bare, clone);
git(clone, 'config', 'user.name', 'Synthetic Test');
git(clone, 'config', 'user.email', 'test@api.example.test');
try {
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/index.cjs', import.meta.url)),
    launchArgs: [
      workspace,
      '--disable-workspace-trust',
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--user-data-dir', join(profile, 'user-data'),
      '--extensions-dir', join(profile, 'extensions')
    ]
  });
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/environments.cjs', import.meta.url)),
    launchArgs: [environments, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'environments-user-data'), '--extensions-dir', join(profile, 'environments-extensions')]
  });
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/panels.cjs', import.meta.url)),
    launchArgs: [panelsWorkspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'panels-user-data'), '--extensions-dir', join(profile, 'panels-extensions')]
  });
  // runTests always adds --disable-workspace-trust, so this suite starts the same VS Code build without it.
  const executable = await downloadAndUnzipVSCode({ version: '1.144.0', cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)) });
  const trustExit = await new Promise((done) => spawn(executable, [untrusted, '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates',
    '--skip-welcome', '--skip-release-notes', '--no-cached-data', '--disable-extensions',
    `--extensionTestsPath=${fileURLToPath(new URL('../out/test/suite/trust.cjs', import.meta.url))}`, `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    '--user-data-dir', join(profile, 'trust-user-data'), '--extensions-dir', join(profile, 'trust-extensions')], { stdio: 'inherit' }).on('exit', done));
  if (trustExit !== 0) throw new Error(`Trust checks failed (exit ${trustExit})`);
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/tree.cjs', import.meta.url)),
    extensionTestsEnv: { YEPT_TEST_ADDED: added, YEPT_TEST_CLONE: clone, YEPT_TEST_EMPTY: empty },
    launchArgs: [workspaceFile, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'tree-user-data'), '--extensions-dir', join(profile, 'tree-extensions')]
  });
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/tree-actions.cjs', import.meta.url)),
    launchArgs: [actionsWorkspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'actions-user-data'), '--extensions-dir', join(profile, 'actions-extensions')]
  });
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/history.cjs', import.meta.url)),
    launchArgs: [historyWorkspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'history-user-data'), '--extensions-dir', join(profile, 'history-extensions')]
  });
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/runner.cjs', import.meta.url)),
    launchArgs: [runnerWorkspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'runner-user-data'), '--extensions-dir', join(profile, 'runner-extensions')]
  });
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/import-export.cjs', import.meta.url)),
    extensionTestsEnv: { YEPT_TEST_FIXTURES: fileURLToPath(new URL('../../../fixtures/import', import.meta.url)) },
    launchArgs: [importWorkspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'import-user-data'), '--extensions-dir', join(profile, 'import-extensions')]
  });
  await runTests({
    version: '1.144.0',
    cachePath: fileURLToPath(new URL('../.vscode-test', import.meta.url)),
    extensionDevelopmentPath,
    extensionTestsPath: fileURLToPath(new URL('../out/test/suite/leaks.cjs', import.meta.url)),
    extensionTestsEnv: { YEPT_TEST_REPOS: join(profile, 'leak-repos') },
    launchArgs: [leaksWorkspace, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--user-data-dir', join(profile, 'leaks-user-data'), '--extensions-dir', join(profile, 'leaks-extensions')]
  });
} finally {
  server.closeAllConnections(); server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
