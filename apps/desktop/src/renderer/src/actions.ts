// Workspace-level commands shared by the app menu, Home and the sidebar.
import type { TreeNode } from '@shared/model';
import { errorMessage, yept } from '@yept/ui/api';
import { isDirty, useStore } from '@yept/ui/store';
import { confirm, prompt } from '@yept/ui/components/Dialogs';

export async function openFolder(): Promise<void> {
  const { tabs, setSnapshot, toast } = useStore.getState();
  if (tabs.some(isDirty) && !(await confirm('Switch workspace?', 'Open request drafts have unsaved changes. Switching workspace will discard those drafts.', 'Switch workspace', true))) return;
  try {
    const next = await yept.workspace.pick();
    if (next) setSnapshot(next);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function importCollection(): Promise<void> {
  const { setImportPreview, toast } = useStore.getState();
  try {
    const preview = await yept.importer.pick();
    if (preview) setImportPreview(preview);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Opens the "Paste cURL" dialog, optionally with a command already in it (pasted into the command palette). */
export function pasteCurl(command = ''): void {
  useStore.getState().setCurlPaste({ command });
}

/** Creates a collection and stays where you are; the new collection appears in the list. */
export async function createCollection(): Promise<void> {
  const name = await prompt('New collection', 'Collection name', 'Create collection');
  const { mutate, toast } = useStore.getState();
  if (name) await mutate(() => yept.workspace.createCollection(name), () => toast(`Created "${name}"`));
}

export async function deleteCollection(node: TreeNode): Promise<void> {
  const state = useStore.getState();
  const open = state.tabs.filter((t) => t.collectionId === node.id);
  const unsaved = open.some(isDirty) ? ' Unsaved request edits in it will be lost.' : '';
  if (!(await confirm('Move collection to Recycle Bin?', `This moves "${node.name}" and everything in it to the Recycle Bin. You can restore it from there.${unsaved}`, 'Move to Recycle Bin', true))) return;
  await state.mutate(() => yept.workspace.deleteCollection(node.id), () => {
    const s = useStore.getState();
    open.forEach((t) => s.closeTab(t.id));
    if (s.selectedCollectionId === node.id) s.showHome();
  });
}
