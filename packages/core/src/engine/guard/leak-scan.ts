// Secret-leak check run before a commit. It blocks, with findings, when a file about to be committed
// contains something that looks like a real credential. False positives are acceptable; a token in Git history is not.
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/g;
const SECRET_KEY = /^\s*(?:-\s*)?(token|password|passwd|secret|client_secret|clientSecret|api[_-]?key|apiKey|access_token|accessToken|refresh_token)\s*:\s*(.+?)\s*$/i;
const HAS_VAR = /\{\{[^}]+\}\}/;

export type { LeakFinding } from '../../shared/model';
import type { LeakFinding } from '../../shared/model';

const mask = (line: string, value: string): string => line.split(value).join(`${value.slice(0, 4)}…(${value.length} chars)`);

function unquote(v: string): string {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

/**
 * @param localSecretValues values stored as local secrets on this machine: finding one in a shared file is a sure leak.
 */
export function scanForLeaks(files: { path: string; text: string }[], localSecretValues: string[] = []): LeakFinding[] {
  const findings: LeakFinding[] = [];
  const locals = [...new Set(localSecretValues.filter((v) => v && v.length >= 6))];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    let inSecretVar = false;
    lines.forEach((line, i) => {
      const add = (kind: LeakFinding['kind'], reason: string, value: string): void => {
        if (!findings.some((x) => x.path === f.path && x.line === i + 1 && x.kind === kind)) findings.push({ path: f.path, line: i + 1, kind, reason, excerpt: mask(line.trim(), value) });
      };
      for (const m of line.matchAll(JWT)) add('jwt', 'Looks like a JSON Web Token (a real bearer token).', m[0]);
      for (const m of line.matchAll(BEARER)) if (!HAS_VAR.test(m[2]) && !JWT.test(m[2])) add('bearer', `A literal ${m[1]} credential instead of a {{variable}}.`, m[2]);
      const k = SECRET_KEY.exec(line);
      // One finding per line is enough: a JWT already explains why a credential field is flagged.
      if (k && !findings.some((x) => x.path === f.path && x.line === i + 1)) {
        const value = unquote(k[2]);
        if (value && !HAS_VAR.test(value) && !/^(null|~|''|"")$/.test(value) && value !== 'true' && value !== 'false') {
          add('credential-field', `"${k[1]}" has a literal value. Use a {{variable}} and keep the value as a local secret.`, value);
        }
      }
      // Environment files: a variable marked `secret: true` must not carry a value.
      if (/^\s*-\s*secret:\s*true\s*$/.test(line) || /^\s*secret:\s*true\s*$/.test(line)) inSecretVar = true;
      else if (/^\s*-\s/.test(line)) inSecretVar = /secret:\s*true/.test(line);
      if (inSecretVar) {
        const v = /^\s*value:\s*(.+)$/.exec(line);
        if (v && unquote(v[1])) add('secret-with-value', 'A variable marked secret has a value in the shared file.', unquote(v[1]));
      }
      for (const s of locals) if (line.includes(s)) add('local-secret', 'Contains a value stored as a local secret on this machine.', s);
    });
  }
  return findings;
}
