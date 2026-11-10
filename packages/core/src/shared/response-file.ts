// What the response tools need to know about a body: a file name to save it under, and whether it can be previewed
// as an image or a PDF.

const EXTENSIONS: [RegExp, string][] = [
  [/json/i, 'json'],
  [/^image\/svg/i, 'svg'],
  [/xml/i, 'xml'],
  [/html/i, 'html'],
  [/^text\/csv/i, 'csv'],
  [/^text\//i, 'txt'],
  [/^image\/png/i, 'png'],
  [/^image\/jpe?g/i, 'jpg'],
  [/^image\/gif/i, 'gif'],
  [/^image\/webp/i, 'webp'],
  [/^image\/avif/i, 'avif'],
  [/^image\/bmp/i, 'bmp'],
  [/^image\/(x-icon|vnd\.microsoft\.icon)/i, 'ico'],
  [/^application\/pdf/i, 'pdf'],
  [/^application\/zip/i, 'zip'],
  [/javascript/i, 'js']
];

/** A file extension for a content type, 'bin' when unknown. */
export function extensionFor(contentType: string): string {
  return EXTENSIONS.find(([re]) => re.test(contentType.trim()))?.[1] ?? 'bin';
}

/** Windows rejects these characters and names; trailing dots and spaces are dropped too. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').trim();
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned)) return '';
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** The file name a Content-Disposition header gives (filename* first, as RFC 6266 says), or ''. */
export function dispositionFileName(header: string): string {
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      const value = star[2].trim().replace(/^"|"$/g, '');
      if (/^utf-?8$/i.test(star[1].trim()) || !star[1].trim()) return decodeURIComponent(value);
      return value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))); // ISO-8859-1
    } catch {
      // A broken encoding falls through to the plain filename.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  if (!plain) return '';
  return (plain[1] !== undefined ? plain[1].replace(/\\(["\\])/g, '$1') : plain[2].trim());
}

/** The last segment of a URL's path, or ''. */
function urlFileName(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * The default name for "Save to file": the Content-Disposition file name, else the URL's last path segment, else the
 * request name. An extension from the content type is added when the name has none.
 */
export function responseFileName(headers: [string, string][], url: string, contentType: string, fallback: string): string {
  const disposition = headers.find(([k]) => k.toLowerCase() === 'content-disposition')?.[1];
  const fromHeader = disposition ? safeFileName(dispositionFileName(disposition).split(/[/\\]/).at(-1) ?? '') : '';
  if (fromHeader) return fromHeader;
  const name = safeFileName(urlFileName(url)) || safeFileName(fallback) || 'response';
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}.${extensionFor(contentType)}`;
}

/** Bodies above this are not previewed as images or PDFs (they can still be saved). */
export const MEDIA_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;

/** 'image' or 'pdf' when the content type can be previewed from the received bytes, else null. */
export function mediaKind(contentType: string): 'image' | 'pdf' | null {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (IMAGE_TYPES.test(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return null;
}

/** The media type to put in a data: URL for a previewable body (parameters dropped), else null. */
export function mediaType(contentType: string): string | null {
  return mediaKind(contentType) ? contentType.split(';')[0].trim().toLowerCase() : null;
}
