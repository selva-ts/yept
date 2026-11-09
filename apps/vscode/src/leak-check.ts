// The leak check's pure parts: which files are scanned, where a finding sits on its line, what the Problems panel and
// the pre-commit hook say, and how the hook is added to or removed from a hook file. The scanner itself is the
// engine's, the same one the desktop runs before a commit.
import type { LeakFinding } from '@yept/core/engine/guard/leak-scan';

/** Collection files: requests, folder and collection files, environments. */
const SCANNED = /\.(ya?ml|bru|json)$/i;
const SKIPPED = /(^|\/)(node_modules|\.git)(\/|$)|\.yept-tmp-/;

/** Whether a path (relative or absolute, either slash) is a collection file the diagnostics scan. */
export function isScannedFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return SCANNED.test(p) && !SKIPPED.test(p);
}

/**
 * What to do about a finding, in the desktop's words: replace the value with a {{variable}} kept as a local secret.
 * Reasons that already say so are left as they are.
 */
const FIX: Record<LeakFinding['kind'], string> = {
  jwt: 'Replace it with a {{variable}} stored as a local secret.',
  bearer: 'Keep the value as a local secret.',
  'credential-field': '',
  'secret-with-value': 'Clear the value here and store it as a local secret.',
  'local-secret': 'Replace it with a {{variable}}.'
};

/** The Problems panel message: why it was flagged and the fix. The value itself never appears. */
export function findingMessage(finding: LeakFinding): string {
  return [finding.reason, FIX[finding.kind]].filter(Boolean).join(' ');
}

/**
 * The columns of the flagged value on its line. The scanner gives the line and a masked excerpt (the trimmed line
 * with the value replaced by its first characters and length), so the value's place is where the mask starts.
 * Falls back to the line's text without its indentation.
 */
export function findingRange(lineText: string, finding: LeakFinding): { start: number; end: number } {
  const indent = lineText.length - lineText.trimStart().length;
  const trimmed = lineText.trim();
  const whole = { start: indent, end: indent + trimmed.length };
  const mask = /…\((\d+) chars\)/.exec(finding.excerpt);
  if (!mask) return whole;
  const length = Number(mask[1]);
  const prefix = Math.min(4, length);
  const at = mask.index - prefix;
  if (at < 0 || trimmed.slice(0, mask.index) !== finding.excerpt.slice(0, mask.index) || at + length > trimmed.length) return whole;
  return { start: indent + at, end: indent + at + length };
}

/** Folders holding a collection, from a list of repository paths ('/' separated): where a marker file sits. */
export function collectionFolders(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = /^(?:(.*)\/)?(opencollection\.yml|bruno\.json)$/.exec(p);
    if (m) out.add(m[1] ?? '');
  }
  return [...out];
}

/** The staged paths inside a collection folder. The hook scans every one of them, as the desktop's commit does. */
export function inCollections(paths: string[], folders: string[]): string[] {
  return paths.filter((p) => !SKIPPED.test(p) && folders.some((f) => f === '' || p.startsWith(`${f}/`)));
}

/** What the hook prints when it blocks a commit. */
export function hookReport(findings: LeakFinding[]): string {
  const lines = [
    'Yept leak check: commit blocked, this looks like a secret.',
    'Shared files go to everyone with access to the repository, and Git keeps them forever.',
    ''
  ];
  for (const f of findings) lines.push(`  ${f.path}:${f.line}  ${findingMessage(f)}`, `      ${f.excerpt}`);
  lines.push('', 'Replace these with {{variables}} stored as local secrets, then stage the files again.', 'To commit anyway, run: git commit --no-verify');
  return `${lines.join('\n')}\n`;
}

// ---------- the pre-commit hook file ----------

export const HOOK_START = '# >>> yept leak check >>>';
export const HOOK_END = '# <<< yept leak check <<<';
/** The checker's file name, next to the hook. */
export const CHECKER = 'yept-leak-check.cjs';

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The hook's block of shell. It runs the bundled checker with Node when Node is on PATH, else with the VS Code (Electron)
 * executable that installed it, run as Node. When neither is there it blocks, saying why, rather than skip the check.
 * @param fallbackNode the VS Code executable; forward slashes work in Git for Windows' sh as well.
 */
export function hookBlock(fallbackNode: string): string {
  const fallback = quote(fallbackNode.replace(/\\/g, '/'));
  return [
    HOOK_START,
    '# Added by the Yept VS Code extension: checks staged collection files for secrets.',
    '# To remove it, run "Yept: Remove Pre-commit Leak Check Hook", or delete this block.',
    `yept_checker="$(dirname "$0")/${CHECKER}"`,
    'if command -v node >/dev/null 2>&1; then',
    '  node "$yept_checker" || exit 1',
    `elif [ -x ${fallback} ]; then`,
    `  ELECTRON_RUN_AS_NODE=1 ${fallback} "$yept_checker" || exit 1`,
    'else',
    '  echo "Yept leak check: Node.js was not found, so staged collection files were not checked." >&2',
    '  echo "Install Node.js, or commit without the check: git commit --no-verify" >&2',
    '  exit 1',
    'fi',
    HOOK_END
  ].join('\n');
}

export type HookInstall =
  | { action: 'created' | 'updated' | 'added'; text: string }
  /** The existing hook isn't a shell script, so the block can't be added to it. */
  | { action: 'unsupported' };

const blockPattern = new RegExp(`${HOOK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${HOOK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);

export const hasYeptBlock = (text: string): boolean => blockPattern.test(text.replace(/\r\n/g, '\n'));

/** Whether a hook is Yept's alone: nothing in it but the shebang, the block and blank lines. */
export function isOnlyYept(text: string): boolean {
  const rest = text.replace(/\r\n/g, '\n').replace(blockPattern, '').split('\n').filter((l) => l.trim() && !l.startsWith('#!'));
  return hasYeptBlock(text) && rest.length === 0;
}

/**
 * The hook file with the block in it. No file: a new hook. Yept's block already there: replaced (installing again is
 * safe). Another hook: the block goes right after its first line, so it runs before that hook can exit.
 */
export function installHook(existing: string | undefined, block: string): HookInstall {
  if (existing === undefined || !existing.trim()) return { action: 'created', text: `#!/bin/sh\n${block}\n` };
  const text = existing.replace(/\r\n/g, '\n');
  if (blockPattern.test(text)) return { action: 'updated', text: text.replace(blockPattern, `${block}\n`) };
  const [first, ...rest] = text.split('\n');
  if (first.startsWith('#!')) {
    if (!/\b(sh|bash|dash|zsh|ksh)\b/.test(first)) return { action: 'unsupported' };
    return { action: 'added', text: [first, block, ...rest].join('\n') };
  }
  return { action: 'added', text: `#!/bin/sh\n${block}\n${text}` };
}

/** The hook file without the block, or null when nothing else was in it (the file can go). */
export function removeHook(existing: string): string | null {
  if (isOnlyYept(existing)) return null;
  return existing.replace(/\r\n/g, '\n').replace(blockPattern, '');
}
