// Times request panel opens in VS Code: launches it several times with one profile and the sample collection, and
// prints the median and range per kind of open. With --vsix, measures that package installed instead of this folder.
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values: args } = parseArgs({ options: { vsix: { type: 'string' }, launches: { type: 'string', default: '5' }, tree: { type: 'boolean' } } });
const version = '1.144.0';
const cachePath = fileURLToPath(new URL('../.vscode-test', import.meta.url));
const suiteName = args.tree ? 'tree-measure.cjs' : 'measure.cjs';
const suite = fileURLToPath(new URL(`../out/test/suite/${suiteName}`, import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'yept-vscode-measure-'));
const workspace = join(profile, 'workspace');
await cp(fileURLToPath(new URL('../../../fixtures/collections/sample-travel', import.meta.url)), workspace, { recursive: true });
try {
  let extension = fileURLToPath(new URL('../', import.meta.url));
  if (args.vsix) {
    // Installing unpacks the package; it then loads from there, with the measuring suite copied in beside it.
    const installed = join(profile, 'installed');
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(await downloadAndUnzipVSCode({ version, cachePath }));
    const result = spawnSync(cli, [...cliArgs, '--extensions-dir', installed, '--install-extension', args.vsix], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error(`Could not install the package: ${result.stderr || result.stdout}`);
    const folder = (await readdir(installed, { withFileTypes: true })).find((e) => e.isDirectory() && e.name.includes('yept-vscode'));
    if (!folder) throw new Error('The installed package was not found');
    extension = join(installed, folder.name);
    await mkdir(join(extension, 'out/test/suite'), { recursive: true });
    await copyFile(suite, join(extension, 'out/test/suite', suiteName));
  }
  const runs = [];
  let requestId = '';
  for (let launch = 0; launch < Number(args.launches); launch++) {
    const out = join(profile, `launch-${launch}.json`);
    await runTests({
      version,
      cachePath,
      extensionDevelopmentPath: extension,
      extensionTestsPath: join(extension, 'out/test/suite', suiteName),
      extensionTestsEnv: { YEPT_MEASURE_OUT: out, YEPT_MEASURE_REQUEST: requestId },
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
    const run = JSON.parse(await readFile(out, 'utf8'));
    if (args.tree) runs.push(run.tree);
    else { requestId = run.requestId; runs.push(...run.samples); }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const summary = (values) => `${Math.round(median(values))} (${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))})`;
  if (args.tree) {
    console.log(`\nOpening the view to its first tree items, ms: median (range) ${summary(runs)}; samples: ${runs.map((n) => Math.round(n)).join(', ')}`);
  } else {
  console.log('\nOpen to usable and to first editor, in ms: median (range)');
  console.log('kind         n   command        usable           editor');
  for (const kind of ['new profile', 'first', 'new panel']) {
    const samples = runs.filter((s) => s.kind === kind);
    if (!samples.length) continue;
    console.log(`${kind.padEnd(11)} ${String(samples.length).padStart(2)}   ${summary(samples.map((s) => s.command)).padEnd(14)} ${summary(samples.map((s) => s.usable)).padEnd(16)} ${summary(samples.map((s) => s.editor))}`);
  }
  console.log('\nSamples:', JSON.stringify(runs));
  }
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
