import * as vscode from 'vscode';
import type { HistorySummary } from '@yept/core/shared/model';
import { historyDescription, historyIcon, historyLabel, historyTooltip } from './history-tree-model';

/** The request whose runs the view lists: the one in the active request panel, and the run that panel shows. */
export interface HistorySource {
  root: string;
  requestId: string;
  name: string;
  /** The past run the panel shows instead of the latest one, if any. */
  viewing: string | null;
}

export interface HistoryNode {
  root: string;
  requestId: string;
  summary: HistorySummary;
}

/** The History view: past runs of the active panel's request, newest first, read from the local history database. */
export class HistoryView implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<HistoryNode>;
  private viewing: string | null = null;

  constructor(private readonly source: () => HistorySource | undefined, private readonly list: (root: string, requestId: string) => HistorySummary[] | undefined) {
    this.view = vscode.window.createTreeView('yept.history', { treeDataProvider: this });
  }

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    if (node) return [];
    const source = this.source();
    this.viewing = source?.viewing ?? null;
    let runs: HistorySummary[] = [];
    let message: string | undefined;
    if (!source) {
      message = 'Open a request to see its past runs.';
    } else {
      try {
        runs = this.list(source.root, source.requestId) ?? [];
        if (!runs.length) message = 'No runs yet. Each send is kept here, on this machine.';
      } catch (error) {
        message = `History is unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.view.message = message;
    this.view.description = source?.name;
    return source ? runs.map((summary) => ({ root: source.root, requestId: source.requestId, summary })) : [];
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(historyLabel(node.summary));
    const shown = node.summary.runId === this.viewing;
    item.id = node.summary.runId;
    item.description = `${historyDescription(node.summary)}${shown ? ' · shown' : ''}`;
    item.tooltip = historyTooltip(node.summary);
    const icon = historyIcon(node.summary);
    item.iconPath = shown ? new vscode.ThemeIcon('eye') : new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color));
    item.contextValue = 'run';
    item.command = { command: 'yept.history.open', title: 'Open Run', arguments: [node] };
    return item;
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}
