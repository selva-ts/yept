import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const TEMP_PREFIX = '.yept-tmp-';

/** Write to a temp file in the same folder, then rename over the target, so readers never see half a file. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `${TEMP_PREFIX}${randomBytes(6).toString('hex')}-${basename(path)}`);
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
