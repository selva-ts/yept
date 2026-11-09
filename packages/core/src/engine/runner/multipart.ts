// multipart/form-data bodies. Files are checked before anything is sent (a missing or unreadable file is a
// prepare error naming the field and the path), then streamed from disk on each send: their bytes are never
// buffered, recorded, or put into results and history.
import { createReadStream, promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { MultipartPartSummary } from '../../shared/model';
import { contentTypeFor, fileNameOf } from '../../shared/multipart';

/** A part after variables are filled in, before files are checked. File paths are as written (maybe relative). */
export interface MultipartInput {
  name: string;
  type: 'text' | 'file';
  value: string;
  /** File parts: one path; a field with several files gives one part per file. */
  path: string;
  contentType: string;
}

/** A part ready to send. File parts carry the absolute path and the size checked before sending. */
export type MultipartPart = MultipartPartSummary & { path?: string; size?: number };

export class MultipartFileError extends Error {}

/**
 * Resolves file paths against the collection folder and checks each file can be read. Throws a MultipartFileError
 * naming the field and the path otherwise.
 */
export async function loadParts(inputs: MultipartInput[], collectionDir: string): Promise<MultipartPart[]> {
  const out: MultipartPart[] = [];
  for (const p of inputs) {
    if (p.type === 'text') {
      out.push({ name: p.name, type: 'text', value: p.value, contentType: p.contentType });
      continue;
    }
    const abs = isAbsolute(p.path) ? p.path : join(collectionDir, p.path);
    const fail = (why: string): never => {
      throw new MultipartFileError(`Multipart field "${p.name}": ${p.path} ${why}`);
    };
    const stat = await fs.stat(abs).catch((e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' ? 'was not found' : `can't be read (${e.code ?? e.message})`));
    if (!stat.isFile()) fail('is not a file');
    // Opening proves the file is readable now (locked or permission-denied files fail here, not mid-send).
    const handle = await fs.open(abs, 'r').catch((e: NodeJS.ErrnoException) => fail(`can't be read (${e.code ?? e.message})`));
    await handle.close();
    const fileName = fileNameOf(abs);
    out.push({ name: p.name, type: 'file', fileName, path: abs, size: stat.size, contentType: p.contentType || contentTypeFor(fileName) });
  }
  return out;
}

/** Quotes a name or file name for Content-Disposition the way browsers do: ", CR and LF percent-encoded. */
const quoted = (s: string): string => `"${s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}"`;

export interface EncodedMultipart {
  contentType: string;
  length: number;
  /** A new stream each time: a re-send (after a 401) reads the files again. */
  stream: () => Readable;
}

export function encodeMultipart(parts: MultipartPart[], boundary = `----YeptFormBoundary${randomBytes(12).toString('hex')}`): EncodedMultipart {
  const segments: (Buffer | { path: string; size: number })[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(p.name)}`;
    if (p.type === 'file') head += `; filename=${quoted(p.fileName ?? '')}`;
    if (p.contentType) head += `\r\nContent-Type: ${p.contentType}`;
    segments.push(Buffer.from(`${head}\r\n\r\n`, 'utf8'));
    segments.push(p.type === 'file' ? { path: p.path!, size: p.size! } : Buffer.from(p.value ?? '', 'utf8'));
    segments.push(Buffer.from('\r\n'));
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`));
  const length = segments.reduce((n, s) => n + (Buffer.isBuffer(s) ? s.length : s.size), 0);
  async function* body(): AsyncGenerator<Buffer> {
    for (const s of segments) {
      if (Buffer.isBuffer(s)) {
        yield s;
        continue;
      }
      let read = 0;
      for await (const chunk of createReadStream(s.path)) {
        read += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      // Content-Length was announced from the size checked before sending.
      if (read !== s.size) throw new Error(`${s.path} changed while it was being sent`);
    }
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, length, stream: () => Readable.from(body(), { objectMode: false }) };
}

/** Splits files picked in a dialog: inside the collection they're saved relative to it; others stay on this computer. */
export function splitPickedFiles(collectionDir: string, paths: string[]): { files: string[]; localFiles: string[] } {
  const files: string[] = [];
  const localFiles: string[] = [];
  for (const p of paths) {
    const rel = relative(collectionDir, p);
    if (rel && !/^\.\.([\\/]|$)/.test(rel) && !isAbsolute(rel)) files.push(rel.split(/[\\/]+/).join('/'));
    else localFiles.push(p);
  }
  return { files, localFiles };
}
