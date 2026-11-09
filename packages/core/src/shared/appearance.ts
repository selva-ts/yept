// Built-in colour themes and the font settings. Shared by main (title bar, window background, settings file) and
// the renderer (CSS tokens, Monaco). The colours here must stay in step with the matching blocks in styles.css.

export type ThemeChoice = 'system' | 'light' | 'dark';
export type PaletteId = 'blue' | 'teal' | 'warm-paper' | 'high-contrast';

export const PALETTES: { id: PaletteId; label: string; description: string }[] = [
  { id: 'blue', label: 'Blue', description: 'The default Yept look: navy with blue and light blue.' },
  { id: 'teal', label: 'Navy/Teal', description: 'Navy with a teal accent.' },
  { id: 'warm-paper', label: 'Warm Paper', description: 'Warm paper tones with serif headings.' },
  { id: 'high-contrast', label: 'High Contrast', description: 'Strong text, borders and focus outlines.' }
];

// An id that is no longer offered (such as 'navy-teal', saved by earlier builds when it was the default) isn't a
// palette, so the settings fall back to the default theme.
export const isPalette = (v: unknown): v is PaletteId => PALETTES.some((p) => p.id === v);

/** Title bar (and caption buttons on Windows) and the window background before the page paints. */
export interface WindowColours {
  color: string;
  symbolColor: string;
  background: string;
}

// Blue and Navy/Teal share the navy neutrals; only the accent differs.
const NAVY = {
  light: { color: '#ffffff', symbolColor: '#142136', background: '#f3f6fa' },
  dark: { color: '#142033', symbolColor: '#e9f1f8', background: '#0d1625' }
};

const WINDOW_COLOURS: Record<PaletteId, { light: WindowColours; dark: WindowColours }> = {
  blue: NAVY,
  teal: NAVY,
  'warm-paper': {
    light: { color: '#faf7f0', symbolColor: '#1f1c17', background: '#f3eee4' },
    dark: { color: '#1e1b14', symbolColor: '#ece6d6', background: '#17150f' }
  },
  'high-contrast': {
    light: { color: '#ffffff', symbolColor: '#000000', background: '#ffffff' },
    dark: { color: '#000000', symbolColor: '#ffffff', background: '#000000' }
  }
};

export function windowColours(palette: PaletteId, dark: boolean): WindowColours {
  const set = WINDOW_COLOURS[palette] ?? WINDOW_COLOURS.blue;
  return dark ? set.dark : set.light;
}

// ---------- fonts ----------

/** Installed fonts offered first. Nothing is bundled: a font that isn't installed falls back to the default. */
export const UI_FONTS = ['Aptos', 'Segoe UI Variable Text', 'Segoe UI', 'Calibri', 'Arial', 'Verdana', 'Tahoma', 'SF Pro Text', 'Helvetica Neue'];
export const CODE_FONTS = ['Cascadia Code', 'Cascadia Mono', 'Consolas', 'Lucida Console', 'Courier New', 'SF Mono', 'Menlo', 'Monaco'];

export const DEFAULT_UI_STACK = "'Aptos', 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif";
export const DEFAULT_CODE_STACK = "'Cascadia Code', ui-monospace, 'SF Mono', Consolas, monospace";

export const CODE_SIZE = { min: 10, max: 24, default: 12.5 };

/**
 * A font family name as typed or chosen: letters, digits, spaces and . _ ' - only, so it can be quoted safely
 * in CSS. Anything else (quotes, semicolons, url(...)) is rejected and the default is used.
 */
export function cleanFontName(v: unknown): string {
  if (typeof v !== 'string') return '';
  const name = v.trim().replace(/\s+/g, ' ');
  return name.length <= 64 && /^[\p{L}\p{N} ._'-]*$/u.test(name) ? name : '';
}

export function cleanCodeSize(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return CODE_SIZE.default;
  return Math.round(Math.min(CODE_SIZE.max, Math.max(CODE_SIZE.min, n)) * 2) / 2;
}

/** The CSS font-family for a chosen font (or '' for the default), with the default stack as fallback. */
export function fontStack(name: string, fallback: string): string {
  const clean = cleanFontName(name);
  return clean ? `"${clean}", ${fallback}` : fallback;
}
