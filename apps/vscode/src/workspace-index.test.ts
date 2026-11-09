import { expect, it } from 'vitest';
import { requestRoots } from './workspace-index';

it('maps requests in different roots even when collection ids collide', () => {
  const snapshot = (root: string, id: string) => ({ root, problems: [], collections: [
    { id: 'collection:.', kind: 'collection' as const, name: 'Sample', path: '.', children: [
      { id, kind: 'request' as const, name: 'Request', path: 'request.yml' }
    ] }
  ] });
  expect([...requestRoots([snapshot('first', 'one'), snapshot('second', 'two')])]).toEqual([['one', 'first'], ['two', 'second']]);
});
