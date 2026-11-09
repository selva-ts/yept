// The Monaco half of CodeEditor, loaded with Monaco and its workers when the first editor is shown.
import { useContext, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { VAR_RE } from '@shared/vars';
import '../monaco';
import { useEditorAppearance, type CodeEditorProps } from './CodeEditor';
import { VarContext } from './VarInput';

type MonacoEditor = Parameters<OnMount>[0];

export function MonacoCodeEditor({ value, language, readOnly, highlightVars, onChange }: CodeEditorProps): React.JSX.Element {
  const { theme, fontFamily, fontSize, fontWeight, configureTheme } = useEditorAppearance();
  const [monaco, setMonaco] = useState<typeof import('monaco-editor') | null>(null);
  useEffect(() => { if (monaco && configureTheme) configureTheme(monaco); }, [monaco, configureTheme]);
  const lookup = useContext(VarContext);
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  const decorations = useRef<ReturnType<MonacoEditor['createDecorationsCollection']> | null>(null);

  // Re-decorate when the text or the variable states (environment, preview) change.
  useEffect(() => {
    if (!editor || !highlightVars) return;
    const model = editor.getModel();
    if (!model) return;
    const ranges = [];
    for (let line = 1; line <= model.getLineCount(); line++) {
      for (const m of model.getLineContent(line).matchAll(VAR_RE)) {
        const start = (m.index ?? 0) + 1;
        ranges.push({
          range: { startLineNumber: line, startColumn: start, endLineNumber: line, endColumn: start + m[0].length },
          options: { inlineClassName: `mvar-${lookup?.state(m[1]) ?? 'pending'}`, hoverMessage: { value: lookup?.describe(m[1]) ?? m[0] } }
        });
      }
    }
    decorations.current ??= editor.createDecorationsCollection();
    decorations.current.set(ranges);
  }, [editor, highlightVars, lookup, value]);

  return (
    <Editor
      value={value}
      language={language}
      theme={theme}
      beforeMount={(api) => { configureTheme?.(api); setMonaco(api); }}
      onMount={(ed) => setEditor(ed)}
      onChange={(v) => onChange?.(v ?? '')}
      options={{
        readOnly,
        // Monaco's EditContext input ignores document.execCommand('paste'), which is how VS Code delivers Ctrl+V to a
        // webview, so pasting did nothing in the extension. The textarea input takes it, and the desktop app too.
        editContext: false,
        minimap: { enabled: false },
        fontFamily,
        fontSize,
        fontWeight,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        automaticLayout: true,
        renderLineHighlight: readOnly ? 'none' : 'line',
        folding: true,
        padding: { top: 8 }
      }}
    />
  );
}
