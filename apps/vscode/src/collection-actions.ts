import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TreeNode } from '@yept/core/shared/model';
import type { ImportPreview } from '@yept/core/shared/ipc';
import { collectionNameError } from '@yept/core/engine/workspace/workspace';
import type { ConflictPolicy } from '@yept/core/engine/import/collection-io';
import type { ImportService } from '@yept/core/services/import-service';
import { CurlParseError, curlRequestName, parseCurl, requestFromCurl, type ParsedCurl } from '@yept/core/shared/curl';
import type { Collections, TreeItem } from './collections';

const TREE_MIME = 'application/vnd.code.tree.yept.collections';
/** What the operating system calls the place deleted files go. */
const TRASH = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';

function locate(collections: Collections, id: string): { item: TreeItem; root: string; collectionId: string } | undefined {
  const visit = (items: TreeItem[], root = '', collectionId = ''): ReturnType<typeof locate> => {
    for (const item of items) {
      const [itemRoot, , nodeId] = JSON.parse(item.id) as [string, string, string?];
      const found = { item, root: itemRoot || root, collectionId: item.kind === 'collection' ? nodeId! : collectionId };
      if (item.id === id) return found;
      const child = visit(item.children, found.root, found.collectionId);
      if (child) return child;
    }
    return undefined;
  };
  return visit(collections.getChildren());
}

