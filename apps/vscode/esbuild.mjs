import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('.', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info'
});
// The pre-commit hook's checker: one file, copied next to the hook, run by whatever Node the hook finds.
await build({
  absWorkingDir: root,
  entryPoints: ['src/leak-checker.ts'],
  outfile: 'dist/yept-leak-check.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'info'
});
await build({
  absWorkingDir: root,
  entryPoints: ['../../packages/core/src/engine/sandbox/worker.mjs'],
  outfile: 'dist/worker.cjs',
  banner: { js: "const __workerFileUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__workerFileUrl' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info'
});
const require = createRequire(import.meta.url);
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await copyFile(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'), new URL('./dist/emscripten-module.wasm', import.meta.url));
await copyFile(new URL('../../build/THIRD_PARTY_NOTICES.txt', import.meta.url), new URL('./dist/THIRD_PARTY_NOTICES.txt', import.meta.url));
await copyFile(new URL('../../LICENSE', import.meta.url), new URL('./dist/LICENSE.txt', import.meta.url));
// vsce and the registries look for the licence next to package.json; the repository's root file is the one source.
await copyFile(new URL('../../LICENSE', import.meta.url), new URL('./LICENSE.txt', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['test/suite/index.ts', 'test/suite/environments.ts', 'test/suite/panels.ts', 'test/suite/trust.ts', 'test/suite/measure.ts', 'test/suite/tree.ts', 'test/suite/tree-actions.ts', 'test/suite/history.ts', 'test/suite/runner.ts', 'test/suite/import-export.ts', 'test/suite/leaks.ts', 'test/suite/tree-measure.ts', 'test/suite/review.ts'],
  outdir: 'out/test/suite',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info'
});
