// Bruno body modes Yept doesn't support (binary file, SPARQL): kept byte for byte when other fields are saved,
// replaced only when another body type is chosen, and never sent.
import { describe, expect, it } from 'vitest';
import { emptyEnvLayer } from '../env/variables';
import { run } from '../runner/runner';
import { applyRequestDoc, parseRequestFile, stringifyRequestFile, toRequestDoc } from './bruno-adapter';

const request = (body: string): string => `info:
  name: Upload
  type: http
  seq: 1

http:
  method: POST
  url: https://api.example.test/upload
  body:
${body}
settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: true
`;

const FILE_BODY = request(`    type: file
    data:
      - filePath: files/a.bin
        contentType: application/octet-stream
        selected: true
      - filePath: files/b.bin
        contentType: application/octet-stream
        selected: false
`);
const SPARQL_BODY = request(`    type: sparql
    data: SELECT * WHERE { ?s ?p ?o }
`);

describe('unsupported body modes', () => {
  it.each([
    ['file', FILE_BODY],
    ['sparql', SPARQL_BODY]
  ])('a %s body survives an edit of other fields byte for byte', (mode, text) => {
    const item = parseRequestFile(text, 'yml');
    const doc = toRequestDoc(item);
    expect(doc.body).toMatchObject({ mode: 'none', unsupported: mode });
    expect(stringifyRequestFile(applyRequestDoc(item, doc))).toBe(text);
    const edited = { ...doc, url: 'https://api.example.test/upload/v2', headers: [{ name: 'X-Trace', value: '1', enabled: true }] };
    const saved = stringifyRequestFile(applyRequestDoc(item, edited));
    expect(saved).toContain('url: https://api.example.test/upload/v2');
    expect(saved.slice(saved.indexOf('  body:'), saved.indexOf('settings:'))).toBe(text.slice(text.indexOf('  body:'), text.indexOf('settings:')));
  });

  it('choosing another body type replaces it', () => {
    const item = parseRequestFile(FILE_BODY, 'yml');
    const doc = toRequestDoc(item);
    const saved = stringifyRequestFile(applyRequestDoc(item, { ...doc, body: { ...doc.body, mode: 'json', json: '{"a":1}', unsupported: undefined } }));
    expect(saved).toContain('type: json');
    expect(saved).not.toContain('files/a.bin');
    expect(toRequestDoc(parseRequestFile(saved, 'yml')).body).toMatchObject({ mode: 'json', json: '{"a":1}' });
    expect(toRequestDoc(parseRequestFile(saved, 'yml')).body.unsupported).toBeUndefined();
  });

  it('sending stops with an explanation instead of sending without the body', async () => {
    const doc = toRequestDoc(parseRequestFile(FILE_BODY, 'yml'));
    const r = await run(doc, {
      runId: 'r', collectionPath: '.', defaultTimeoutMs: 1000, maxBodyBytes: 1024,
      layers: { collection: [], folders: [], request: [], runtime: {}, environment: emptyEnvLayer() }
    });
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/Body type "file" isn't supported/);  });
});
