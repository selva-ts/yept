import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';

// Times showing the Collections view, from the command that opens it (which activates the extension) to the provider
// returning the top-level items. The provider is wrapped as it is registered; nothing in the extension is changed.
export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find((item) => resolve(item.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase());
  if (!extension) throw new Error('Extension not found');
  if (extension.isActive) throw new Error('The extension activated before the view was shown');
  let shown: number | undefined;
  const window = vscode.window as { registerTreeDataProvider: typeof vscode.window.registerTreeDataProvider };
  const register = window.registerTreeDataProvider;
  window.registerTreeDataProvider = <T>(id: string, provider: vscode.TreeDataProvider<T>) => {
    if (id === 'yept.collections') {
      const children = provider.getChildren.bind(provider);
      provider.getChildren = async (item) => {
        const result = await children(item);
        if (!item) shown ??= performance.now();
        return result;
      };
    }
    return register.call(vscode.window, id, provider);
  };
  const start = performance.now();
  await vscode.commands.executeCommand('yept.collections.focus');
  for (let i = 0; i < 1000 && shown === undefined; i++) await new Promise((r) => setTimeout(r, 10));
  if (shown === undefined) throw new Error('Tree did not provide its first children');
  await writeFile(process.env.YEPT_MEASURE_OUT!, JSON.stringify({ tree: shown - start }));
}
