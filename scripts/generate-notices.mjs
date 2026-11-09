// Build an offline notice inventory from the exact installed dependency tree.
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectInventory, renderNotices, repositoryRoot } from './license-inventory.mjs';

const inventory = await collectInventory();
await mkdir(resolve(repositoryRoot, 'build'), { recursive: true });
await writeFile(resolve(repositoryRoot, 'build/THIRD_PARTY_NOTICES.txt'), renderNotices(inventory));
const standard = inventory.entries.filter((e) => e.provenance === 'declared-standard').length;
console.log(`Wrote notices for ${inventory.entries.length} installed package instances; ${standard} use explicitly reviewed standard terms. Skipped ${inventory.skipped.length} absent optional packages.`);
