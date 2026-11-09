import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEditorAppearance } from './theme';
afterEach(() => vi.unstubAllGlobals());
describe('VS Code editor appearance', () => {
  it.each([['vscode-light', 'vs'], ['vscode-dark', 'vs-dark'], ['vscode-high-contrast', 'hc-black'], ['vscode-high-contrast-light', 'hc-light']])('follows %s instead of the OS or desktop palette', (kind, base) => {
    const values: Record<string, string> = { '--vscode-editor-background': '#123456', '--vscode-editor-selectionBackground': '#65432180', '--vscode-editor-font-family': 'Test Mono', '--vscode-editor-font-size': '18px', '--vscode-editor-font-weight': '500' };
    vi.stubGlobal('document', { body: { dataset: { vscodeThemeKind: kind } } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) => values[key] ?? '' }));
    const theme = readEditorAppearance();
    const monaco = { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } };
    theme.configureTheme!(monaco as any);
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith('yept-vscode', { base, inherit: true, rules: [], colors: { 'editor.background': '#123456', 'editor.selectionBackground': '#65432180' } });
    expect(theme).toMatchObject({ fontFamily: 'Test Mono', fontSize: 18, fontWeight: '500' });
    values['--vscode-editor-background'] = '#abcdef';
    readEditorAppearance().configureTheme!(monaco as any);
    expect(monaco.editor.defineTheme.mock.lastCall?.[1].colors['editor.background']).toBe('#abcdef');
  });
});
