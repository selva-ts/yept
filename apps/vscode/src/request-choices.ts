import type { TreeNode, WorkspaceSnapshot } from '@yept/core/shared/model';

export interface RequestChoice {
  label: string;
  description: string;
  detail: string;
  id: string;
}

/** Every request in the workspace, in tree order, labelled with its collection and path for the quick pick. */
export function requestChoices(snapshot: WorkspaceSnapshot): RequestChoice[] {
  const choices: RequestChoice[] = [];
  const visit = (nodes: TreeNode[], collection: string): void => {
    for (const node of nodes) {
      if (node.kind === 'request') choices.push({ label: node.name, description: collection, detail: node.path, id: node.id });
      visit(node.children ?? [], collection);
    }
  };
  for (const collection of snapshot.collections) visit(collection.children ?? [], collection.name);
  return choices;
}
