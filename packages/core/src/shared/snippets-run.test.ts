// Runs the code "Copy as" writes against the fixture server and checks what arrived. fetch and axios run on Node;
// Python, PowerShell 7 and C# (.NET 10, as a file-based app) run only where they are installed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer } from '../../../../fixtures/server/server.mjs';
import type { CurlRequest } from './curl';
import { toSnippet, type SnippetLanguage } from './snippets';

const ROOT = resolve(__dirname, '../../../..');
let server: Server;
let base = '';
let dir = '';
const FILE_BYTES = Buffer.from('fake png bytes \u00e9\u00e8 \x00\x01\x02');

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'yept-snippets-'));
  writeFileSync(join(dir, 'scan.png'), FILE_BYTES);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', fail);
    child.on('close', (code) => code === 0 ? done(out) : fail(new Error(`${command} exited with ${code}\n${err}\n${out}`)));
    child.stdin.end(input ?? '');
  });
}

const has = (command: string, args: string[]): boolean => {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return r.status === 0;
};
const python = ['python3', 'python'].find((p) => has(p, ['-c', 'import requests']));
const pwsh = has('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
const dotnet10 = (() => {
  const r = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.split('\n').some((l) => Number(l.split('.')[0]) >= 10 && !/preview|rc/.test(l));
})();

/** The last line of output that is JSON: what the server sent back. */
const lastJson = (out: string): Record<string, any> => JSON.parse(out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop()!);

let n = 0;
async function runSnippet(language: SnippetLanguage, r: CurlRequest): Promise<Record<string, any>> {
  const code = toSnippet(language, r);
  if (language === 'fetch' || language === 'axios') {
    // response.data is an object for axios: print it as JSON.
    const print = 'console.log = (...a) => process.stdout.write(a.map((x) => typeof x === \'string\' ? x : JSON.stringify(x)).join(\' \') + \'\\n\');\n';
    return lastJson(await run(process.execPath, ['--input-type=module'], print + code));
  }
  if (language === 'python') return lastJson(await run(python!, ['-'], code));
  const file = join(dir, `snippet${++n}.ps1`);
  writeFileSync(file, `\ufeff[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n& {\n${code}\n} | ConvertTo-Json -Depth 10 -Compress\n`);
  return lastJson(await run('pwsh', ['-NoProfile', '-NonInteractive', '-File', file]));
}

const HEADER = `say "hi" it's $HOME C:\\temp\\new`;
const cases = (): Record<string, [CurlRequest, (echo: Record<string, any>) => void]> => ({
  'GET with a query and awkward header values': [
    { method: 'GET', url: `${base}/echo?status=open&q=a%20b&city=Z%C3%BCrich`, headers: [['Host', 'x'], ['Accept', 'application/json'], ['X-Note', HEADER], ['X-Tag', 'a'], ['X-Tag', 'b']] },
    (e) => {
      expect(e.method).toBe('GET');
      expect(e.query).toEqual({ status: 'open', q: 'a b', city: 'Zürich' });
      expect(e.headers['x-note']).toBe(HEADER);
      expect(e.headers['x-tag']).toBe('a, b');
      expect(e.headers.accept).toBe('application/json');
    }
  ],
  'JSON POST with non-ASCII text': [
    { method: 'POST', url: `${base}/echo`, headers: [['Content-Type', 'application/json'], ['Content-Length', '99'], ['Accept-Encoding', 'gzip']], body: '{ "traveller": "Zoë O\'Brien", "note": "$5 \\\\ \\"ok\\"" }\n' },
    (e) => {
      expect(e.method).toBe('POST');
      expect(e.headers['content-type']).toBe('application/json');
      expect(e.body).toBe('{ "traveller": "Zoë O\'Brien", "note": "$5 \\\\ \\"ok\\"" }\n');
    }
  ],
  'form body': [
    { method: 'PATCH', url: `${base}/echo`, headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'grant_type=client_credentials&scope=read+write&x=%26' },
    (e) => {
      expect(e.method).toBe('PATCH');
      expect(e.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(e.body).toBe('grant_type=client_credentials&scope=read+write&x=%26');
    }
  ],
  // Node sends header values as Latin-1; the snippets do the same. Not PowerShell: .NET refuses them there.
  'a non-ASCII header value': [
    { method: 'GET', url: `${base}/echo`, headers: [['X-City', 'Zürich']] },
    (e) => expect(e.headers['x-city']).toBe('Zürich')
  ],
  'multipart with a file': [
    {
      method: 'POST', url: `${base}/upload`, headers: [['Content-Type', 'multipart/form-data; boundary=x'], ['Accept', '*/*']], body: 'multipart/form-data, 2 parts',
      form: [
        { name: 'title', type: 'text', value: 'Trip "notes" $1 \\ Zürich', contentType: '' },
        { name: 'scan', type: 'file', fileName: 'scan.png', path: join(dir, 'scan.png'), size: FILE_BYTES.length, contentType: '' }
      ]
    },
    (e) => {
      expect(e.parts[0]).toEqual({ name: 'title', value: 'Trip "notes" $1 \\ Zürich' });
      expect(e.parts[1]).toMatchObject({ name: 'scan', fileName: 'scan.png', size: FILE_BYTES.length });
    }
  ]
});

describe.each([
  ['fetch', true],
  ['axios', true],
  ['python', !!python],
  ['powershell', pwsh]
] as [SnippetLanguage, boolean][])('%s snippets against the fixture server', (language, available) => {
  const names = Object.keys(cases()).filter((name) => language !== 'powershell' || name !== 'a non-ASCII header value');
  it.skipIf(!available).each(names)('%s', async (name) => {
    const [request, check] = cases()[name];
    check(await runSnippet(language, request));
  }, 60_000);
});

// One program for all the C# cases, so it builds once.
it.skipIf(!dotnet10)('C# snippets against the fixture server', async () => {
  const all = Object.values(cases());
  const usings = new Set<string>();
  const blocks = all.map(([r]) => {
    const lines = toSnippet('csharp', r).split('\n');
    for (const l of lines.filter((l) => l.startsWith('using System'))) usings.add(l);
    return `{\n${lines.filter((l) => !l.startsWith('using System')).join('\n')}\n}`;
  });
  const file = join(dir, 'snippets.cs');
  writeFileSync(file, [...usings, 'Console.OutputEncoding = System.Text.Encoding.UTF8;', ...blocks].join('\n'));
  const out = (await run('dotnet', ['run', file])).trim().split(/\r?\n/).filter((l) => l.startsWith('{'));
  expect(out).toHaveLength(all.length);
  all.forEach(([, check], i) => check(JSON.parse(out[i])));
}, 300_000);
