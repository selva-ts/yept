import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { collectInventory, renderNotices, selectLicense } from './license-inventory.mjs';

const mit = `MIT License
Copyright (c) 2026 Fictional Example
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const isc = `ISC License
Copyright (c) 2026 Fictional Example
Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE.`;
const zlib = `Copyright (c) 2026 Fictional Example
This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.
Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:
1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
let root, lock, sources;
beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'yept-licences-'));
  lock = { packages: { '': { name: 'fixture-app', version: '1.0.0' } } };
  sources = { version: 1, standards: {}, packages: {}, families: [], metadata: {} };
  await mkdir(resolve(root, 'build/licenses'), { recursive: true });
});
afterEach(async () => {
  expect(root.startsWith(resolve(tmpdir()) + sep)).toBe(true);
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
async function inventory() {
  await writeFile(resolve(root, 'package-lock.json'), JSON.stringify(lock));
  await writeFile(resolve(root, 'build/licenses/sources.json'), JSON.stringify(sources));
  return collectInventory({ root });
}
async function pkg(path = 'node_modules/fixture', version = '1.0.0', files = { LICENSE: mit }, license = 'MIT') {
  const dir = resolve(root, path);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: 'fixture', version, ...(license === null ? {} : { license }) }));
  for (const [name, text] of Object.entries(files)) await writeFile(resolve(dir, name), text);
  lock.packages[path] = { version, integrity: 'sha512-synthetic' };
}

it('selects a permitted OR branch with available terms and requires both sides of AND', () => {
  expect(selectLicense('(GPL-3.0-only OR MIT) AND ISC', mit + isc)).toBe('MIT AND ISC');
  expect(selectLicense('MIT OR (GPL-3.0-only AND ISC)', mit)).toBe('MIT');
  expect(() => selectLicense('MIT AND GPL-3.0-only', mit)).toThrow('No permitted licence');
  expect(() => selectLicense('MIT AND ISC', mit)).toThrow('No permitted licence');
});

it.each(['GPL-3.0-only', 'UNLICENSED', 'Unknown-License', '', 'MIT OR', '(MIT', 'MIT WITH Unknown-exception', ['MIT']])('rejects unsupported or malformed licence %s', (expression) => {
  expect(() => selectLicense(expression, mit)).toThrow();
});

it('requires an explicit review for data and custom licence identifiers', () => {
  const notice = 'This code is released into the "public domain" by its authors. Anybody may use, alter and distribute it without restriction. The author makes no guarantees and takes no liability.';
  expect(() => selectLicense('LicenseRef-tv4-public-domain', notice)).toThrow();
  expect(selectLicense('LicenseRef-tv4-public-domain', notice, ['LicenseRef-tv4-public-domain'])).toBe('LicenseRef-tv4-public-domain');
  expect(() => selectLicense('MIT', 'MIT')).toThrow('complete terms');
});

it('recognises alternate filenames and retains supplemental and embedded notices', async () => {
  await pkg(undefined, undefined, { 'LICENSE-MIT.txt': mit, NOTICE: 'Synthetic attribution', 'ThirdPartyNoticeText.txt': 'Synthetic embedded-component credit' });
  const result = await inventory();
  expect(result.entries[0].texts).toHaveLength(3);
  const text = renderNotices(result);
  expect(text).toContain('Synthetic attribution');
  expect(text).toContain('Synthetic embedded-component credit');
  expect(text).not.toContain(root);
});

it('requires both MIT and complete Zlib terms from integrity-bound embedded notices', async () => {
  await pkg(undefined, undefined, { LICENSE: mit, 'embedded.txt': zlib }, 'MIT AND Zlib');
  await expect(inventory()).rejects.toThrow('No permitted licence');
  sources.supplements = { 'fixture@1.0.0': [{ file: 'embedded.txt', sha256: hash(zlib), integrity: 'sha512-synthetic', source: 'https://api.example.test/licenses/Zlib' }] };
  expect(renderNotices(await inventory())).toContain(zlib);
  expect((await inventory()).entries[0].selected).toBe('MIT AND Zlib');
  sources.supplements['fixture@1.0.0'][0].integrity = 'sha512-changed';
  await expect(inventory()).rejects.toThrow('Supplemental licence source no longer matches');
  sources.supplements['fixture@1.0.0'][0].integrity = 'sha512-synthetic';
  await writeFile(resolve(root, 'node_modules/fixture/embedded.txt'), 'changed');
  await expect(inventory()).rejects.toThrow('checksum mismatch');
  expect(() => selectLicense('MIT AND Zlib', mit + zlib.split('3.')[0])).toThrow('No permitted licence');
});

