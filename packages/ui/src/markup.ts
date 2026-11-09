// HTML and XML response bodies: detection, formatting for the Pretty view and the document shown in Preview.
// The formatter is js-beautify's HTML beautifier as shipped inside monaco-editor (the one Monaco's own HTML
// formatting uses), so there is no extra dependency. It runs in a worker (format.worker.ts) for large bodies.
import { html_beautify, type HTMLBeautifyOptions } from '@html-beautify';

export type MarkupKind = 'html' | 'xml';

const HTML_START = /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>])/i;
const XML_START = /^﻿?\s*<\?xml[\s?]/i;

/** HTML or XML by content type, or by how the body starts when the content type says neither (e.g. text/plain). */
export function markupKind(contentType: string, text: string): MarkupKind | null {
  if (/html/i.test(contentType)) return 'html';
  if (/xml/i.test(contentType)) return 'xml';
  if (/json/i.test(contentType)) return null;
  if (HTML_START.test(text)) return 'html';
  if (XML_START.test(text)) return 'xml';
  return null;
}

const COMMON: HTMLBeautifyOptions = { indent_size: 2, wrap_line_length: 0, preserve_newlines: false, extra_liners: [], end_with_newline: false };
// XML has no void, inline or preformatted elements: <link> in a feed has content, and every element gets its own line.
const XML: HTMLBeautifyOptions = { ...COMMON, inline: [], void_elements: [], unformatted: [], content_unformatted: [] };

/** Indented markup. Whitespace inside text is normalised (except in HTML <pre>/<textarea>); Raw shows the body as received. */
export function formatMarkup(text: string, kind: MarkupKind): string {
  return html_beautify(text, kind === 'xml' ? XML : COMMON);
}

/**
 * Policy for the Preview frame, added to the page itself on top of the app's own policy (both apply). Inline styles and
 * data: images and fonts only: no scripts, no requests to the server or anywhere else, no forms, no <base> tricks.
 */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

/** The response as a document for a sandboxed <iframe srcdoc>, with PREVIEW_CSP as its first element (after any doctype). */
export function previewDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + meta + html.slice(doctype[0].length) : meta + html;
}
