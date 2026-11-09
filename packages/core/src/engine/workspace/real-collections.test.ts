// Opt-in check against real team collections. Read-only: loads and parses, never saves.
// Run: YEPT_REAL_COLLECTIONS=C:\path\to\collections npx vitest run packages/core/src/engine/workspace/real-collections.test.ts
// Real collections must never be copied into this repository.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../identity/identity-store';
import { Workspace } from './workspace';
import type { TreeNode } from '../../shared/model';

const dir = process.env.YEPT_REAL_COLLECTIONS;

const count = (nodes: TreeNode[]): number => nodes.reduce((n, x) => n + (x.kind === 'request' ? 1 : 0) + count(x.children ?? []), 0);

describe.skipIf(!dir)('real collections (read-only)', () => {
  it('loads every collection and request without problems', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'yept-real-'));
    const identity = new IdentityStore(join(tmp, 'identity.db'));
    try {
      const ws = new Workspace(dir!, identity, { trash: async () => { throw new Error('read-only test'); } });
      const snap = await ws.load();
      for (const c of snap.collections) console.log(`${c.readOnly ? '[.bru] ' : '[yml]  '}${c.name}: ${count(c.children ?? [])} requests`);
      for (const p of snap.problems) console.log(`problem: ${p.path}: ${p.message}`);
      expect(snap.collections.length).toBeGreaterThan(0);
      expect(snap.problems).toEqual([]);
      // Every request opens in the editor model.
      const walk = (nodes: TreeNode[]): void => nodes.forEach((n) => (n.kind === 'request' ? ws.getRequest(n.id) : walk(n.children ?? [])));
      walk(snap.collections);
    } finally {
      identity.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
