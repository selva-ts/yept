// Multipart / form-data bodies: the Bruno file format, sending against the fixture server, file checks before
// sending, paths outside the collection kept on this computer only, masking, history and the importers.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixtureServer } from '../../../../../fixtures/server/server.mjs';
import { emptyAuth, type MultipartField, type RequestDoc } from '../../shared/model';
import { localFileMap, multipartKey, pathLocation, withLocalFiles } from '../../shared/multipart';
import { emptyEnvLayer, type VarLayers } from '../env/variables';
import { redactResult } from '../history/redact';
import { IdentityStore } from '../identity/identity-store';
import { convertSource } from '../import/collection-io';
import { applyRequestDoc, parseRequestFile, stringifyRequestFile, toRequestDoc } from '../workspace/bruno-adapter';
import { Workspace } from '../workspace/workspace';
import { encodeMultipart, loadParts, splitPickedFiles } from './multipart';
import { run, type RunOptions } from './runner';

let server: Server;
let base = '';
let dir: string;
let collection: string;
let outside: string;

// A marker that must never show up anywhere but on the wire.
const SECRET_CONTENT = 'file-contents-marker-0123456789';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yept-mp-'));
  collection = join(dir, 'ws', 'uploads');
  outside = join(dir, 'elsewhere');
  mkdirSync(join(collection, 'files'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(collection, 'files', 'report.txt'), `report ${SECRET_CONTENT}\n`);
  writeFileSync(join(collection, 'files', 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  writeFileSync(join(outside, 'local.json'), `{"local":"${SECRET_CONTENT}"}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const text = (name: string, value: string, over: Partial<MultipartField> = {}): MultipartField => ({ name, type: 'text', value, files: [], localFiles: [], contentType: '', enabled: true, ...over });
const file = (name: string, files: string[], over: Partial<MultipartField> = {}): MultipartField => ({ name, type: 'file', value: '', files, localFiles: [], contentType: '', enabled: true, ...over });
const doc = (fields: MultipartField[], over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 'Upload', method: 'POST', url: '{{baseUrl}}/upload', params: [], headers: [],
  body: { mode: 'multipartForm', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: fields },
  auth: { ...emptyAuth(), mode: 'none' },
  vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const layers = (secrets: Record<string, string> = {}): VarLayers => ({
  collection: [], folders: [], request: [], runtime: {},
  environment: { ...emptyEnvLayer(), file: { baseUrl: base, dir: 'files', title: 'Quarterly' }, secrets }
});
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({ runId: 'r', layers: layers(), collectionPath: collection, defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, ...over });
const echo = (r: Awaited<ReturnType<typeof run>>): any => JSON.parse(r.result.body.text);

describe('multipart: Bruno file format', () => {
  const FILE = `info:
  name: Upload
  type: http
  seq: 1

http:
  method: POST
  url: "{{baseUrl}}/upload"
  body:
    type: multipart-form
    data:
      - name: title
        type: text
        value: Report {{year}}
      - name: meta
        type: text
        value: '{"a":1}'
        contentType: application/json
      - name: report
        type: file
        value:
          - files/report.txt
          - files/pixel.png
        description: The report and a picture
      - name: off
        type: file
        value: []
        disabled: true
  auth: inherit

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: false
`;

  it('reads text and file fields and writes the file back byte for byte', () => {
    const item = parseRequestFile(FILE, 'yml');
    const d = toRequestDoc(item);
    expect(d.body.mode).toBe('multipartForm');
    expect(d.body.multipartForm).toEqual([
      text('title', 'Report {{year}}'),
      text('meta', '{"a":1}', { contentType: 'application/json' }),
      file('report', ['files/report.txt', 'files/pixel.png']),
      file('off', [], { enabled: false })
    ]);
    expect(stringifyRequestFile(applyRequestDoc(item, d))).toBe(FILE);
  });

  it('saves edits, keeps per-field extras, and never writes files kept on this computer', () => {
    const item = parseRequestFile(FILE, 'yml');
    const d = toRequestDoc(item);
    const fields = d.body.multipartForm.map((f) => (f.name === 'report' ? { ...f, localFiles: [join(outside, 'local.json')] } : f));
    const out = stringifyRequestFile(applyRequestDoc(item, { ...d, body: { ...d.body, multipartForm: [...fields, text('added', 'x')] } }));
    expect(out).toContain('description: The report and a picture');
    expect(out).toContain('- name: added');
    expect(out).not.toContain('local.json');
    expect(out).not.toContain(outside);
  });

  it('reads the same fields from a .bru file', () => {
    const bru = `meta {\n  name: Upload\n  type: http\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/upload\n  body: multipartForm\n  auth: none\n}\n\nbody:multipart-form {\n  title: hello\n  report: @file(files/report.txt|files/pixel.png)\n}\n`;
    const d = toRequestDoc(parseRequestFile(bru, 'bru'));
    expect(d.body.mode).toBe('multipartForm');
    expect(d.body.multipartForm.map((f) => [f.name, f.type, f.type === 'file' ? f.files : f.value])).toEqual([['title', 'text', 'hello'], ['report', 'file', ['files/report.txt', 'files/pixel.png']]]);
  });
});

describe('multipart: sending', () => {
  it('sends text and file fields; files are read from disk and arrive intact', async () => {
    const r = await run(doc([
      text('title', '{{title}} report'),
      text('meta', '{"n":1}', { contentType: 'application/json' }),
      file('report', ['{{dir}}/report.txt', 'files/pixel.png']),
      file('local', [], { localFiles: [join(outside, 'local.json')] }),
      text('skipped', 'x', { enabled: false })
    ]), opts());
    expect(r.result.outcome).toBe('http');
    expect(r.result.status).toBe(200);
    const e = echo(r);
    expect(e.contentLength).toBe(e.received);
    expect(e.parts).toEqual([
      { name: 'title', value: 'Quarterly report' },
      { name: 'meta', value: '{"n":1}' },
      { name: 'report', fileName: 'report.txt', size: readFileSync(join(collection, 'files', 'report.txt')).length, contentType: 'text/plain', sha256: sha(readFileSync(join(collection, 'files', 'report.txt'))) },
      { name: 'report', fileName: 'pixel.png', size: 10, contentType: 'image/png', sha256: sha(readFileSync(join(collection, 'files', 'pixel.png'))) },
      { name: 'local', fileName: 'local.json', size: readFileSync(join(outside, 'local.json')).length, contentType: 'application/json', sha256: sha(readFileSync(join(outside, 'local.json'))) }
    ]);
    const ct = r.result.hops!.at(-1)!.requestHeaders.find(([k]) => k.toLowerCase() === 'content-type')![1];
    expect(ct).toMatch(/^multipart\/form-data; boundary=----YeptFormBoundary[0-9a-f]{24}$/);
  });

  it('records field names, file names and sizes, never file contents', async () => {
    const r = await run(doc([text('title', 'hello'), file('report', ['files/report.txt']), file('local', [], { localFiles: [join(outside, 'local.json')] })]), opts());
    expect(r.result.requestBody).toBe([
      'multipart/form-data, 3 parts',
      'title: hello',
      `report: file report.txt (${readFileSync(join(collection, 'files', 'report.txt')).length} bytes, text/plain)`,
      `local: file local.json (${readFileSync(join(outside, 'local.json')).length} bytes, application/json)`
    ].join('\n'));
    const size = (p: string): number => readFileSync(p).length;
    expect(r.result.multipart?.map((p) => [p.name, p.type, p.fileName, p.size])).toEqual([
      ['title', 'text', undefined, undefined], ['report', 'file', 'report.txt', size(join(collection, 'files', 'report.txt'))], ['local', 'file', 'local.json', size(join(outside, 'local.json'))]
    ]);
    expect(r.result.multipart?.[1].path).toBe(join(collection, 'files', 'report.txt'));
    const visible = JSON.stringify({ ...r.result, body: null });
    expect(visible).not.toContain(SECRET_CONTENT);
    expect(JSON.stringify(redactResult(r.result, r.secrets))).not.toContain(SECRET_CONTENT);
    expect(JSON.stringify(r.sent)).not.toContain(SECRET_CONTENT);
  });

  it('replaces a Content-Type the request sets, so the boundary is always right', async () => {
    const r = await run(doc([text('a', '1')], { headers: [{ name: 'content-type', value: 'multipart/form-data', enabled: true }] }), opts());
    expect(echo(r).parts).toEqual([{ name: 'a', value: '1' }]);
  });

  it('masks secrets in text values but sends them', async () => {
    const r = await run(doc([text('apiKey', '{{key}}')]), opts({ layers: layers({ key: 'sk-multipart-secret' }) }));
    expect(echo(r).parts).toEqual([{ name: 'apiKey', value: 'sk-multipart-secret' }]);
    expect(r.result.requestBody).toContain('apiKey: ••••••');
    expect(r.result.multipart?.[0].value).toBe('••••••');
    expect(JSON.stringify(redactResult(r.result, r.secrets))).not.toContain('sk-multipart-secret');
    expect(r.sent?.form?.[0].value).toBe('sk-multipart-secret');
  });
});

describe('multipart: nothing is sent when a file is not usable', () => {
  const notSent = async (fields: MultipartField[]): Promise<string> => {
    const r = await run(doc(fields), opts());
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.hops).toBeUndefined();
    return r.result.error!.message;
  };

  it('a missing file names the field and the path', async () => {
    expect(await notSent([file('report', ['files/missing.pdf'])])).toBe('Multipart field "report": files/missing.pdf was not found');
  });

  it('a missing local file names its full path', async () => {
    const gone = join(outside, 'gone.bin');
    expect(await notSent([file('upload', [], { localFiles: [gone] })])).toBe(`Multipart field "upload": ${gone} was not found`);
  });

  it('a folder is not a file', async () => {
    expect(await notSent([file('report', ['files'])])).toBe('Multipart field "report": files is not a file');
  });

  it('a file field with no file chosen', async () => {
    expect(await notSent([file('report', [])])).toBe('Multipart field "report" has no file chosen on this computer');
  });

  it('an unresolved variable in a path or value', async () => {
    expect(await notSent([file('report', ['{{nowhere}}/a.txt'])])).toBe('Unresolved variable: nowhere');
    expect(await notSent([text('t', '{{missingValue}}')])).toBe('Unresolved variable: missingValue');
  });

  it('a missing file stops an OAuth2 request before any token is fetched', async () => {
    const tokens = async (): Promise<number> => (await (await fetch(`${base}/auth/stats`)).json()).tokenRequests;
    const before = await tokens();
    const d = doc([file('report', ['files/missing.pdf'])], {
      auth: { ...doc([]).auth, mode: 'oauth2', oauth2: { grantType: 'client_credentials', accessTokenUrl: `${base}/auth/token`, clientId: 'sample-client', clientSecret: 'sample-secret', scope: '', credentialsPlacement: 'basic_auth_header', tokenPlacement: 'header', tokenHeaderPrefix: 'Bearer', tokenQueryKey: 'access_token', autoFetchToken: true, autoRefreshToken: true } }
    });
    const r = await run(d, opts());
    expect(r.result.outcome).toBe('prepare_error');
    expect(await tokens()).toBe(before);
  });
});

describe('multipart: encoding', () => {
  it('writes part headers, content types and quoted names', async () => {
    const parts = await loadParts([
      { name: 'meta', type: 'text', value: '{"a":1}', path: '', contentType: 'application/json' },
      { name: 'odd "name"', type: 'text', value: 'x', path: '', contentType: '' },
      { name: 'f', type: 'file', value: '', path: 'files/report.txt', contentType: '' }
    ], collection);
    const enc = encodeMultipart(parts, 'BOUNDARY');
    const chunks: Buffer[] = [];
    for await (const c of enc.stream()) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    expect(body.length).toBe(enc.length);
    expect(enc.contentType).toBe('multipart/form-data; boundary=BOUNDARY');
    expect(body).toBe([
      '--BOUNDARY', 'Content-Disposition: form-data; name="meta"', 'Content-Type: application/json', '', '{"a":1}',
      '--BOUNDARY', 'Content-Disposition: form-data; name="odd %22name%22"', '', 'x',
      '--BOUNDARY', 'Content-Disposition: form-data; name="f"; filename="report.txt"', 'Content-Type: text/plain', '', `report ${SECRET_CONTENT}\n`,
      '--BOUNDARY--', ''
    ].join('\r\n'));
  });
});

describe('multipart: paths', () => {
  it('splits picked files into collection-relative paths and files kept on this computer', () => {
    const sibling = join(dir, 'ws', 'uploads-other', 'x.txt');
    expect(splitPickedFiles(collection, [join(collection, 'files', 'report.txt'), join(outside, 'local.json'), sibling, join(collection, '..x', 'y.txt')])).toEqual({
      files: ['files/report.txt', '..x/y.txt'],
      localFiles: [join(outside, 'local.json'), sibling]
    });
  });

  it('classifies saved paths', () => {
    expect(pathLocation('files/a.txt')).toBe('collection');
    expect(pathLocation('./a/../b.txt')).toBe('collection');
    expect(pathLocation('../shared/a.txt')).toBe('outside');
    expect(pathLocation('a/../../b.txt')).toBe('outside');
    expect(pathLocation('C:\\Users\\someone\\a.txt')).toBe('absolute');
    expect(pathLocation('/home/someone/a.txt')).toBe('absolute');
    expect(pathLocation('\\\\server\\share\\a.txt')).toBe('absolute');
    expect(pathLocation('{{dataDir}}/a.txt')).toBe('variable');
  });

  it('keys local files by field name and position among fields of that name', () => {
    const fields = [file('doc', []), text('t', ''), file('doc', [], { localFiles: ['C:\\b.pdf'] }), file('other', [], { localFiles: ['C:\\c.pdf'] })];
    expect(multipartKey(fields, 2)).toBe('doc#1');
    const map = localFileMap(fields);
    expect(map).toEqual({ 'doc#1': ['C:\\b.pdf'], 'other#0': ['C:\\c.pdf'] });
    // A new field above doesn't move the files to another field.
    const reloaded = withLocalFiles([text('new', ''), ...fields.map((f) => ({ ...f, localFiles: [] }))], map);
    expect(reloaded.map((f) => f.localFiles)).toEqual([[], [], [], ['C:\\b.pdf'], ['C:\\c.pdf']]);
  });

  it('the workspace keeps files outside the collection in the local store, not in the request file', async () => {
    await fs.writeFile(join(collection, 'opencollection.yml'), 'opencollection: 1.0.0\ninfo:\n  name: Uploads\n');
    const identity = new IdentityStore(join(dir, 'identity.db'));
    try {
      const ws = new Workspace(join(dir, 'ws'), identity, { trash: async () => {} });
      await ws.load();
      const id = await ws.createRequest(`collection:uploads`, 'Upload');
      const { doc: d } = ws.getRequest(id);
      const local = join(outside, 'local.json');
      await ws.saveRequest(id, { ...d, method: 'POST', body: { ...d.body, mode: 'multipartForm', multipartForm: [file('report', ['files/report.txt'], { localFiles: [local] })] } });
      const saved = readFileSync(join(collection, 'Upload.yml'), 'utf8');
      expect(saved).toContain('- files/report.txt');
      expect(saved).not.toContain('local.json');
      expect(saved).not.toContain(dir);
      expect(ws.getRequest(id).doc.body.multipartForm[0]).toMatchObject({ files: ['files/report.txt'], localFiles: [local] });
      // After a reload (a restart), and for a copy of the request.
      const again = new Workspace(join(dir, 'ws'), identity, { trash: async () => {} });
      await again.load();
      expect(again.getRequest(id).doc.body.multipartForm[0].localFiles).toEqual([local]);
      const copy = await again.duplicate(id);
      expect(again.getRequest(copy).doc.body.multipartForm[0].localFiles).toEqual([local]);
      // Removing the local file clears the store.
      const cur = again.getRequest(id).doc;
      await again.saveRequest(id, { ...cur, body: { ...cur.body, multipartForm: [{ ...cur.body.multipartForm[0], localFiles: [] }] } });
      expect(identity.localFiles(id)).toEqual({});
    } finally {
      identity.close();
    }
  });
});

describe('multipart: import', () => {
  const postman = {
    info: { name: 'Uploads', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Upload', request: { method: 'POST', url: 'https://api.example.test/upload', body: { mode: 'formdata', formdata: [
      { key: 'title', value: 'hello', type: 'text' },
      { key: 'doc', type: 'file', src: '/C:/Users/someone/report.pdf' },
      { key: 'rel', type: 'file', src: 'data/a.txt', contentType: 'text/plain' }
    ] } } }]
  };

  it('Postman: keeps relative paths, leaves absolute machine paths out and says so', async () => {
    const src = await convertSource(JSON.stringify(postman), 'uploads.postman_collection.json');
    const d = toRequestDoc(src.model.items[0]);
    expect(d.body.mode).toBe('multipartForm');
    expect(d.body.multipartForm.map((f) => [f.name, f.type, f.type === 'file' ? f.files : f.value, f.contentType])).toEqual([
      ['title', 'text', 'hello', ''], ['doc', 'file', [], ''], ['rel', 'file', ['data/a.txt'], 'text/plain']
    ]);
    expect(src.issues).toContain('"Upload", field "doc": report.pdf was a path on the computer it was exported from, so it isn\'t saved in the shared file. Choose the file again in the Body tab.');
    expect(src.issues.some((i) => i.startsWith('1 upload file path is kept relative to the collection folder'))).toBe(true);
    expect(stringifyRequestFile(src.model.items[0])).not.toContain('C:/Users');
  });

  it('Insomnia: file params come back as file fields', async () => {
    const insomnia = { _type: 'export', __export_format: 4, resources: [
      { _id: 'wrk_1', _type: 'workspace', name: 'Uploads' },
      { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'Upload', method: 'POST', url: 'https://api.example.test/upload', headers: [],
        body: { mimeType: 'multipart/form-data', params: [{ name: 'title', value: 'hi' }, { name: 'doc', type: 'file', fileName: 'C:\\Users\\someone\\report.pdf' }, { name: 'rel', type: 'file', fileName: 'data/b.txt' }] } }
    ] };
    const src = await convertSource(JSON.stringify(insomnia), 'insomnia.json');
    const d = toRequestDoc(src.model.items[0]);
    expect(d.body.multipartForm.map((f) => [f.name, f.type, f.type === 'file' ? f.files : f.value])).toEqual([['title', 'text', 'hi'], ['doc', 'file', []], ['rel', 'file', ['data/b.txt']]]);
    expect(src.issues.some((i) => i.includes('"Upload", field "doc": report.pdf'))).toBe(true);
  });
});
