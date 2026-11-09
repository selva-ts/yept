import { LARGE_BODY_CHARS, type RunResult } from '@yept/core/shared/model';

/** Response bodies open as read-only documents on this scheme, served by the extension (never through the page). */
export const BODY_SCHEME = 'yept-body';

export type BodyLanguage = 'json' | 'xml' | 'html' | 'plaintext';

const HTML_START = /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>])/i;
const XML_START = /^﻿?\s*<\?xml[\s?]/i;
const JSON_START = /^﻿?\s*[[{]/;
const EXTENSIONS: Record<BodyLanguage, string> = { json: 'json', xml: 'xml', html: 'html', plaintext: 'txt' };

/**
 * The result as the page gets it. A text body longer than `limit` characters is cut to its start and marked as a
 * preview, so a large body never crosses to the page whole; the extension keeps it for "Open in editor".
 */
export function previewResult<T extends RunResult>(result: T, limit = LARGE_BODY_CHARS): T {
  const { body } = result;
  if (body.binary || body.text.length <= limit) return result;
  // Never end on the first half of a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(body.text[limit - 1] ?? '') ? limit - 1 : limit;
  return { ...result, body: { ...body, text: body.text.slice(0, end), preview: true } };
}

// Dev Tools shows the first 64 KB of a body; one more character lets it mark the cut.
const DEV_TOOLS_BODY_CHARS = 64 * 1024 + 1;

/**
 * The result as Dev Tools and the collection runner get it: bodies (including those of requests a script sent) cut to
 * what Dev Tools shows, so runs kept for the view stay small.
 */
export function devToolsResult(result: RunResult): RunResult {
  const cut = previewResult(result, DEV_TOOLS_BODY_CHARS);
  if (!cut.scriptRequests?.length) return cut;
  return { ...cut, scriptRequests: cut.scriptRequests.map((c) => ({ ...c, result: previewResult(c.result, DEV_TOOLS_BODY_CHARS) })) };
}

/** The editor language for a body: from its content type, else from how it starts (a text/plain body may be JSON). */
export function bodyLanguage(contentType: string, start: string): BodyLanguage {
  if (/json/i.test(contentType)) return 'json';
  if (/html/i.test(contentType)) return 'html';
  if (/xml/i.test(contentType)) return 'xml';
  if (HTML_START.test(start)) return 'html';
  if (XML_START.test(start)) return 'xml';
  if (JSON_START.test(start)) return 'json';
  return 'plaintext';
}

/** The document path: the run id, then a file name made from the request name, with an extension for the language. */
export function bodyPath(runId: string, requestName: string, language: BodyLanguage): string {
  const name = requestName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').trim() || 'Response';
  return `/${encodeURIComponent(runId)}/${name} response.${EXTENSIONS[language]}`;
}

/** The run id in a document path made by bodyPath, or undefined. */
export function runIdOf(path: string): string | undefined {
  const match = /^\/([^/]+)\//.exec(path);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
