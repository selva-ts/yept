import type { WorkspaceSnapshot } from '@yept/core/shared/model';

/** Requests have globally stable identities; collection ids are scoped to the workspace root. */
export function requestRoots(snapshots: WorkspaceSnapshot[]): Map<string, string> {
  const roots = new Map<string, string>();
  const visit = (nodes: WorkspaceSnapshot['collections'], root: string): void => {
    for (const node of nodes) {
      if (node.kind === 'request') roots.set(node.id, root);
      visit(node.children ?? [], root);
    }
  };
  for (const snapshot of snapshots) visit(snapshot.collections, snapshot.root);
  return roots;
}
