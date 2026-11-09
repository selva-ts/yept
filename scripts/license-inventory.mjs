import { readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'Python-2.0', 'WTFPL', 'CC0-1.0', 'Zlib']);
const reviewed = new Set(['CC-BY-4.0', 'LicenseRef-tv4-public-domain']);
const grants = {
  MIT: /permission is hereby granted, free of charge/i,
  'Apache-2.0': /Apache License[\s\S]*Version 2\.0/i,
  ISC: /permission to use, copy, modify, and(?:\/or)? distribute/i,
  'BSD-2-Clause': /redistribution and use in source and binary forms/i,
  'BSD-3-Clause': /redistribution and use in source and binary forms/i,
  '0BSD': /permission to use, copy, modify, and(?:\/or)? distribute/i,
  'BlueOak-1.0.0': /Blue Oak Model License/i,
  'Python-2.0': /PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/i,
  WTFPL: /DO WHAT THE FUCK YOU WANT TO/i,
  'CC0-1.0': /CC0 1\.0 Universal/i,
  Zlib: /This software is provided 'as-is'.*Permission is granted to anyone to use this software for any purpose.*The origin of this software must not be misrepresented.*Altered source versions must be plainly marked as such.*This notice may not be removed or altered from any source distribution/i,
  'CC-BY-4.0': /Attribution 4\.0 International/i,
  'LicenseRef-tv4-public-domain': /released into the "public domain"/i
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

/** A small SPDX expression grammar: an unapproved term cannot grant a permitted branch. */
export function selectLicense(expression, text, approved = []) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('Missing or non-string licence expression');
  const tokens = expression.match(/\(|\)|[A-Za-z0-9][A-Za-z0-9.+-]*|\S/g) ?? [];
  let index = 0;
  const atom = () => {
    const token = tokens[index++];
    if (token === '(') {
      const value = or();
      if (tokens[index++] !== ')') throw new Error(`Invalid licence expression: ${expression}`);
      return value;
    }
    if (!token || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(token) || ['AND', 'OR', 'WITH'].includes(token)) throw new Error(`Invalid licence expression: ${expression}`);
    return { license: token };
  };
  const and = () => {
    let value = atom();
    while (tokens[index] === 'AND') { index++; value = { and: [value, atom()] }; }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[index] === 'OR') { index++; value = { or: [value, and()] }; }
    return value;
  };
  const tree = or();
  if (index !== tokens.length) throw new Error(`Unsupported licence expression: ${expression}`);
  const normalized = text.replace(/\s+/g, ' ');
  const choose = (node) => {
    if (node.or) return choose(node.or[0]) ?? choose(node.or[1]);
    if (node.and) {
      const left = choose(node.and[0]), right = choose(node.and[1]);
      return left && right ? [...new Set([...left, ...right])] : null;
    }
    const id = node.license;
    const permitted = allowed.has(id) || (reviewed.has(id) && approved.includes(id));
    return permitted && normalized.length >= 100 && grants[id]?.test(normalized) ? [id] : null;
  };
  const selected = choose(tree);
  if (!selected) throw new Error(`No permitted licence with complete terms: ${expression}`);
  return selected.join(' AND ');
}

