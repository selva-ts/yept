// Where a collection sits inside the workspace. A workspace opened high up (e.g. a folder holding a repo and a
// test folder) can contain collections with the same name in different folders; these helpers tell them apart.
import type { TreeNode } from '@shared/model';

/** Folder of a collection relative to the workspace root ('' when the collection is directly in it). */
export const folderOf = (node: TreeNode): string => {
  const i = node.path.lastIndexOf('/');
  return i < 0 ? '' : node.path.slice(0, i);
};

/** Lower-cased names used by more than one collection. */
export function duplicateNames(collections: TreeNode[]): Set<string> {
  const seen = new Map<string, number>();
  for (const c of collections) seen.set(c.name.toLowerCase(), (seen.get(c.name.toLowerCase()) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
}

/** The collection's name, plus its folder when another collection has the same name. */
export function collectionLabel(node: TreeNode, collections: TreeNode[]): string {
  const folder = folderOf(node);
  return folder && duplicateNames(collections).has(node.name.toLowerCase()) ? `${node.name} (${folder})` : node.name;
}
