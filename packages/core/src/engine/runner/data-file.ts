// Data files for the collection runner: a CSV file with a header row, or a JSON array of objects. Each row becomes one
// iteration, its values runtime variables for that iteration (as in Bruno and Postman data files).
import { promises as fs } from 'node:fs';
import { basename, extname } from 'node:path';
import { MAX_ITERATIONS, type DataFileInfo } from '../../shared/collection-run';

export type DataRow = Record<string, string>;

export interface DataFile {
  format: 'csv' | 'json';
  columns: string[];
  rows: DataRow[];
}

/** Larger files are refused before they are read. */
export const MAX_DATA_FILE_BYTES = 5 * 1024 * 1024;

export class DataFileError extends Error {}

/**
 * Parses CSV text (RFC 4180): a header row, fields separated by commas, quoted fields with "" for a quote and with
 * commas or line breaks inside, CRLF or LF line ends, an optional BOM. Blank lines are ignored; a short row leaves its
 * last cells empty; a row longer than the header is an error.
 */
export function parseCsv(text: string): DataFile {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false; // the record has something in it, even an empty quoted cell
  let line = 1;
  let recordLine = 1;
  const endCell = (): void => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = (): void => {
    endCell();
    if (started || cells.length > 1) records.push({ cells, line: recordLine });
    cells = [];
    started = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          const next = src[i + 1];
          if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') throw new DataFileError(`Line ${line}: text after a closing quote. Put the whole value in quotes, with "" for a quote inside it.`);
        }
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      if (cell !== '') throw new DataFileError(`Line ${line}: a quote in the middle of an unquoted value. Put the whole value in quotes, with "" for a quote inside it.`);
      quoted = true;
      started = true;
    } else if (c === ',') {
      endCell();
      started = true;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += c;
      started = true;
    }
  }
  if (quoted) throw new DataFileError(`Line ${recordLine}: a quoted value is never closed.`);
  endRecord();

  const header = records.shift();
  if (!header) throw new DataFileError('The file is empty. The first line should name the variables, like: username,password');
  const columns = header.cells.map((c) => c.trim());
  checkColumns(columns);
  const rows = records.map(({ cells: values, line: at }) => {
    if (values.length > columns.length) throw new DataFileError(`Line ${at} has ${values.length} values, but the header names ${columns.length}.`);
    const row: DataRow = {};
    columns.forEach((name, j) => { row[name] = values[j] ?? ''; });
    return row;
  });
  return checkRows({ format: 'csv', columns, rows });
}

/** Parses a JSON array of objects. Numbers and booleans become text, null becomes empty, objects and arrays become JSON. */
export function parseJsonData(text: string): DataFile {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new DataFileError(`This is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new DataFileError('A JSON data file must be an array of objects, one per iteration, like: [{ "username": "a" }, { "username": "b" }]');
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows = data.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DataFileError(`Item ${i + 1} is not an object. Each item should be an object of variable names and values.`);
    const row: DataRow = {};
    for (const [name, value] of Object.entries(item as Record<string, unknown>)) {
      if (!seen.has(name)) {
        seen.add(name);
        columns.push(name);
      }
      row[name] = value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return row;
  });
  checkColumns(columns);
  return checkRows({ format: 'json', columns, rows });
}

function checkColumns(columns: string[]): void {
  const seen = new Set<string>();
  columns.forEach((name, i) => {
    if (!name.trim()) throw new DataFileError(`Column ${i + 1} has no name. Every column needs a variable name.`);
    if (seen.has(name)) throw new DataFileError(`The variable "${name}" is named twice.`);
    seen.add(name);
  });
}

function checkRows(file: DataFile): DataFile {
  if (!file.rows.length) throw new DataFileError('The file has no rows. Add at least one row of values.');
  if (file.rows.length > MAX_ITERATIONS) throw new DataFileError(`The file has ${file.rows.length} rows. A run can have at most ${MAX_ITERATIONS} iterations.`);
  return file;
}

/** CSV or JSON by extension; otherwise by the first character. */
export function parseDataFile(text: string, fileName: string): DataFile {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.json') return parseJsonData(text);
  if (ext === '.csv') return parseCsv(text);
  return /^﻿?\s*\[/.test(text) ? parseJsonData(text) : parseCsv(text);
}

/** Reads and parses a data file (UTF-8, with or without BOM). Errors say what's wrong in the file. */
export async function readDataFile(path: string): Promise<DataFile> {
  let bytes: Buffer;
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_DATA_FILE_BYTES) throw new DataFileError(`The file is ${(stat.size / 1024 / 1024).toFixed(1)} MB. Data files can be at most ${MAX_DATA_FILE_BYTES / 1024 / 1024} MB.`);
    bytes = await fs.readFile(path);
  } catch (e) {
    if (e instanceof DataFileError) throw e;
    throw new DataFileError(`Can't read the data file: ${(e as Error).message}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DataFileError('The file is not UTF-8 text. Save it as UTF-8 (CSV UTF-8 in Excel) and choose it again.');
  }
  return parseDataFile(text, path);
}

export const dataFileInfo = (path: string, file: DataFile): DataFileInfo => ({ path, name: basename(path), format: file.format, rows: file.rows.length, columns: file.columns });
