// Multipart helpers shared by the engine and the UI: where a file path points, the local key of a file field,
// default part content types, and the text summary that stands in for the body in results and history.
import type { MultipartField, MultipartPartSummary } from './model';

/** Windows drive or UNC paths, and POSIX absolute paths. */
export const isAbsolutePath = (p: string): boolean => /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(p.trim());

/**
 * Where a path saved in the request file points: inside the collection folder (shareable), outside it ('../'),
 * an absolute machine path (works only on computers with the same path), or unknown until variables are resolved.
 */
export function pathLocation(p: string): 'collection' | 'outside' | 'absolute' | 'variable' {
  const t = p.trim();
  if (/^\{\{[^}]+\}\}/.test(t)) return 'variable';
  if (isAbsolutePath(t)) return 'absolute';
  const parts = t.split(/[\\/]+/);
  let depth = 0;
  for (const part of parts) {
    if (part === '..') depth--;
    else if (part && part !== '.') depth++;
    if (depth < 0) return 'outside';
  }
  return 'collection';
}

/**
 * Key of a file field in the local store: its name and how many fields before it share that name, so local files
 * stay with the right field when other fields are added or moved.
 */
export function multipartKey(fields: Pick<MultipartField, 'name'>[], index: number): string {
  const name = fields[index].name;
  const before = fields.slice(0, index).filter((f) => f.name === name).length;
  return `${name}#${before}`;
}

/** Local files per field key; fields without any are left out. */
export function localFileMap(fields: MultipartField[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  fields.forEach((f, i) => {
    if (f.type === 'file' && f.localFiles.length) out[multipartKey(fields, i)] = [...f.localFiles];
  });
  return out;
}

export function withLocalFiles(fields: MultipartField[], map: Record<string, string[]>): MultipartField[] {
  return fields.map((f, i) => (f.type === 'file' ? { ...f, localFiles: [...(map[multipartKey(fields, i)] ?? [])] } : f));
}

const TYPES: Record<string, string> = {
  txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', md: 'text/markdown',
  json: 'application/json', xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

/** Content type for a file part when the field doesn't set one. */
export function contentTypeFor(fileName: string): string {
  const ext = /\.([^.\\/]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

export const fileNameOf = (p: string): string => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

/** What the result and history show as the request body: field names, text values, file names and sizes. */
export function describeParts(parts: MultipartPartSummary[]): string {
  const lines = parts.map((p) =>
    p.type === 'file'
      ? `${p.name}: file ${p.fileName} (${p.size} bytes${p.contentType ? `, ${p.contentType}` : ''})`
      : `${p.name}: ${p.value}${p.contentType ? ` (${p.contentType})` : ''}`
  );
  return [`multipart/form-data, ${parts.length} part${parts.length === 1 ? '' : 's'}`, ...lines].join('\n');
}