const FORMAT: Record<ImportPreview['format'], string> = {
  postman: 'Postman collection',
  insomnia: 'Insomnia export',
  openapi: 'OpenAPI document',
  opencollection: 'OpenCollection (bundled)',
  bru: 'Bruno .bru collection'
};
const BODY: Record<ParsedCurl['body']['mode'], string> = {
  none: 'no body', json: 'JSON body', text: 'text body', xml: 'XML body', formUrlEncoded: 'form body', multipartForm: 'multipart body'
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What an import will do, as the desktop's import dialog shows it. */
export function importDetail(p: ImportPreview, name: string): string {
  return [
    `${FORMAT[p.format]} · ${plural(p.counts.requests, 'request')}, ${plural(p.counts.folders, 'folder')}, ${plural(p.counts.environments, 'environment')}.`,
    'Nothing is sent or run during an import; scripts are converted, not executed.',
    `Collection "${name}" in ${p.parentDir}`,
    ...p.issues,
    ...(p.skipped.length ? [`Not imported: ${p.skipped.join('; ')}`] : []),
    ...(p.findings.length ? [`${plural(p.findings.length, 'credential')} found. Next you choose which to move to local secrets.`] : [])
  ].join('\n\n');
}

function requestIds(item: TreeItem): string[] {
  return [...(item.kind === 'request' && item.requestId ? [item.requestId] : []), ...item.children.flatMap(requestIds)];
}

async function reveal(collections: Collections, tree: vscode.TreeView<TreeItem>, root: string, kind: string, id: string, changed: string[] = [], removed: string[] = []): Promise<void> {
  collections.saved(root, changed, removed);
  const node = locate(collections, JSON.stringify([root, kind, id]))?.item;
  if (node) await tree.reveal(node, { select: true, focus: true, expand: true });
}

/** Tree drag data carries stable node ids; the live tree is checked again at drop time. */
export class CollectionDragAndDropController implements vscode.TreeDragAndDropController<TreeItem> {
  readonly dragMimeTypes = [TREE_MIME];
  readonly dropMimeTypes = [TREE_MIME];

  constructor(private readonly collections: Collections, private readonly ready: Promise<void>, private readonly tree: () => vscode.TreeView<TreeItem>) {}

  async handleDrag(sources: readonly TreeItem[], transfer: vscode.DataTransfer): Promise<void> {
    const ids = sources.filter((source) => source.kind === 'request' || source.kind === 'folder').map((source) => source.id);
    if (ids.length) transfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
  }

  async handleDrop(target: TreeItem | undefined, transfer: vscode.DataTransfer): Promise<void> {
    try {
      await this.ready;
      await this.collections.settled();
      const data = transfer.get(TREE_MIME);
      if (!data) return;
      const ids: unknown = JSON.parse(await data.asString());
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) throw new Error('Choose a request or folder to move.');
      const destination = target && locate(this.collections, target.id);
      if (!destination || destination.item.kind === 'workspace' || !['collection', 'folder'].includes(destination.item.kind) || destination.item.readOnly) throw new Error('Choose a writable collection or folder as the drop target.');
      const targetId = JSON.parse(destination.item.id)[2] as string;
      // Items inside a dragged folder move with it, so they are not moved again on their own.
      const dragged = (ids as string[]).map((id) => locate(this.collections, id));
      const inside = (id: string): boolean => {
        const item = dragged.find((d) => d?.item.id === id);
        if (!item || item.item.kind === 'workspace') return false;
        const path = item.item.path;
        return dragged.some((d) => d && d !== item && d.item.kind === 'folder' && d.root === item.root && path.startsWith(`${d.item.path}/`));
      };
      for (const sourceId of (ids as string[]).filter((id) => !inside(id))) {
        const source = locate(this.collections, sourceId);
        if (!source || source.item.kind === 'workspace' || !['request', 'folder'].includes(source.item.kind) || source.item.readOnly) throw new Error('Choose a writable request or folder to move.');
        if (source.root !== destination.root || source.collectionId !== destination.collectionId) throw new Error('Moving between workspace folders or collections is not supported.');
        if (source.item.kind === 'folder' && (source.item.id === destination.item.id || destination.item.path.startsWith(`${source.item.path}/`))) throw new Error('A folder cannot be moved into itself or a descendant.');
        const workspace = this.collections.workspace(source.root);
        if (!workspace) throw new Error('The selected workspace folder has closed.');
        const changed = requestIds(source.item);
        const move = () => workspace.move(JSON.parse(source.item.id)[2] as string, targetId);
        const movedId = source.item.kind === 'folder' ? await this.collections.withWatcherPaused(source.root, move) : await move();
        await reveal(this.collections, this.tree(), source.root, source.item.kind, movedId, changed);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Yept: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Native prompts stay in the host; only engine APIs write collection files. */
export function collectionActions(collections: Collections, ready: Promise<void>, tree: vscode.TreeView<TreeItem>, open: (id: string) => Promise<unknown>, importer: (root: string) => ImportService | undefined): vscode.Disposable[] {
  const guard = (fn: (item?: TreeItem) => Promise<unknown>) => async (item?: TreeItem) => {
    try { await ready; await collections.settled(); return await fn(item); }
    catch (error) { void vscode.window.showErrorMessage(`Yept: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const chooseRoot = async (item?: TreeItem): Promise<string | undefined> => {
    const snapshots = collections.snapshots();
    const selected = item && snapshots.find((s) => JSON.stringify([s.root, 'workspace']) === item.id);
    if (selected) return selected.root;
    if (!snapshots.length) { await vscode.commands.executeCommand('vscode.openFolder'); return; }
    if (snapshots.length === 1) return snapshots[0].root;
    return (await vscode.window.showQuickPick(snapshots.map((s) => ({ label: collections.name(s.root) ?? s.root, description: s.root, root: s.root })), { title: 'Yept: Choose Workspace Folder' }))?.root;
  };
  const show = (root: string, kind: string, id: string, changed: string[] = [], removed: string[] = []) => reveal(collections, tree, root, kind, id, changed, removed);
  const selected = (item?: TreeItem) => item ?? tree.selection[0];
  const writable = (item: TreeItem | undefined, kinds: TreeItem['kind'][]): { item: TreeItem; root: string; id: string } => {
    const found = item && locate(collections, item.id);
    if (!found || found.item.kind === 'workspace' || !kinds.includes(found.item.kind) || found.item.readOnly) throw new Error(`Choose a writable ${kinds.join(' or ')} in the Collections tree.`);
    return { item: found.item, root: found.root, id: JSON.parse(found.item.id)[2] as string };
  };
  const newCollection = async (item?: TreeItem): Promise<{ root: string; id: string } | undefined> => {
    const root = await chooseRoot(item);
    if (!root) return;
    const name = await vscode.window.showInputBox({ title: 'Yept: New Collection', prompt: 'Collection name (created inside the selected workspace folder)', ignoreFocusOut: true,
      // Mirrors the engine's checks so a rejected name keeps the box open with the typed text.
      validateInput: (value) => {
        const clean = value.trim();
        if (!clean) return 'Enter a collection name';
        const invalid = collectionNameError(clean);
        if (invalid) return invalid;
        const taken = collections.workspace(root)?.snapshot().collections.some((c) => c.name.toLowerCase() === clean.toLowerCase()) || existsSync(join(root, clean));
        return taken ? 'A collection with this name already exists' : undefined;
      } });
    if (!name?.trim()) return;
    const workspace = collections.workspace(root);
    if (!workspace) throw new Error('The selected workspace folder has closed.');
    const id = await workspace.createCollection(name);
    await show(root, 'collection', id);
    return { root, id };
  };
  const parents = (): { label: string; description: string; root: string; id: string; treeId: string }[] => {
    const parents: { label: string; description: string; root: string; id: string; treeId: string }[] = [];
    for (const snapshot of collections.snapshots()) {
      const visit = (nodes: TreeNode[], readOnly = false): void => {
        for (const node of nodes) {
          const locked = readOnly || !!node.readOnly;
          if ((node.kind === 'collection' || node.kind === 'folder') && !locked) parents.push({ label: node.name, description: `${collections.name(snapshot.root) ?? snapshot.root} · ${node.path}`, root: snapshot.root, id: node.id, treeId: JSON.stringify([snapshot.root, node.kind, node.id]) });
          visit(node.children ?? [], locked);
        }
      };
      visit(snapshot.collections);
    }
    return parents;
  };
  const chooseParent = async (item: TreeItem | undefined, kind: 'Request' | 'Folder'): Promise<{ root: string; id: string } | undefined> => {
    const available = parents();
    let parent: { root: string; id: string } | undefined = item ? available.find((p) => p.treeId === item.id) : undefined;
    if (item && item.kind !== 'workspace' && !parent) throw new Error('Choose a writable collection or folder.');
    if (!parent && !available.length) {
      const action = await vscode.window.showInformationMessage(`Create a writable collection before adding a ${kind.toLowerCase()}.`, 'New Collection');
      if (action !== 'New Collection') return;
      parent = await newCollection(item);
    } else if (!parent) {
      parent = await vscode.window.showQuickPick(available, { title: 'Yept: Choose Collection or Folder', matchOnDescription: true });
    }
    return parent;
  };
  const newRequest = async (item?: TreeItem): Promise<void> => {
    const parent = await chooseParent(item, 'Request');
    if (!parent) return;
    const name = await vscode.window.showInputBox({ title: 'Yept: New Request', prompt: 'Request name', ignoreFocusOut: true, validateInput: (v) => !v.trim() ? 'Enter a request name' : undefined });
    if (!name?.trim()) return;
    const workspace = collections.workspace(parent.root);
    if (!workspace) throw new Error('The selected workspace folder has closed.');
    const id = await workspace.createRequest(parent.id, name.trim());
    await show(parent.root, 'request', id);
    await open(id);
  };
  const newFolder = async (item?: TreeItem): Promise<void> => {
    const parent = await chooseParent(item, 'Folder');
    if (!parent) return;
    const name = await vscode.window.showInputBox({ title: 'Yept: New Folder', prompt: 'Folder name', ignoreFocusOut: true, validateInput: (value) => !value.trim() ? 'Enter a folder name' : undefined });
    if (!name?.trim()) return;
    const workspace = collections.workspace(parent.root);
    if (!workspace) throw new Error('The selected workspace folder has closed.');
    const id = await workspace.createFolder(parent.id, name.trim());
    await show(parent.root, 'folder', id);
  };
  const rename = async (item?: TreeItem): Promise<void> => {
    const node = writable(selected(item), ['request', 'folder']);
    const name = await vscode.window.showInputBox({ title: `Yept: Rename ${node.item.kind}`, value: node.item.name, valueSelection: [0, node.item.name.length], ignoreFocusOut: true,
      validateInput: (value) => !value.trim() ? 'Enter a name' : value.trim() === node.item.name ? 'Enter a different name' : undefined });
    if (!name?.trim() || name.trim() === node.item.name) return;
    const workspace = collections.workspace(node.root);
    if (!workspace) throw new Error('The selected workspace folder has closed.');
    const changed = requestIds(node.item);
    const change = () => workspace.rename(node.id, name.trim());
    const id = node.item.kind === 'folder' ? await collections.withWatcherPaused(node.root, change) : await change();
    await show(node.root, node.item.kind, id, changed);
  };
  const duplicate = async (item?: TreeItem): Promise<void> => {
    const node = writable(selected(item), ['request']);
    const workspace = collections.workspace(node.root);
    if (!workspace) throw new Error('The selected workspace folder has closed.');
    const id = await workspace.duplicate(node.id);
    await show(node.root, 'request', id);
    await open(id);
  };
  const remove = async (item?: TreeItem): Promise<void> => {
    const node = writable(selected(item), ['request', 'folder']);
    const parentId = collections.getParent(node.item)?.id;
    const choice = await vscode.window.showWarningMessage(`Delete "${node.item.name}"?`, { modal: true, detail: node.item.kind === 'folder' ? `This folder and everything in it will go to the ${TRASH}. You can restore them from there.` : `This request will go to the ${TRASH}. You can restore it from there.` }, 'Delete');
    if (choice !== 'Delete') return;
    const workspace = collections.workspace(node.root);
    if (!workspace) throw new Error('The selected workspace folder has closed.');
    const removed = requestIds(node.item);
    const change = () => workspace.delete(node.id);
    if (node.item.kind === 'folder') await collections.withWatcherPaused(node.root, change);
    else await change();
    collections.saved(node.root, [], removed);
    const parent = parentId && locate(collections, parentId)?.item;
    if (parent) await tree.reveal(parent, { select: true, focus: true });
  };
  const openCollection = async (): Promise<void> => {
    const chosen = await vscode.window.showOpenDialog({ title: 'Yept: Open Collection Folder', canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Open Collection' });
    const uri = chosen?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('Choose a local collection folder.');
    const markers = await Promise.all(['opencollection.yml', 'bruno.json'].map((name) => access(join(uri.fsPath, name)).then(() => true, () => false)));
    if (!markers.some(Boolean)) throw new Error('This folder has no opencollection.yml or bruno.json collection marker.');
    const existing = collections.snapshots().some((s) => s.collections.some((c) => resolve(s.root, c.path) === resolve(uri.fsPath)));
    if (existing) { await vscode.commands.executeCommand('yept.collections.focus'); return; }
    // Let VS Code own folder membership and its trust prompt. Adding an initial folder reloads the extension host.
    const action = await vscode.window.showInformationMessage('Add this collection folder to the VS Code workspace to show it in Yept?', 'Add to Workspace');
    if (action !== 'Add to Workspace') return;
    if (!vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri })) throw new Error('VS Code could not add the folder to this workspace.');
  };
  // Import: a file (Postman, Insomnia, OpenAPI, OpenCollection) or a Bruno .bru folder, previewed before anything is
  // written. The choices match the desktop's import dialog.
  const importCollection = async (item?: TreeItem): Promise<void> => {
    const root = await chooseRoot(item?.kind === 'workspace' ? item : undefined);
    if (!root) return;
    const service = importer(root);
    if (!service) throw new Error('The selected workspace folder has closed.');
    const source = await vscode.window.showQuickPick([
      { label: '$(file) From a File…', description: 'Postman, Insomnia, OpenAPI or OpenCollection', folder: false },
      { label: '$(folder) From a Bruno Folder…', description: 'A .bru collection, converted to YAML', folder: true }
    ], { title: 'Yept: Import Collection' });
    if (!source) return;
    const picked = await vscode.window.showOpenDialog(source.folder
      ? { title: 'Yept: Import Bruno Collection Folder', canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Import' }
      : { title: 'Yept: Import Collection', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Import', filters: { 'Postman, Insomnia, OpenAPI, OpenCollection': ['json', 'yaml', 'yml'], 'All files': ['*'] } });
    const uri = picked?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('Choose a local file or folder.');
    const preview = source.folder ? await service.fromFolder(uri.fsPath) : await service.fromFile(uri.fsPath);
    try {
      let name = preview.collectionName;
      let target = { targetExists: preview.targetExists, existingFiles: preview.existingFiles };
      for (;;) {
        const choice = await vscode.window.showInformationMessage(`Import "${name}"?`, { modal: true, detail: importDetail(preview, name) }, 'Import', 'Rename…');
        if (!choice) return;
        if (choice === 'Import') break;
        const renamed = await vscode.window.showInputBox({ title: 'Yept: Collection Name', value: name, valueSelection: [0, name.length], ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? collectionNameError(value) : 'Enter a collection name') });
        if (renamed?.trim()) {
          name = renamed.trim();
          target = service.check(preview.planId, name);
        }
      }
      // Credentials found in the source: ticked ones become {{variables}} marked secret, as in the desktop.
      let fixIds: string[] = [];
      const optionalFindings = preview.findings.filter((f) => !f.required);
      if (optionalFindings.length) {
        const chosen = await vscode.window.showQuickPick(
          optionalFindings.map((f) => ({ label: `${f.where}: ${f.field}`, description: `${f.preview} → {{${f.variable}}}`, picked: true, id: f.id })),
          { title: `Yept: Credentials Found (${preview.findings.length})`, placeHolder: 'OAuth2 credentials and any other ticked values are stored as local secrets.', canPickMany: true, ignoreFocusOut: true }
        );
        if (!chosen) return;
        fixIds = chosen.map((c) => c.id);
      }
      let policy: ConflictPolicy = 'copy';
      if (target.targetExists) {
        const policies: Record<string, ConflictPolicy> = { 'Import as a Copy': 'copy', 'Keep Existing Files': 'skip', 'Replace Existing Files': 'replace' };
        const choice = await vscode.window.showWarningMessage(`A folder named "${name}" already exists.`, {
          modal: true,
          detail: `${plural(target.existingFiles, 'file')} of the import already exist there. Import as a Copy writes a new folder, Keep Existing Files writes only the new files, and Replace Existing Files overwrites files with the same name. Nothing is deleted.`
        }, ...Object.keys(policies));
        if (!choice) return;
        policy = policies[choice];
      }
      // Replacing files can change requests already open, so their panels are told.
      const { result, changed, removed } = await collections.exclusive(root, () => service.apply(preview.planId, name, fixIds, policy));
      void vscode.window.showInformationMessage(`${preview.format === 'bru' ? 'Converted' : 'Imported'} "${name}": ${plural(result.written, 'file')} written${result.skipped ? `, ${result.skipped} kept as they were` : ''}${result.secretsStored ? `, ${result.secretsStored} value(s) stored as local secrets` : ''}.`);
      if (result.note) void vscode.window.showWarningMessage(result.note);
      if (result.collectionId) await show(root, 'collection', result.collectionId, changed, removed);
      else collections.saved(root, changed, removed);
    } finally {
      service.discard(preview.planId);
    }
  };
  // The collection a command acts on: the tree item, else the selected collection, else one chosen from every folder.
  const chooseCollection = async (item?: TreeItem): Promise<{ root: string; id: string; name: string } | undefined> => {
    const found = item && locate(collections, item.id);
    if (item && (!found || found.item.kind !== 'collection')) throw new Error('Choose a collection in the Collections tree.');
    const current = found ?? (tree.selection[0]?.kind === 'collection' ? locate(collections, tree.selection[0].id) : undefined);
    if (current && current.item.kind !== 'workspace') return { root: current.root, id: current.collectionId, name: current.item.name };
    const all = collections.snapshots().flatMap((s) => s.collections.map((c) => ({ label: c.name, description: collections.name(s.root), root: s.root, id: c.id, name: c.name })));
    if (!all.length) { void vscode.window.showInformationMessage('Open a local workspace folder containing a collection first.'); return; }
    if (all.length === 1) return all[0];
    return vscode.window.showQuickPick(all, { title: 'Yept: Choose Collection', matchOnDescription: true });
  };
  // Export: one bundled OpenCollection YAML file, as the desktop writes it. Secret values are never in it.
  const exportCollection = async (item?: TreeItem): Promise<void> => {
    const chosen = await chooseCollection(item);
    if (!chosen) return;
    const service = importer(chosen.root);
    if (!service) throw new Error('The selected workspace folder has closed.');
    const choice = await vscode.window.showInformationMessage(`Export "${chosen.name}"`, { modal: true, detail: 'Writes the whole collection to one OpenCollection YAML file that Yept or Bruno can import. Secret values are never included.' }, 'With Environments', 'Without Environments');
    if (!choice) return;
    const path = await service.export(chosen.id, choice === 'With Environments');
    if (path) void vscode.window.showInformationMessage(`Exported to ${path}`);
  };
  // Paste cURL: the clipboard's curl command becomes a new request. Nothing is sent, and files it names are not read.
  const pasteCurl = async (item?: TreeItem): Promise<void> => {
    const command = (await vscode.env.clipboard.readText()).trim();
    let parsed: ParsedCurl;
    try {
      if (!command) throw new CurlParseError('The clipboard is empty.');
      parsed = parseCurl(command);
    } catch (error) {
      if (error instanceof CurlParseError) throw new Error(`The clipboard doesn't hold a curl command. ${error.message} Copy a curl command (bash, or Windows cmd as browsers copy it) and try again.`);
      throw error;
    }
    const parent = await chooseParent(item, 'Request');
    if (!parent) return;
    const auth = parsed.auth ? `${parsed.auth.mode} auth` : 'auth inherited';
    const name = await vscode.window.showInputBox({ title: 'Yept: Paste cURL', prompt: `${parsed.method} ${parsed.url} · ${plural(parsed.headers.length, 'header')} · ${BODY[parsed.body.mode]} · ${auth}. Request name:`,
      value: curlRequestName(parsed), ignoreFocusOut: true, validateInput: (v) => !v.trim() ? 'Enter a request name' : undefined });
    if (!name?.trim()) return;
    const workspace = collections.workspace(parent.root);
    if (!workspace) throw new Error('The selected workspace folder has closed.');
    const id = await workspace.createRequest(parent.id, name.trim(), (doc) => requestFromCurl(doc, parsed));
    await show(parent.root, 'request', id);
    await open(id);
    if (parsed.credentials.length) void vscode.window.showWarningMessage(`The command contains ${parsed.credentials.join(', ')}. It is saved in the request file as it is: move it to a secret before you commit.`);
    if (parsed.notes.length) void vscode.window.showInformationMessage(`Not imported from the curl command: ${parsed.notes.join(' ')}`);
  };
  return [
    vscode.commands.registerCommand('yept.importCollection', guard(importCollection)),
    vscode.commands.registerCommand('yept.exportCollection', guard(exportCollection)),
    vscode.commands.registerCommand('yept.pasteCurl', guard(pasteCurl)),
    vscode.commands.registerCommand('yept.newCollection', guard(newCollection)),
    vscode.commands.registerCommand('yept.newRequest', guard(newRequest)),
    vscode.commands.registerCommand('yept.newFolder', guard(newFolder)),
    vscode.commands.registerCommand('yept.rename', guard(rename)),
    vscode.commands.registerCommand('yept.duplicate', guard(duplicate)),
    vscode.commands.registerCommand('yept.delete', guard(remove)),
    vscode.commands.registerCommand('yept.openCollection', guard(openCollection))
  ];
}
