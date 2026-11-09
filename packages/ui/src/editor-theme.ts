// Editor theme names, kept apart from monaco.ts so choosing a theme does not load Monaco.
import type { PaletteId } from '@shared/appearance';

export const isDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function editorTheme(palette: PaletteId, dark: boolean): string {
  return `yept-${palette}-${dark ? 'dark' : 'light'}`;
}
