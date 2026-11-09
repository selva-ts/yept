// Applies the appearance settings to the page: the theme's CSS token set (data-palette on <html>, see styles.css)
// and the chosen installed fonts. Light/dark itself comes from nativeTheme through prefers-color-scheme.
import { DEFAULT_CODE_STACK, DEFAULT_UI_STACK, fontStack } from '@shared/appearance';
import type { Appearance } from '@shared/model';

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.palette = a.palette;
  // Only a chosen font overrides the theme's own stack (Warm Paper keeps its serif headings either way).
  if (a.uiFont) root.style.setProperty('--sans', fontStack(a.uiFont, DEFAULT_UI_STACK));
  else root.style.removeProperty('--sans');
  if (a.codeFont) root.style.setProperty('--mono', fontStack(a.codeFont, DEFAULT_CODE_STACK));
  else root.style.removeProperty('--mono');
  root.style.setProperty('--code-size', `${a.codeFontSize}px`);
}

/** The font-family Monaco uses: the chosen code font, else the default code stack. */
export const editorFontFamily = (a: Appearance): string => fontStack(a.codeFont, DEFAULT_CODE_STACK);

const SAMPLE = 'mmmmmmmmmmlli1|WQ@#0Oo';
const GENERIC = ['monospace', 'serif', 'sans-serif'] as const;
let canvas: HTMLCanvasElement | null = null;

/**
 * True when the font is installed on this computer. Text is measured in the font with each generic family as its
 * fallback: if every width matches the generic family alone, the browser fell back, so the font isn't there.
 */
export function fontInstalled(name: string): boolean {
  if (!name) return true;
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return true;
  const width = (family: string): number => {
    ctx.font = `72px ${family}`;
    return ctx.measureText(SAMPLE).width;
  };
  return GENERIC.some((g) => width(`"${name}", ${g}`) !== width(g));
}
