import { describe, expect, it } from 'vitest';
import { scanForLeaks } from '@yept/core/engine/guard/leak-scan';
import { collectionFolders, findingMessage, findingRange, hasYeptBlock, hookBlock, hookReport, inCollections, installHook, isOnlyYept, isScannedFile, removeHook, HOOK_START } from './leak-check';

// Synthetic values, built at run time.
const TOKEN = ['synthetic', 'value', '0123456789'].join('-');
const scan = (text: string) => scanForLeaks([{ path: 'api/Request.yml', text }]);

describe('leak check', () => {
  it('scans collection files only', () => {
    expect(isScannedFile('C:\\work\\api\\Login.yml')).toBe(true);
    expect(isScannedFile('api/environments/local.yaml')).toBe(true);
    expect(isScannedFile('api/Old.bru')).toBe(true);
    expect(isScannedFile('api/bruno.json')).toBe(true);
    expect(isScannedFile('api/readme.md')).toBe(false);
    expect(isScannedFile('api/node_modules/pkg/package.json')).toBe(false);
    expect(isScannedFile('api/.yept-tmp-123.yml')).toBe(false);
  });

  it('places a finding on its value, or on the line when the value cannot be found', () => {
    const line = `      value: Bearer ${TOKEN}`;
    const [finding] = scan(`headers:\n${line}\n`);
    expect(finding).toMatchObject({ line: 2, kind: 'bearer' });
    const range = findingRange(line, finding);
    expect(line.slice(range.start, range.end)).toBe(TOKEN);
    expect(findingRange('  something else', finding)).toEqual({ start: 2, end: 16 });
  });

  it('places a short credential value', () => {
    const line = '  password: abc';
    const [finding] = scan(`auth:\n${line}\n`);
    expect(finding.kind).toBe('credential-field');
    const range = findingRange(line, finding);
    expect(line.slice(range.start, range.end)).toBe('abc');
  });

  it('names the rule and the fix, never the value', () => {
    const findings = scan(`a: Bearer ${TOKEN}\n- secret: true\n  value: ${TOKEN}\n`);
    expect(findings.map((f) => f.kind)).toEqual(['bearer', 'secret-with-value']);
    for (const f of findings) {
      expect(findingMessage(f)).toMatch(/local secret/);
      expect(findingMessage(f)).not.toContain(TOKEN);
    }
    expect(findingMessage(findings[0])).toBe('A literal Bearer credential instead of a {{variable}}. Keep the value as a local secret.');
    const report = hookReport(findings);
    expect(report).toContain('api/Request.yml:1');
    expect(report).toContain('git commit --no-verify');
    expect(report).not.toContain(TOKEN);
  });

  it('finds collection folders and the staged files in them', () => {
    const folders = collectionFolders(['opencollection.yml', 'apis/one/opencollection.yml', 'apis/two/bruno.json', 'docs/readme.md']);
    expect(folders.sort()).toEqual(['', 'apis/one', 'apis/two']);
    expect(inCollections(['apis/one/A.yml', 'apis/three/B.yml', 'apis/one-more/C.yml'], ['apis/one'])).toEqual(['apis/one/A.yml']);
    expect(inCollections(['A.yml', 'node_modules/x.json'], [''])).toEqual(['A.yml']);
  });

  it('writes a hook that finds Node, or falls back to VS Code run as Node', () => {
    const block = hookBlock("C:\\Program Files\\Code's\\Code.exe");
    expect(block).toContain('command -v node');
    expect(block).toContain(`ELECTRON_RUN_AS_NODE=1 'C:/Program Files/Code'\\''s/Code.exe' "$yept_checker"`);
    expect(block).toContain('yept-leak-check.cjs');
    expect(block).toContain('Remove Pre-commit Leak Check Hook');
  });

  it('creates, updates, adds to and removes from a hook', () => {
    const block = hookBlock('/usr/bin/code');
    const created = installHook(undefined, block);
    expect(created).toEqual({ action: 'created', text: `#!/bin/sh\n${block}\n` });
    if (created.action === 'unsupported') throw new Error();
    expect(isOnlyYept(created.text)).toBe(true);
    const updated = installHook(created.text, hookBlock('/other/code'));
    expect(updated.action).toBe('updated');
    if (updated.action === 'unsupported') throw new Error();
    expect(updated.text.split(HOOK_START).length).toBe(2);
    expect(updated.text).toContain('/other/code');
    expect(removeHook(created.text)).toBeNull();

    const theirs = '#!/usr/bin/env bash\r\nnpm test\r\nexit 0\r\n';
    const added = installHook(theirs, block);
    expect(added.action).toBe('added');
    if (added.action === 'unsupported') throw new Error();
    expect(added.text.startsWith(`#!/usr/bin/env bash\n${block}\nnpm test`)).toBe(true);
    expect(isOnlyYept(added.text)).toBe(false);
    expect(hasYeptBlock(added.text)).toBe(true);
    expect(removeHook(added.text)).toBe('#!/usr/bin/env bash\nnpm test\nexit 0\n');
    expect(installHook(added.text, block).action).toBe('updated');

    expect(installHook('npm test\n', block)).toEqual({ action: 'added', text: `#!/bin/sh\n${block}\nnpm test\n` });
    expect(installHook('#!/usr/bin/env python3\nprint(1)\n', block)).toEqual({ action: 'unsupported' });
  });
});
