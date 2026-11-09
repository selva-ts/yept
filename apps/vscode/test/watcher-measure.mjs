// Compare chokidar scope on a synthetic repository; no workspace files are used.
import { watch } from 'chokidar';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'yept-watch-measure-'));
try {
  const source = join(root, 'source');
  await mkdir(source);
  for (let directory = 0; directory < 100; directory++) {
    const folder = join(source, String(directory));
    await mkdir(folder);
    await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(join(folder, `${i}.txt`), 'synthetic')));
  }
  const collection = join(root, 'collections', 'sample-travel');
  await cp(fileURLToPath(new URL('../../../fixtures/collections/sample-travel', import.meta.url)), collection, { recursive: true });
  for (const [name, paths] of [['whole workspace', [root]], ['collection only', [collection]]]) {
    global.gc?.();
    const memory = process.memoryUsage().rss;
    const start = performance.now();
    const watcher = watch(paths, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    await new Promise((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
    const directories = watcher.getWatched();
    const entries = Object.values(directories).reduce((sum, files) => sum + files.length, 0);
    console.log(`${name}: ready ${(performance.now() - start).toFixed(0)} ms, ${Object.keys(directories).length} directories, ${entries} entries, RSS delta ${((process.memoryUsage().rss - memory) / 1024 / 1024).toFixed(1)} MiB`);
    await watcher.close();
  }
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
