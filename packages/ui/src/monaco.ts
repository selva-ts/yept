// Monaco loaded from the app bundle (never a CDN), with only the languages Yept needs.
import { loader } from '@monaco-editor/react';
// The full entry point registers the editor's built-in features (importing editor.api alone leaves them
// without their services). Language grammars still load lazily on first use.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { BRU_SCRIPT_TYPES } from './script-types';

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    label === 'json'
      ? new JsonWorker()
      : label === 'typescript' || label === 'javascript'
        ? new TsWorker()
        : label === 'html'
          ? new HtmlWorker() // folding and outline for HTML response bodies
          : new EditorWorker()
};

// Autocomplete and hover docs for Bruno's script API in the Script tabs.
monaco.typescript.javascriptDefaults.setCompilerOptions({ target: monaco.typescript.ScriptTarget.ES2020, allowNonTsExtensions: true, noLib: false });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript.javascriptDefaults.addExtraLib(BRU_SCRIPT_TYPES, 'ts:yept/bru-scripts.d.ts');

// One light and one dark editor theme per app theme (yept-<theme>-<light|dark>), matching the tokens in styles.css.
monaco.editor.defineTheme('yept-blue-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '1a4fa8' },
    { token: 'string.value.json', foreground: '137e50' },
    { token: 'number', foreground: 'b4540c' },
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'comment', foreground: '718198' }
  ],
  colors: {
    'editor.background': '#fbfdff',
    'editor.foreground': '#142136',
    'editorLineNumber.foreground': '#93a3b3',
    'editor.lineHighlightBackground': '#edf2f7',
    'editor.selectionBackground': '#dde6f5',
    'editorIndentGuide.background1': '#e5ebf1',
    'editorWidget.background': '#ffffff',
    'editorCursor.foreground': '#1a4fa8'
  }
});

monaco.editor.defineTheme('yept-blue-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: 'a3c4fa' },
    { token: 'string.value.json', foreground: '8fd3a5' },
    { token: 'number', foreground: 'f0a070' },
    { token: 'keyword', foreground: 'b99bff' },
    { token: 'comment', foreground: '869caf' }
  ],
  colors: {
    'editor.background': '#101c2d',
    'editor.foreground': '#e9f1f8',
    'editorLineNumber.foreground': '#64798e',
    'editor.lineHighlightBackground': '#19283c',
    'editor.selectionBackground': '#1c3150',
    'editorWidget.background': '#142033',
    'editorCursor.foreground': '#8ab4f8'
  }
});

monaco.editor.defineTheme('yept-teal-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '0b7562' },
    { token: 'string.value.json', foreground: '137e50' },
    { token: 'number', foreground: '1d4ed8' },
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'comment', foreground: '718198' }
  ],
  colors: {
    'editor.background': '#fbfdff',
    'editor.foreground': '#142136',
    'editorLineNumber.foreground': '#93a3b3',
    'editor.lineHighlightBackground': '#edf2f7',
    'editor.selectionBackground': '#e3f5ee',
    'editorIndentGuide.background1': '#e5ebf1',
    'editorWidget.background': '#ffffff',
    'editorCursor.foreground': '#087b64'
  }
});

monaco.editor.defineTheme('yept-teal-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: 'f0a070' },
    { token: 'string.value.json', foreground: '8fd3a5' },
    { token: 'number', foreground: '7aa2ff' },
    { token: 'keyword', foreground: 'b99bff' },
    { token: 'comment', foreground: '869caf' }
  ],
  colors: {
    'editor.background': '#101c2d',
    'editor.foreground': '#e9f1f8',
    'editorLineNumber.foreground': '#64798e',
    'editor.lineHighlightBackground': '#19283c',
    'editor.selectionBackground': '#173e3a',
    'editorWidget.background': '#142033',
    'editorCursor.foreground': '#4bd6b0'
  }
});

monaco.editor.defineTheme('yept-warm-paper-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '8a3b12' },
    { token: 'string.value.json', foreground: '2f7d4f' },
    { token: 'number', foreground: '1d4ed8' },
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'comment', foreground: '857d6c' }
  ],
  colors: {
    'editor.background': '#fffdf8',
    'editor.foreground': '#1f1c17',
    'editorLineNumber.foreground': '#a89f8c',
    'editor.lineHighlightBackground': '#f3eee4',
    'editor.selectionBackground': '#fbe3d3',
    'editorIndentGuide.background1': '#e8e1d2',
    'editorWidget.background': '#faf7f0',
    'editorCursor.foreground': '#c2410c'
  }
});

monaco.editor.defineTheme('yept-warm-paper-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: 'f0a070' },
    { token: 'string.value.json', foreground: '8fd3a5' },
    { token: 'number', foreground: '7aa2ff' },
    { token: 'keyword', foreground: 'b99bff' },
    { token: 'comment', foreground: '8f8774' }
  ],
  colors: {
    'editor.background': '#1a1812',
    'editor.foreground': '#ece6d6',
    'editorLineNumber.foreground': '#6f6958',
    'editor.lineHighlightBackground': '#252118',
    'editor.selectionBackground': '#4a2a16',
    'editorWidget.background': '#1e1b14',
    'editorCursor.foreground': '#f08a4b'
  }
});

// High contrast builds on Monaco's own high-contrast themes (strong borders, no faint colours).
monaco.editor.defineTheme('yept-high-contrast-light', {
  base: 'hc-light',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '004d3d' },
    { token: 'string.value.json', foreground: '005a20' },
    { token: 'number', foreground: '0030a0' },
    { token: 'keyword', foreground: '5b00b8' },
    { token: 'comment', foreground: '3d3d3d' }
  ],
  colors: { 'editor.background': '#ffffff', 'editor.foreground': '#000000', 'editorCursor.foreground': '#000000' }
});

monaco.editor.defineTheme('yept-high-contrast-dark', {
  base: 'hc-black',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '7ef5d2' },
    { token: 'string.value.json', foreground: 'a6ffb8' },
    { token: 'number', foreground: 'a8c8ff' },
    { token: 'keyword', foreground: 'd9c2ff' },
    { token: 'comment', foreground: 'd0d0d0' }
  ],
  colors: { 'editor.background': '#000000', 'editor.foreground': '#ffffff', 'editorCursor.foreground': '#ffffff' }
});

loader.config({ monaco });

