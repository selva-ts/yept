import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker&inline';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
self.MonacoEnvironment = { getWorker: (_id: string, label: string) => label === 'json' ? new JsonWorker() : new EditorWorker() };
try {
  vscode.postMessage({ stage: 'loading Monaco' });
  const monaco = await import('monaco-editor');
  vscode.postMessage({ stage: 'starting editor worker' });
  const model = monaco.editor.createModel('{ "value": }', 'json');
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = monaco.editor.create(element, { model });
  const editorWorker = await monaco.editor.createWebWorker({ worker: new EditorWorker() }).getProxy();
  if (!editorWorker) throw new Error('Editor worker did not respond');
  vscode.postMessage({ stage: 'waiting for JSON validation markers' });
  await new Promise<void>((resolve) => {
    const listener = monaco.editor.onDidChangeMarkers(check);
    function check(): void {
      if (monaco.editor.getModelMarkers({ resource: model.uri }).length) { listener.dispose(); resolve(); }
    }
    check();
  });
  const worker = await monaco.json.getWorker();
  const client = await worker(model.uri);
  if (!await client.parseJSONDocument(model.uri.toString())) throw new Error('JSON worker did not parse the model');
  editor.dispose();
  model.dispose();
  vscode.postMessage({ type: 'diagnostics', ok: true, detail: 'Editor and JSON workers responded; invalid JSON reported' });
} catch (error) {
  vscode.postMessage({ type: 'diagnostics', ok: false, detail: error instanceof Error ? error.message : String(error) });
}
