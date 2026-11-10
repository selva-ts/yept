import { expect, it } from 'vitest';
import { dispositionFileName, extensionFor, mediaKind, mediaType, responseFileName } from './response-file';

it('reads the file name from Content-Disposition', () => {
  expect(dispositionFileName('attachment; filename="report.csv"')).toBe('report.csv');
  expect(dispositionFileName('attachment; filename=report.csv')).toBe('report.csv');
  expect(dispositionFileName('attachment; filename="a \\"quoted\\" name.txt"')).toBe('a "quoted" name.txt');
  expect(dispositionFileName("attachment; filename=\"fallback.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe('résumé.pdf');
  expect(dispositionFileName("attachment; filename*=iso-8859-1'en'caf%E9.txt")).toBe('café.txt');
  expect(dispositionFileName("attachment; filename*=UTF-8''%E0%A4%A; filename=plain.txt")).toBe('plain.txt');
  expect(dispositionFileName('inline')).toBe('');
});

it('names a saved body from the header, then the URL, then the request', () => {
  const headers: [string, string][] = [['Content-Type', 'application/pdf'], ['Content-Disposition', 'attachment; filename="invoice-42.pdf"']];
  expect(responseFileName(headers, 'https://api.example.test/files/9', 'application/pdf', 'Get file')).toBe('invoice-42.pdf');
  expect(responseFileName([], 'https://api.example.test/files/photo.png?size=2', 'image/png', 'Get file')).toBe('photo.png');
  expect(responseFileName([], 'https://api.example.test/files/9', 'image/png', 'Get file')).toBe('9.png');
  expect(responseFileName([], 'https://api.example.test/', 'application/json', 'List: all?')).toBe('List- all-.json');
  expect(responseFileName([], 'not a url', 'application/octet-stream', '')).toBe('response.bin');
});

it('never suggests a path or a reserved Windows name', () => {
  const evil: [string, string][] = [['content-disposition', 'attachment; filename="..\\..\\Windows\\win.ini"']];
  expect(responseFileName(evil, 'https://api.example.test/x', 'text/plain', 'R')).toBe('win.ini');
  expect(responseFileName([['Content-Disposition', 'attachment; filename="../etc/passwd"']], 'https://api.example.test/x', 'text/plain', 'R')).toBe('passwd');
  expect(responseFileName([['Content-Disposition', 'attachment; filename="CON"']], 'https://api.example.test/data', 'text/plain', 'R')).toBe('data.txt');
  expect(responseFileName([['Content-Disposition', 'attachment; filename="a:b*c?.txt"']], 'https://api.example.test/', 'text/plain', 'R')).toBe('a-b-c-.txt');
});

it('maps content types to extensions', () => {
  expect(extensionFor('application/json; charset=utf-8')).toBe('json');
  expect(extensionFor('application/problem+json')).toBe('json');
  expect(extensionFor('image/svg+xml')).toBe('svg');
  expect(extensionFor('image/jpeg')).toBe('jpg');
  expect(extensionFor('application/x-unknown')).toBe('bin');
});

it('previews images and PDFs only', () => {
  expect(mediaKind('image/png')).toBe('image');
  expect(mediaKind('IMAGE/JPEG; q=1')).toBe('image');
  expect(mediaKind('image/svg+xml')).toBe('image');
  expect(mediaKind('application/pdf')).toBe('pdf');
  expect(mediaKind('image/tiff')).toBeNull();
  expect(mediaKind('text/html')).toBeNull();
  expect(mediaType('Image/PNG; charset=binary')).toBe('image/png');
  expect(mediaType('text/plain')).toBeNull();
});
