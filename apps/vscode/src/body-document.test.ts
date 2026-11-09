import { describe, expect, it } from 'vitest';
import { LARGE_BODY_CHARS, type RunResult } from '@yept/core/shared/model';
import { bodyLanguage, bodyPath, previewResult, runIdOf } from './body-document';

const result = (text: string, binary = false): RunResult => ({
  runId: 'run-1', outcome: 'http', status: 200, durationMs: 5, sizeBytes: text.length, headers: [],
  body: { text, contentType: 'text/plain', truncated: false, binary },
  request: { method: 'GET', url: 'https://api.example.test/big', headers: [] }, timeline: [], environment: '',
  scriptErrors: [], extractions: [], console: [], tests: [], testsState: 'none'
});

describe('previewResult', () => {
  it('passes small and binary bodies through unchanged', () => {
    const small = result('x'.repeat(100));
    expect(previewResult(small)).toBe(small);
    const binary = result('', true);
    expect(previewResult(binary)).toBe(binary);
    const atLimit = result('x'.repeat(10));
    expect(previewResult(atLimit, 10)).toBe(atLimit);
  });

  it('cuts a large body to its start and marks it as a preview', () => {
    const large = result('x'.repeat(LARGE_BODY_CHARS + 5));
    const shown = previewResult(large);
    expect(shown.body.text.length).toBe(LARGE_BODY_CHARS);
    expect(shown.body.preview).toBe(true);
    expect(shown.sizeBytes).toBe(large.sizeBytes);
    expect(large.body.text.length).toBe(LARGE_BODY_CHARS + 5);
    expect(large.body.preview).toBeUndefined();
  });

  it('never ends the preview on half a character', () => {
    const shown = previewResult(result(`abc${'😀'}def`), 4);
    expect(shown.body.text).toBe('abc');
  });
});

describe('bodyLanguage', () => {
  it('follows the content type', () => {
    expect(bodyLanguage('application/json; charset=utf-8', '')).toBe('json');
    expect(bodyLanguage('application/problem+json', '')).toBe('json');
    expect(bodyLanguage('text/html', '')).toBe('html');
    expect(bodyLanguage('application/rss+xml', '')).toBe('xml');
    expect(bodyLanguage('text/plain', 'hello')).toBe('plaintext');
  });

  it('looks at the start of the body when the content type says neither', () => {
    expect(bodyLanguage('text/plain', '  {"a":1}')).toBe('json');
    expect(bodyLanguage('', '[1,2]')).toBe('json');
    expect(bodyLanguage('text/plain', '<!DOCTYPE html><html></html>')).toBe('html');
    expect(bodyLanguage('application/octet-stream', '<?xml version="1.0"?><a/>')).toBe('xml');
  });
});

describe('body document paths', () => {
  it('names the document after the request, with the language extension, and finds the run id again', () => {
    const path = bodyPath('0b8e4c1e-1111-4222-8333-944455556666', 'List: bookings/all', 'json');
    expect(path).toBe('/0b8e4c1e-1111-4222-8333-944455556666/List- bookings-all response.json');
    expect(runIdOf(path)).toBe('0b8e4c1e-1111-4222-8333-944455556666');
    expect(bodyPath('r', '  ', 'plaintext')).toBe('/r/Response response.txt');
  });

  it('finds no run id in other paths', () => {
    expect(runIdOf('/no-name')).toBeUndefined();
    expect(runIdOf('/%E0%A4%A/x.json')).toBeUndefined();
  });
});
