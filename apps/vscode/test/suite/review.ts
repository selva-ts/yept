// Manual visual review in an isolated test profile, using only synthetic collection fixtures.
import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestApi } from '../../src/extension';
export async function run(): Promise<void> {
  const directory = process.env.YEPT_REVIEW_DIR!;
  const extension = vscode.extensions.all.find((e) => resolve(e.extensionPath).toLowerCase() === resolve(__dirname, '../../..').toLowerCase())!;
  const api = await extension.activate() as TestApi;
  await api.ready;
  await vscode.commands.executeCommand('yept.collections.focus');
  const visit = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...visit(n.children ?? [])]);
  const request = api.collections.snapshots().flatMap((s) => visit(s.collections)).find((n) => n.kind === 'request' && n.name === 'Create booking');
  const fallback = api.collections.snapshots().flatMap((s) => visit(s.collections)).find((n) => n.kind === 'request');
  if (request || fallback) await vscode.commands.executeCommand('yept.openRequest', (request ?? fallback).id);
  await writeFile(join(directory, 'ready'), 'ready');
  let previous = '';
  for (let i = 0; i < 1800; i++) {
    const command = await readFile(join(directory, 'command'), 'utf8').catch(() => '');
    if (command && command !== previous) {
      previous = command;
      if (command === 'done') return;
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', command, vscode.ConfigurationTarget.Global);
      await writeFile(join(directory, 'theme'), command);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
