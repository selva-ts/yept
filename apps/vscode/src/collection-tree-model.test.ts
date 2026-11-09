import { expect, it } from 'vitest';
import { collectionTree } from './collection-tree-model';
import type { WorkspaceSnapshot } from '@yept/core/shared/model';

it('preserves engine order and identity, and places problems beside their files', () => {
  const snapshot: WorkspaceSnapshot = { root: 'root-a', collections: [{
    id: 'collection:sample', kind: 'collection', name: 'Sample', path: 'sample', readOnly: true, children: [
      { id: 'folder:sample/auth', kind: 'folder', name: 'Auth', path: 'sample/auth', children: [
        { id: 'request-id', kind: 'request', name: 'Login', path: 'sample/auth/login.bru', method: 'POST', readOnly: true }
      ] },
      { id: 'other', kind: 'request', name: 'Other', path: 'sample/other.bru', method: 'GET' }
    ]
  }], problems: [{ path: 'sample/auth/broken.bru', message: 'Invalid syntax' }] };
  const tree = collectionTree(snapshot);
  expect(tree[0].readOnly).toBe(true);
  expect(tree[0].children.map((n) => n.name)).toEqual(['Auth', 'Other']);
  expect(tree[0].children[0].children).toMatchObject([
    { requestId: 'request-id', method: 'POST', readOnly: true },
    { kind: 'problem', name: 'broken.bru', message: 'Invalid syntax' }
  ]);
  expect(collectionTree(snapshot)).toEqual(tree);
  expect(collectionTree({ ...snapshot, root: 'root-b' })[0].id).not.toBe(tree[0].id);
});

it('attaches a problem to a one-character folder inside a root collection', () => {
  const tree = collectionTree({ root: 'root', problems: [{ path: 'a/broken.yml', message: 'Bad file' }], collections: [
    { id: 'collection:.', kind: 'collection', name: 'Root', path: '.', children: [
      { id: 'folder:a', kind: 'folder', name: 'A', path: 'a' }
    ] }
  ] });
  expect(tree[0].children[0].children[0]).toMatchObject({ kind: 'problem', path: 'a/broken.yml' });
});
