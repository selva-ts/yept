import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write';

const busy = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe('atomicWrite', () => {
  let dir = '';
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('retries while another process briefly holds the file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yept-atomic-'));
    const file = join(dir, 'Echo test.yml');
    await fs.writeFile(file, 'old');
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename')
      .mockRejectedValueOnce(busy('EPERM'))
      .mockRejectedValueOnce(busy('EBUSY'))
      .mockImplementation(rename);
    await atomicWrite(file, 'new');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['Echo test.yml']);
  });

  it('gives up on other errors at once and removes the temp file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yept-atomic-'));
    const file = join(dir, 'Echo test.yml');
    await fs.writeFile(file, 'old');
    const spy = vi.spyOn(fs, 'rename').mockRejectedValue(busy('ENOSPC'));
    await expect(atomicWrite(file, 'new')).rejects.toThrow('ENOSPC');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['Echo test.yml']);
  });
});
