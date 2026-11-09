import type { TreeNode, WorkspaceSnapshot } from '@yept/core/shared/model';

export interface CollectionTreeItem {
  id: string;
  kind: TreeNode['kind'] | 'problem';
  name: string;
  path: string;
  method?: TreeNode['method'];
  readOnly?: boolean;
  message?: string;
  requestId?: string;
  children: CollectionTreeItem[];
}

/** Preserve engine ordering and place unreadable files in their closest visible folder. */
export function collectionTree(snapshot: WorkspaceSnapshot): CollectionTreeItem[] {
  const map = (node: TreeNode): CollectionTreeItem => ({
    id: JSON.stringify([snapshot.root, node.kind, node.id]),
    kind: node.kind, name: node.name, path: node.path, method: node.method, readOnly: node.readOnly,
    requestId: node.kind === 'request' ? node.id : undefined,
    children: (node.children ?? []).map(map)
  });
  const result = snapshot.collections.map(map);
  for (const problem of snapshot.problems) {
    let parent: CollectionTreeItem | undefined;
    const visit = (items: CollectionTreeItem[]): void => {
      for (const item of items) {
        const prefix = item.path === '.' || item.path === '' ? '' : `${item.path}/`;
        const length = item.path === '.' ? 0 : item.path.length;
        const parentLength = !parent || parent.path === '.' ? 0 : parent.path.length;
        if (item.kind !== 'request' && problem.path.startsWith(prefix) && (!parent || length > parentLength)) parent = item;
        visit(item.children);
      }
    };
    visit(result);
    const item: CollectionTreeItem = {
      id: JSON.stringify([snapshot.root, 'problem', problem.path]), kind: 'problem',
      name: problem.path.split('/').pop() ?? problem.path, path: problem.path, message: problem.message, children: []
    };
    (parent ? parent.children : result).push(item);
  }
  return result;
}
