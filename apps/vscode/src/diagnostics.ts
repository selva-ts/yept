import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import tls from 'node:tls';
import * as vscode from 'vscode';
import { caCertificates } from '@yept/core/engine/net/ca';
import { SandboxHost, type SandboxJob } from '@yept/core/engine/sandbox/host';

export interface DiagnosticResult { name: string; ok: boolean; detail: string; ms: number }
export interface DiagnosticsReport { results: DiagnosticResult[]; report: string }

// Errors can include file names; remove paths before a report is copied into an issue.
export function safeDetail(value: string): string {
  return value.replace(/(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/|\/(?!\/))[^\s"'<>|)]+/g, '[path]');
}
export function formatReport(header: string, results: DiagnosticResult[]): string {
  return `${header}\n\n${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms} ms): ${safeDetail(r.detail)}`).join('\n')}\n`;
}
async function timed(name: string, fn: () => Promise<string> | string): Promise<DiagnosticResult> {
  const start = performance.now();
  try { return { name, ok: true, detail: safeDetail(await fn()), ms: Math.round(performance.now() - start) }; }
  catch (error) { return { name, ok: false, detail: safeDetail(error instanceof Error ? error.message : String(error)), ms: Math.round(performance.now() - start) }; }
}
const job = (script: string): SandboxJob => ({
  kind: 'post-response', script, request: { method: 'GET', url: 'http://example.test', headers: {} },
  response: { status: 200, statusText: 'OK', headers: {}, data: {}, responseTime: 1 },
  envVariables: {}, runtimeVariables: {}, collectionPath: '', collectionName: 'diagnostics', processEnv: {}
});
async function scriptCheck(worker: string, runaway: boolean): Promise<string> {
  const host = new SandboxHost(worker, { timeoutMs: 3000, poolSize: 1 });
  try {
    const result = await host.run(job(runaway ? 'while (true) {}' : 'bru.setVar("diagnostic", "ok");'));
    if (runaway) {
      if (result.ok || !result.error?.includes('timed out')) throw new Error(result.error ?? 'Runaway script was not stopped by timeout');
      return 'Runaway script stopped by timeout';
    }
    if (!result.ok || result.runtimeVariables?.diagnostic !== 'ok') throw new Error(result.error ?? 'Script did not set the variable');
    return 'QuickJS script set a variable';
  } finally { await host.close(); }
}
async function monacoCheck(context: vscode.ExtensionContext): Promise<string> {
  const resources = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel('yeptDiagnostics', 'Yept Diagnostics', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [resources] });
  try {
    const webview = panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(resources, 'webview', 'diagnostics.js'));
    const nonce = randomBytes(24).toString('base64');
    let stage = 'waiting for webview';
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Monaco worker timed out after 20 seconds (${stage})`)); }, 20000);
      const subscription = webview.onDidReceiveMessage((message: unknown) => {
        if (message && typeof message === 'object' && 'stage' in message && typeof message.stage === 'string') { stage = message.stage; return; }
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'diagnostics' || !('ok' in message) || !('detail' in message) || typeof message.detail !== 'string') return;
        clearTimeout(timer); subscription.dispose();
        if (message.ok === true) resolve(message.detail); else reject(new Error(message.detail));
      });
    });
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource}; worker-src blob:; base-uri 'none'; form-action 'none'"><title>Yept Diagnostics</title></head><body><p>Checking Monaco workers…</p><script type="module" nonce="${nonce}" src="${script}"></script></body></html>`;
    return await result;
  } finally { panel.dispose(); }
}
export async function runDiagnostics(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<DiagnosticsReport> {
  const worker = vscode.Uri.joinPath(context.extensionUri, 'dist', 'worker.cjs').fsPath;
  const results = [
    await timed('node:sqlite', async () => {
      await mkdir(context.globalStorageUri.fsPath, { recursive: true });
      const folder = await mkdtemp(join(context.globalStorageUri.fsPath, 'diagnostics-'));
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(join(folder, 'test.db'));
        try {
          db.exec('CREATE TABLE test (value TEXT)'); db.prepare('INSERT INTO test VALUES (?)').run('ok');
          const row = db.prepare('SELECT value, sqlite_version() AS version FROM test').get() as { value: string; version: string };
          if (row.value !== 'ok') throw new Error('SQLite read did not match write');
          return `SQLite ${row.version}, write and read passed`;
        } finally { db.close(); }
      } finally { await rm(folder, { recursive: true, force: true }); }
    }),
    await timed('System certificates', () => `system ${tls.getCACertificates('system').length}, default ${tls.getCACertificates('default').length}, combined ${caCertificates().length}`),
    await timed('Worker sandbox', async () => { const variable = await scriptCheck(worker, false); const stopped = await scriptCheck(worker, true); return `${variable}; ${stopped}`; }),
    await timed('QuickJS', () => scriptCheck(worker, false)),
    await timed('Monaco workers', () => monacoCheck(context))
  ];
  const header = `${vscode.env.appName} ${vscode.version}\nNode ${process.versions.node}; Electron ${process.versions.electron ?? 'unavailable'}\n${process.platform} ${process.arch}`;
  const report = formatReport(header, results);
  output.clear(); output.append(report); output.show();
  const failed = results.filter((r) => !r.ok);
  void vscode.window.showInformationMessage(failed.length ? `Diagnostics failed: ${failed.map((r) => r.name).join(', ')}` : `${results.length} of ${results.length} checks passed`);
  return { results, report };
}
