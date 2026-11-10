// Runner data files: CSV edge cases (quotes, commas and line breaks in fields, BOM, empty cells), JSON checks, and
// reading files from disk (UTF-8 only, size limit).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ITERATIONS } from '../../shared/collection-run';
import { dataFileInfo, MAX_DATA_FILE_BYTES, parseCsv, parseDataFile, parseJsonData, readDataFile } from './data-file';

describe('parseCsv', () => {
  it('reads a header row and one row per line', () => {
    const f = parseCsv('username,city\nasha,Chennai\nravi,Pune\n');
    expect(f.columns).toEqual(['username', 'city']);
    expect(f.rows).toEqual([{ username: 'asha', city: 'Chennai' }, { username: 'ravi', city: 'Pune' }]);
    expect(f.format).toBe('csv');
  });

  it('handles quoted fields with commas, doubled quotes and line breaks', () => {
    const f = parseCsv('name,note\r\n"Example, Ltd","said ""hi"""\r\n"two\r\nlines","a\nb"\r\n');
    expect(f.rows).toEqual([
      { name: 'Example, Ltd', note: 'said "hi"' },
      { name: 'two\r\nlines', note: 'a\nb' }
    ]);
  });

  it('strips a BOM and works without a final line break', () => {
    const f = parseCsv('﻿id,value\n1,x');
    expect(f.columns).toEqual(['id', 'value']);
    expect(f.rows).toEqual([{ id: '1', value: 'x' }]);
  });

  it('keeps empty cells empty, fills short rows and skips blank lines', () => {
    const f = parseCsv('a,b,c\n1,,3\n\n,,\n4\n"",x,\n');
    expect(f.rows).toEqual([
      { a: '1', b: '', c: '3' },
      { a: '', b: '', c: '' },
      { a: '4', b: '', c: '' },
      { a: '', b: 'x', c: '' }
    ]);
  });

  it('keeps spaces in values but trims column names', () => {
    expect(parseCsv(' user , pass\n a , b \n').rows).toEqual([{ user: ' a ', pass: ' b ' }]);
  });

  it('says what is wrong with a broken file', () => {
    expect(() => parseCsv('')).toThrow(/empty/);
    expect(() => parseCsv('a,b\n')).toThrow(/no rows/);
    expect(() => parseCsv('a,b\n1,2,3\n')).toThrow('Line 2 has 3 values, but the header names 2.');
    expect(() => parseCsv('a\n"open\n')).toThrow('Line 2: a quoted value is never closed.');
    expect(() => parseCsv('a\n"x"y\n')).toThrow(/Line 2: text after a closing quote/);
    expect(() => parseCsv('a\nx"y\n')).toThrow(/Line 2: a quote in the middle/);
    expect(() => parseCsv('a,,c\n1,2,3\n')).toThrow('Column 2 has no name.');
    expect(() => parseCsv('a,a\n1,2\n')).toThrow('The variable "a" is named twice.');
  });

  it('counts lines inside quoted values for later errors', () => {
    expect(() => parseCsv('a\n"x\ny"\n1,2\n')).toThrow('Line 4 has 2 values');
  });

  it('refuses more rows than a run can have', () => {
    expect(() => parseCsv(`a\n${'1\n'.repeat(MAX_ITERATIONS + 1)}`)).toThrow(/at most 1000 iterations/);
    expect(parseCsv(`a\n${'1\n'.repeat(MAX_ITERATIONS)}`).rows).toHaveLength(MAX_ITERATIONS);
  });
});

describe('parseJsonData', () => {
  it('reads an array of objects, turning values into text', () => {
    const f = parseJsonData('[{ "user": "asha", "age": 31, "admin": false, "tags": ["a"], "note": null }, { "user": "ravi", "city": "Pune" }]');
    expect(f.columns).toEqual(['user', 'age', 'admin', 'tags', 'note', 'city']);
    expect(f.rows).toEqual([{ user: 'asha', age: '31', admin: 'false', tags: '["a"]', note: '' }, { user: 'ravi', city: 'Pune' }]);
  });

  it('accepts a BOM', () => {
    expect(parseJsonData('﻿[{"a":"1"}]').rows).toEqual([{ a: '1' }]);
  });

  it('refuses anything but a non-empty array of objects', () => {
    expect(() => parseJsonData('{ "a": 1 }')).toThrow(/must be an array of objects/);
    expect(() => parseJsonData('[1, 2]')).toThrow('Item 1 is not an object.');
    expect(() => parseJsonData('[{}, []]')).toThrow('Item 2 is not an object.');
    expect(() => parseJsonData('[]')).toThrow(/no rows/);
    expect(() => parseJsonData('[{ "a": 1 },')).toThrow(/not valid JSON/);
    expect(() => parseJsonData('[{ "": 1 }]')).toThrow(/Column 1 has no name/);
  });
});

it('picks the format by extension, else by content', () => {
  expect(parseDataFile('[{"a":"1"}]', 'rows.json').format).toBe('json');
  expect(parseDataFile('a\n1', 'rows.csv').format).toBe('csv');
  expect(parseDataFile('  [{"a":"1"}]', 'rows.txt').format).toBe('json');
  expect(parseDataFile('a\n1', 'rows').format).toBe('csv');
  // A .csv file is CSV even if it starts with a bracket.
  expect(parseDataFile('[a]\n1', 'rows.csv').columns).toEqual(['[a]']);
});

describe('readDataFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yept-data-file-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads UTF-8 with or without a BOM', async () => {
    const plain = join(dir, 'plain.csv');
    const bom = join(dir, 'bom.csv');
    writeFileSync(plain, 'city\nMünchen\n');
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('city\nசென்னை\n')]));
    expect((await readDataFile(plain)).rows).toEqual([{ city: 'München' }]);
    const f = await readDataFile(bom);
    expect(f.rows).toEqual([{ city: 'சென்னை' }]);
    expect(dataFileInfo(bom, f)).toEqual({ path: bom, name: 'bom.csv', format: 'csv', rows: 1, columns: ['city'] });
  });

  it('refuses text that is not UTF-8, large files and missing files', async () => {
    const latin1 = join(dir, 'latin1.csv');
    writeFileSync(latin1, Buffer.from([0x63, 0x0a, 0xe9, 0x0a])); // "c\né\n" in Latin-1
    await expect(readDataFile(latin1)).rejects.toThrow(/not UTF-8/);
    const big = join(dir, 'big.csv');
    writeFileSync(big, Buffer.alloc(MAX_DATA_FILE_BYTES + 1, 0x61));
    await expect(readDataFile(big)).rejects.toThrow(/at most 5 MB/);
    await expect(readDataFile(join(dir, 'missing.csv'))).rejects.toThrow(/Can't read the data file/);
  });
});
