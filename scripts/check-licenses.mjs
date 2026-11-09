import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { collectInventory, renderNotices, repositoryRoot, selectLicense } from './license-inventory.mjs';

const root = repositoryRoot;
const inventory = await collectInventory();
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (manifest.license !== 'MIT') throw new Error('Unexpected project licence');
const copyright = 'Copyright (c) 2026 Selva Subramaniam';
const projectLicense = await readFile(resolve(root, 'LICENSE'), 'utf8');
selectLicense('MIT', projectLicense);
const builder = load(await readFile(resolve(root, 'electron-builder.yml'), 'utf8'));
if (!projectLicense.includes(copyright) || builder.copyright !== copyright) throw new Error('Project copyright is inconsistent');
if (!builder.extraResources.some((r) => r.from === 'LICENSE' && r.to === 'LICENSE.txt')) throw new Error('Project licence is missing from packaged resources');
for (const parent of ['apps', 'packages']) {
  for (const entry of await readdir(resolve(root, parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkg = JSON.parse(await readFile(resolve(root, parent, entry.name, 'package.json'), 'utf8'));
    if (pkg.license !== 'MIT') throw new Error(`Unexpected first-party licence: ${pkg.name}`);
  }
}
if ((await readFile(resolve(root, 'build/THIRD_PARTY_NOTICES.txt'), 'utf8')) !== renderNotices(inventory)) throw new Error('Generated notices are stale or incomplete');
console.log(`Licence check passed: ${inventory.entries.length} installed package instances have permitted terms and notices.`);
