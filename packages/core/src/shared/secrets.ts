// Heuristics for literal credentials typed into shared fields. Used for inline warnings now and the
// pre-commit leak check. False positives are acceptable; a missed token in Git is not.
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const HAS_VAR = /\{\{[^}]+\}\}/;

export type SecretField = 'token' | 'password' | 'apikey' | 'header';

/** True when a value in a shared field looks like a real credential rather than a {{variable}} reference. */
export function looksLikeSecret(value: string, field: SecretField): boolean {
  const v = value.trim();
  if (!v || HAS_VAR.test(v)) return false;
  if (JWT.test(v)) return true;
  if (field === 'password') return true; // any literal password in a shared file is a leak
  if (field === 'header') return /^(bearer|basic)\s+\S{12,}$/i.test(v);
  return v.length >= 16 && !/\s/.test(v);
}

export function containsJwt(text: string): boolean {
  return JWT.test(text);
}
