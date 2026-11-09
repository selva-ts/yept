// Variable references, shared by the runner (blocks the send) and the editor (warns before sending).
export const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** Dynamic ({{$guid}}) and process-env variables are resolved elsewhere and never count as missing. */
export const isBuiltinVar = (name: string): boolean => name.startsWith('$') || name.startsWith('process.env.');

export function findUnresolved(values: (string | undefined)[], vars: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const v of values) {
    for (const [, name] of String(v ?? '').matchAll(VAR_RE)) {
      if (isBuiltinVar(name)) continue;
      if (vars[name] === undefined || vars[name] === '') missing.add(name);
    }
  }
  return [...missing];
}