it('keeps duplicate package versions and excludes first-party workspaces and links', async () => {
  await pkg('node_modules/fixture', '1.0.0');
  await pkg('node_modules/container/node_modules/fixture', '2.0.0');
  lock.packages['apps/desktop'] = { name: 'fixture-desktop' };
  lock.packages['packages/core'] = { name: 'fixture-core' };
  lock.packages['node_modules/fixture-core'] = { link: true, resolved: 'packages/core' };
  expect((await inventory()).entries.map((e) => e.version)).toEqual(['1.0.0', '2.0.0']);
});

it('records absent optional packages and fails for missing required packages', async () => {
  lock.packages['node_modules/optional-fixture'] = { optional: true };
  expect((await inventory()).skipped).toEqual(['node_modules/optional-fixture']);
  lock.packages['node_modules/required-fixture'] = { version: '1.0.0' };
  await expect(inventory()).rejects.toThrow('Cannot inventory installed package');
});

it('fails on missing text instead of treating a licence identifier or NOTICE as a full grant', async () => {
  await pkg(undefined, undefined, { NOTICE: 'Synthetic copyright notice only' });
  await expect(inventory()).rejects.toThrow('No licence text or reviewed source');
});

it('labels standard terms through an integrity-bound source record and verifies its checksum', async () => {
  await pkg(undefined, undefined, {});
  await writeFile(resolve(root, 'build/licenses/MIT.txt'), mit);
  sources.standards.MIT = { file: 'MIT.txt', sha256: hash(mit), source: 'https://api.example.test/licenses/MIT' };
  sources.packages['fixture@1.0.0'] = { license: 'MIT', kind: 'declared-standard', standard: 'MIT', integrity: 'sha512-synthetic', source: 'https://api.example.test/package/1.0.0', author: 'Fictional Example' };
  expect(renderNotices(await inventory())).toContain('Text provenance: declared-standard');
  await writeFile(resolve(root, 'build/licenses/MIT.txt'), 'changed');
  await expect(inventory()).rejects.toThrow('checksum mismatch');
});

it('invalidates source records when package identity or integrity changes', async () => {
  await pkg(undefined, undefined, {});
  sources.packages['fixture@1.0.0'] = { license: 'MIT', kind: 'declared-standard', standard: 'MIT', integrity: 'sha512-previous' };
  await expect(inventory()).rejects.toThrow('no longer matches');
  lock.packages['node_modules/fixture'].version = '2.0.0';
  await expect(inventory()).rejects.toThrow('differs from lockfile');
});

it('bounds metadata reviews to the declaration, package integrity and included licence text', async () => {
  await pkg(undefined, undefined, { LICENSE: mit }, null);
  sources.metadata['fixture@1.0.0'] = { license: 'MIT', declaredLicense: null, evidenceFile: 'LICENSE', sha256: hash(mit), integrity: 'sha512-synthetic', source: 'https://api.example.test/package/1.0.0', note: 'The published MIT grant omits the metadata field.' };
  expect((await inventory()).entries[0].selected).toBe('MIT');
  sources.metadata['fixture@1.0.0'].declaredLicense = 'GPL-3.0-only';
  await expect(inventory()).rejects.toThrow('metadata review no longer matches');
});

it('rejects cached paths outside the checked-in licence directory', async () => {
  await pkg(undefined, undefined, {});
  sources.packages['fixture@1.0.0'] = { license: 'MIT', kind: 'upstream-source', file: '../outside.txt', sha256: 'synthetic' };
  await expect(inventory()).rejects.toThrow('leaves its directory');
});

it('sorts notices independently of lockfile insertion order', async () => {
  await pkg('node_modules/fixture-new', '2.0.0');
  await pkg('node_modules/fixture-old', '1.0.0');
  const first = renderNotices(await inventory());
  lock.packages = Object.fromEntries(Object.entries(lock.packages).reverse());
  expect(renderNotices(await inventory())).toBe(first);
});
