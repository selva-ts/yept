import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const TEMP_PREFIX = '.yept-tmp-';

// On Windows a rename over a file fails while another process (a file watcher, the search indexer, antivirus) has it
// open for a moment. Those errors clear quickly, so retry for a short while before giving up.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_FOR_MS = 2000;

export async function renameWithRetry(from: string, to: string): Promise<void> {
  const deadline = Date.now() + RETRY_FOR_MS;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      return await fs.rename(from, to);
    } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? '') || Date.now() + wait > deadline) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Write to a temp file in the same folder, then rename over the target, so readers never see half a file. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `${TEMP_PREFIX}${randomBytes(6).toString('hex')}-${basename(path)}`);
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await renameWithRetry(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
