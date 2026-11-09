import { createContext, useContext, lazy, Suspense, useEffect, useState } from 'react';
import { editorTheme, isDark } from '../editor-theme';
import { editorFontFamily } from '../appearance';
import { useStore } from '../store';

export interface EditorAppearance {
  theme: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: string;
  configureTheme?: (monaco: typeof import('monaco-editor')) => void;
}
/** Optional host override. Desktop uses its existing appearance settings when absent. */
export const EditorAppearanceContext = createContext<EditorAppearance | undefined>(undefined);

export interface CodeEditorProps {
  value: string;
  language: 'json' | 'xml' | 'plaintext' | 'html' | 'javascript';
  readOnly?: boolean;
  /** Colour {{variables}} by resolution state (request bodies). */
  highlightVars?: boolean;
  onChange?: (value: string) => void;
}

/** Monaco theme and font for the current appearance; follows a live light/dark switch. */
export function useEditorAppearance(): EditorAppearance {
  const host = useContext(EditorAppearanceContext);
  const appearance = useStore((s) => s.appearance);
  const [dark, setDark] = useState(isDark());
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = (): void => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return host ?? { theme: editorTheme(appearance.palette, dark), fontFamily: editorFontFamily(appearance), fontSize: appearance.codeFontSize };
}

// Monaco and its workers are megabytes of script, so they load with the first editor rather than with the page.
const loadMonacoEditor = (): Promise<{ default: typeof import('./MonacoCodeEditor').MonacoCodeEditor }> =>
  import('./MonacoCodeEditor').then((m) => ({ default: m.MonacoCodeEditor }));
const MonacoCodeEditor = lazy(loadMonacoEditor);

/** Starts loading the editor before one is shown, so the first editor appears without waiting. */
export function preloadCodeEditor(): void {
  void loadMonacoEditor();
}

export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <MonacoCodeEditor {...props} />
    </Suspense>
  );
}
