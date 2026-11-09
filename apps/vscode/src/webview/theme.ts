import { useEffect, useState } from 'react';
import type { EditorAppearance } from '@yept/ui/components/CodeEditor';

/** VS Code supplies these variables and updates body attributes/styles on theme and font changes. */
export function readEditorAppearance(): EditorAppearance {
  const style = getComputedStyle(document.body);
  const value = (name: string): string => style.getPropertyValue(`--vscode-${name.replaceAll('.', '-')}`).trim();
  const kind = document.body.dataset.vscodeThemeKind;
  const base = kind === 'vscode-high-contrast-light' ? 'hc-light' : kind === 'vscode-high-contrast' ? 'hc-black' : kind === 'vscode-light' ? 'vs' : 'vs-dark';
  const colors: Record<string, string> = {};
  for (const key of ['editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editor.lineHighlightBackground', 'editor.selectionBackground', 'editor.inactiveSelectionBackground', 'editor.selectionHighlightBackground', 'editorCursor.foreground', 'editorIndentGuide.background1', 'editorIndentGuide.activeBackground1', 'editorWidget.background', 'editorWidget.foreground', 'editorWidget.border', 'editorSuggestWidget.background', 'editorSuggestWidget.foreground', 'editorSuggestWidget.selectedBackground', 'editorHoverWidget.background', 'editorHoverWidget.foreground', 'focusBorder', 'contrastBorder', 'scrollbarSlider.background', 'scrollbarSlider.hoverBackground', 'scrollbarSlider.activeBackground']) {
    const color = value(key);
    if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) colors[key] = color;
  }
  return {
    theme: 'yept-vscode', fontFamily: style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace', fontSize: parseFloat(style.getPropertyValue('--vscode-editor-font-size').trim()) || 14, fontWeight: style.getPropertyValue('--vscode-editor-font-weight').trim() || 'normal',
    configureTheme: (monaco) => {
      // Webviews do not receive the workbench TextMate grammar/token theme. Inherit Monaco syntax for this mode.
      monaco.editor.defineTheme('yept-vscode', { base, inherit: true, rules: [], colors });
      monaco.editor.setTheme('yept-vscode');
    }
  };
}
export function useVsCodeAppearance(): EditorAppearance {
  const [appearance, setAppearance] = useState(readEditorAppearance);
  useEffect(() => {
    const observer = new MutationObserver(() => setAppearance(readEditorAppearance()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-kind', 'data-vscode-theme-id'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);
  return appearance;
}