function within(base, path) {
  const full = resolve(base, path);
  const rel = relative(base, full);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Licence path leaves its directory: ${path}`);
  return full;
}

async function verifiedText(base, record) {
  const file = within(base, record.file);
  within(base, await realpath(file));
  const bytes = await readFile(file);
  if (digest(bytes) !== record.sha256) throw new Error(`Licence source checksum mismatch: ${record.file}`);
  return bytes.toString('utf8').trim();
}

export async function collectInventory({ root = repositoryRoot } = {}) {
  root = await realpath(root);
  const lock = await json(resolve(root, 'package-lock.json'));
  const cache = resolve(root, 'build/licenses');
  const sources = await json(resolve(cache, 'sources.json'));
  if (sources.version !== 1) throw new Error('Unsupported licence-source record version');
  const entries = [], skipped = [];
  for (const [path, info] of Object.entries(lock.packages)) {
    if (!path || info.link || path.startsWith('packages/') || path.startsWith('apps/')) continue;
    if (!path.startsWith('node_modules/') && !path.startsWith('shims/')) throw new Error(`Unexpected installed-package path: ${path}`);
    const dir = within(root, path);
    let pkg;
    try {
      within(root, await realpath(dir));
      pkg = await json(resolve(dir, 'package.json'));
    }
    catch (error) {
      if (error.code === 'ENOENT' && info.optional) { skipped.push(path); continue; }
      throw new Error(`Cannot inventory installed package ${path}: ${error.message}`);
    }
    if (!pkg.name || !pkg.version || (info.version && info.version !== pkg.version)) throw new Error(`Installed package differs from lockfile: ${path}`);
    const key = `${pkg.name}@${pkg.version}`;
    const files = (await readdir(dir, { withFileTypes: true })).filter((f) => f.isFile()).map((f) => f.name).sort();
    const licenses = files.filter((f) => /^(?:UNLICEN[CS]E|LICEN[CS]E|COPYING)(?:[._-].*)?$/i.test(f));
    const supplements = files.filter((f) => /^(?:NOTICE|COPYRIGHT)(?:[._-].*)?$/i.test(f) || /^third[-_ ]?party.*(?:notice|licen[cs]e)/i.test(f));
    const texts = [];
    for (const file of [...licenses, ...supplements]) texts.push({ file, text: (await readFile(resolve(dir, file), 'utf8')).trim() });
    for (const record of sources.supplements?.[key] ?? []) {
      if (record.integrity !== info.integrity) throw new Error(`Supplemental licence source no longer matches ${key}`);
      texts.push({ file: record.file, text: await verifiedText(dir, record), source: record.source });
    }
    const metadata = sources.metadata[key];
    const declaredLicense = pkg.license ?? info.license;
    let expression = declaredLicense;
    if (metadata) {
      if (JSON.stringify(expression ?? null) !== JSON.stringify(metadata.declaredLicense) || metadata.integrity !== info.integrity || digest(await readFile(within(dir, metadata.evidenceFile))) !== metadata.sha256) throw new Error(`Licence metadata review no longer matches ${key}`);
      expression = metadata.license;
    }
    let provenance = 'installed licence files', sourceNote = metadata ? `Metadata review: ${metadata.note}\nReview source: ${metadata.source}` : '', author = '';
    if (!licenses.length) {
      const family = sources.families.find((f) => pkg.name.startsWith(f.prefix) && pkg.version === f.version);
      const record = sources.packages[key] ?? family;
      if (!record) throw new Error(`No licence text or reviewed source for ${key}`);
      if (!['upstream-source', 'published-readme', 'declared-standard'].includes(record.kind)) throw new Error(`Unknown licence source kind for ${key}`);
      if ((record.integrity && record.integrity !== info.integrity) || record.license !== expression) throw new Error(`Licence source no longer matches ${key}`);
      if (family) {
        const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
        const url = new URL((repository ?? '').replace(/^git\+/, '').replace(/^git@github.com:/, 'https://github.com/'));
        const name = url.pathname.replace(/^\//, '').replace(/\.git$/, '').replace(/\/$/, '');
        if (url.hostname !== 'github.com' || name.toLowerCase() !== family.repository.toLowerCase()) throw new Error(`Unexpected binary-package repository for ${key}`);
      }
      if (record.evidenceFile && digest(await readFile(within(dir, record.evidenceFile))) !== record.evidenceSha256) throw new Error(`Published licence evidence changed for ${key}`);
      const source = record.kind === 'declared-standard' ? sources.standards[record.standard] : record;
      if (!source) throw new Error(`No standard licence source for ${key}`);
      texts.unshift({ file: source.file, text: await verifiedText(cache, source), source: source.source });
      provenance = record.kind;
      sourceNote = [sourceNote, record.note ?? '', `Package source: ${record.source}`].filter(Boolean).join('\n');
      author = record.author ?? '';
    }
    const terms = texts.filter((t) => !supplements.includes(t.file)).map((t) => t.text).join('\n\n');
    const selected = selectLicense(expression, terms, metadata ? [metadata.license] : []);
    entries.push({ name: pkg.name, version: pkg.version, path, declaredLicense, license: expression, selected, provenance, sourceNote, author, texts });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.path.localeCompare(b.path));
  return { entries, skipped };
}

export function renderNotices({ entries }) {
  const header = [
    'Yept third-party notices', 'Copyright (c) 2026 Selva Subramaniam',
    'Generated from the exact package-lock and installed packages at packaging time.',
    'Build dependencies are included because renderer bundles may contain their code.',
    'Upstream copyrights and licence notices below are retained.',
    'Electron and Chromium include their upstream LICENSE.electron.txt and LICENSES.chromium.html in the runtime.', ''
  ];
  const body = entries.flatMap((entry) => [
    '='.repeat(72), `${entry.name}@${entry.version}`, `Declared licence: ${typeof entry.declaredLicense === 'string' ? entry.declaredLicense : JSON.stringify(entry.declaredLicense) ?? 'not declared'}`, `Selected terms: ${entry.selected}`,
    `Installed package: ${entry.path}`, `Text provenance: ${entry.provenance}`,
    ...(entry.sourceNote ? [entry.sourceNote] : []), ...(entry.author ? [`Published author metadata: ${entry.author}`] : []), '',
    ...entry.texts.flatMap(({ file, text, source }) => [`--- ${file}${source ? ` (${source})` : ''} ---`, text, ''])
  ]);
  return [...header, ...body].join('\n').replace(/\r\n/g, '\n') + '\n';
}
