import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_SIZE, DEFAULT_CODE_STACK, PALETTES, cleanCodeSize, cleanFontName, fontStack, isPalette, windowColours } from './appearance';

const css = readFileSync(join(__dirname, '../../../ui/src/styles.css'), 'utf8');

/** A theme's light and dark token values. A theme that only overrides some tokens takes the rest from the default. */
function tokens(id: string): [Record<string, string>, Record<string, string>] {
  const blocks = (sel: string): [string, string] => {
    // The light block, then the dark block inside the following prefers-color-scheme media query.
    const light = css.indexOf(sel);
    const dark = css.indexOf(sel, light + 1);
    expect(light, sel).toBeGreaterThanOrEqual(0);
    expect(dark, sel).toBeGreaterThan(light);
    return [css.slice(light, css.indexOf('}', light)), css.slice(dark, css.indexOf('}', dark))];
  };
  // Hex values, and plain references to another token (`--a: var(--b)`), resolved once the theme's values are merged.
  const read = (block: string): Record<string, string> => Object.fromEntries([
    ...[...block.matchAll(/--([\w-]+):\s*#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => {
      const hex = m[2].toLowerCase();
      return [m[1], `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`];
    }),
    ...[...block.matchAll(/--([\w-]+):\s*var\(--([\w-]+)\);/g)].map((m) => [m[1], `@${m[2]}`])
  ]);
  const resolve = (t: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.startsWith('@') ? t[v.slice(1)] : v]));
  const base = blocks(':root {');
  const own = id === 'blue' ? base : blocks(`:root[data-palette='${id}'] {`);
  // A theme's light block also applies in dark, under its own dark block.
  return [resolve({ ...read(base[0]), ...read(own[0]) }), resolve({ ...read(base[0]), ...read(base[1]), ...read(own[0]), ...read(own[1]) })];
}

/** `share` of colour a over b, as color-mix(in srgb, a share, b) or a translucent a over b. */
function mix(a: string, b: string, share: number): string {
  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('appearance settings', () => {
  it('accepts installed font names and rejects anything that could break out of a CSS string', () => {
    expect(cleanFontName('  Cascadia   Code ')).toBe('Cascadia Code');
    expect(cleanFontName("Segoe UI Variable Text")).toBe('Segoe UI Variable Text');
    expect(cleanFontName("O'Font-2.0_x")).toBe("O'Font-2.0_x");
    expect(cleanFontName('Noto Sans 日本語')).toBe('Noto Sans 日本語');
    for (const bad of ['Arial"; color: red', 'Arial\\', 'url(x)', 'a;b', '<b>', 'x'.repeat(65), 42, null]) expect(cleanFontName(bad)).toBe('');
  });

  it('keeps the code size in range, in half pixels', () => {
    expect(cleanCodeSize(14)).toBe(14);
    expect(cleanCodeSize('13.3')).toBe(13.5);
    expect(cleanCodeSize(2)).toBe(CODE_SIZE.min);
    expect(cleanCodeSize(99)).toBe(CODE_SIZE.max);
    expect(cleanCodeSize('big')).toBe(CODE_SIZE.default);
  });

  it('puts a chosen font in front of the default stack', () => {
    expect(fontStack('', DEFAULT_CODE_STACK)).toBe(DEFAULT_CODE_STACK);
    expect(fontStack('Consolas', DEFAULT_CODE_STACK)).toBe(`"Consolas", ${DEFAULT_CODE_STACK}`);
    expect(fontStack('x"; y', DEFAULT_CODE_STACK)).toBe(DEFAULT_CODE_STACK);
  });

  it('has title-bar colours for every theme, matching its panel and ink tokens in styles.css', () => {
    for (const p of PALETTES) {
      tokens(p.id).forEach((t, i) => {
        const w = windowColours(p.id, i === 1);
        const label = `${p.id} ${i === 1 ? 'dark' : 'light'}`;
        expect(w.color, `${label} panel`).toBe(t.panel);
        expect(w.symbolColor, `${label} ink`).toBe(t.ink);
        expect(w.background, `${label} bg`).toBe(t.bg);
      });
    }
    expect(isPalette('blue')).toBe(true);
    expect(isPalette('warm-paper')).toBe(true);
    expect(isPalette('neon')).toBe(false);
    // The old default's id: settings saved with it fall back to the new default.
    expect(isPalette('navy-teal')).toBe(false);
  });

  it('keeps the primary and light colours readable in every theme, light and dark', () => {
    for (const p of PALETTES) {
      tokens(p.id).forEach((t, i) => {
        const label = `${p.id} ${i === 1 ? 'dark' : 'light'}`;
        expect(contrast(t.accent, t.panel), `${label}: accent on panels`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.accent, t.bg), `${label}: accent on the background`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.accent, t['accent-soft']), `${label}: accent on its light colour`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t['accent-ink'], t.accent), `${label}: text on primary buttons`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.ink, t['accent-soft']), `${label}: text on selected rows`).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  it('shows {{variables}} in the primary colour, readable on every surface, in every theme', () => {
    // One rule for every theme: resolved variables are the accent moved towards the ink, on a tint of the accent.
    const text = /--var: color-mix\(in srgb, var\(--accent\) (\d+)%, var\(--ink\)\);/.exec(css);
    const tint = /--var-bg: color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\);/.exec(css);
    const secretTint = /--var-secret-bg: color-mix\(in srgb, var\(--var-secret\) (\d+)%, transparent\);/.exec(css);
    expect(text && tint && secretTint, 'variable colour rules').toBeTruthy();
    expect(css.match(/--var:/g)?.length, 'no theme sets its own resolved colour').toBe(1);
    expect(css.match(/--var-bg:/g)?.length, 'no theme sets its own resolved tint').toBe(1);
    for (const p of PALETTES) {
      tokens(p.id).forEach((t, i) => {
        const label = `${p.id} ${i === 1 ? 'dark' : 'light'}`;
        const min = p.id === 'high-contrast' ? 7 : 4.5;
        const resolved = mix(t.accent, t.ink, Number(text![1]) / 100);
        for (const surface of [t.bg, t.panel, t.code]) {
          expect(contrast(resolved, mix(t.accent, surface, Number(tint![1]) / 100)), `${label}: resolved on ${surface}`).toBeGreaterThanOrEqual(min);
          expect(contrast(t['var-secret'], mix(t['var-secret'], surface, Number(secretTint![1]) / 100)), `${label}: secret on ${surface}`).toBeGreaterThanOrEqual(min);
          expect(contrast(t['var-missing'], surface), `${label}: missing on ${surface}`).toBeGreaterThanOrEqual(min);
          expect(contrast(t['var-dynamic'], surface), `${label}: dynamic on ${surface}`).toBeGreaterThanOrEqual(min);
        }
        expect(new Set([resolved, t['var-secret'], t['var-missing'], t['var-dynamic']]).size, `${label}: four different colours`).toBe(4);
      });
    }
  });
});
