import { describe, expect, it } from 'vitest';
import type { CurlRequest } from './curl';
import { isSnippetLanguage, SNIPPET_LANGUAGES, toSnippet, type SnippetLanguage } from './snippets';

const GET: CurlRequest = {
  method: 'GET',
  url: 'https://api.example.test/bookings?status=open&q=a%20b',
  headers: [['Host', 'api.example.test'], ['Accept', 'application/json'], ['Connection', 'keep-alive']]
};

const JSON_POST: CurlRequest = {
  method: 'POST',
  url: 'https://api.example.test/bookings',
  headers: [['Content-Type', 'application/json'], ['Content-Length', '41'], ['Accept-Encoding', 'gzip, deflate, br']],
  body: '{"traveller":"Alex Example","seats":2}'
};

const FORM: CurlRequest = {
  method: 'POST',
  url: 'https://api.example.test/token',
  headers: [['Content-Type', 'application/x-www-form-urlencoded']],
  body: 'grant_type=client_credentials&scope=read+write'
};

const MULTIPART: CurlRequest = {
  method: 'POST',
  url: 'https://api.example.test/upload',
  headers: [['Content-Type', 'multipart/form-data; boundary=----YeptFormBoundaryabc'], ['Accept', '*/*']],
  body: 'multipart/form-data, 2 parts',
  form: [
    { name: 'title', type: 'text', value: 'Trip notes', contentType: '' },
    { name: 'scan', type: 'file', fileName: 'scan.png', path: 'C:\\Users\\someone\\scan.png', size: 10, contentType: 'image/png' }
  ]
};

/** Quotes, $, backslashes and non-ASCII text, in a header and in the body. */
const TRICKY = `say "hi" it's $HOME C:\\temp\\new Zürich`;
const TRICKY_REQ: CurlRequest = {
  method: 'PUT',
  url: 'https://api.example.test/notes/1',
  headers: [['X-Note', TRICKY], ['Content-Type', 'text/plain']],
  body: TRICKY
};

const MASKED: CurlRequest = {
  method: 'POST',
  url: 'https://api.example.test/login?key=••••••',
  headers: [['Authorization', 'Bearer ••••••'], ['Cookie', 'sid=••••••'], ['Content-Type', 'application/json']],
  body: '{"password":"••••••"}'
};

const others = SNIPPET_LANGUAGES.map((l) => l.id).filter((l) => l !== 'curl');

describe('toSnippet', () => {
  it('knows its languages', () => {
    expect(SNIPPET_LANGUAGES.map((l) => l.id)).toEqual(['curl', 'csharp', 'powershell', 'fetch', 'axios', 'python']);
    expect(isSnippetLanguage('python')).toBe(true);
    expect(isSnippetLanguage('ruby')).toBe(false);
    expect(() => toSnippet('ruby' as SnippetLanguage, GET)).toThrow('Unknown language');
  });

  it('gives cURL exactly as Copy as cURL does', () => {
    expect(toSnippet('curl', GET)).toBe(["curl 'https://api.example.test/bookings?status=open&q=a%20b'", "-H 'Accept: application/json'"].join(' \\\n  '));
  });

  it.each(others)('%s: leaves out the headers the library sets itself', (language) => {
    for (const r of [GET, JSON_POST]) expect(toSnippet(language, r)).not.toMatch(/Host|Connection|Content-Length|Accept-Encoding/);
  });

  it.each(others)('%s: masked values stay masked', (language) => {
    const s = toSnippet(language, MASKED);
    expect(s.match(/••••••/g)).toHaveLength(4);
    // A masked header is not a reason to change how headers are encoded.
    expect(s).not.toMatch(/Latin1|ASCII header/);
  });

  it.each(others)('%s: joins repeated headers', (language) => {
    const s = toSnippet(language, { method: 'GET', url: 'https://api.example.test/', headers: [['Cookie', 'a=1'], ['X-Tag', 'x'], ['cookie', 'b=2'], ['X-Tag', 'y']] });
    expect(s).toContain('a=1; b=2');
    expect(s).toContain('x, y');
  });
});

describe('C# HttpClient', () => {
  it('GET with a query', () => {
    expect(toSnippet('csharp', GET)).toBe([
      'using System.Net.Http;',
      '',
      'using var client = new HttpClient();',
      'using var request = new HttpRequestMessage(new HttpMethod("GET"), "https://api.example.test/bookings?status=open&q=a%20b");',
      'request.Headers.TryAddWithoutValidation("Accept", "application/json");',
      '',
      'using var response = await client.SendAsync(request);',
      'Console.WriteLine((int)response.StatusCode);',
      'Console.WriteLine(await response.Content.ReadAsStringAsync());'
    ].join('\n'));
  });

  it('JSON POST: the body with its own Content-Type, and decompression for Accept-Encoding', () => {
    const s = toSnippet('csharp', JSON_POST);
    expect(s).toContain('using System.Net;');
    expect(s).toContain('AutomaticDecompression = DecompressionMethods.All');
    expect(s).toContain('request.Content = new StringContent(@"{""traveller"":""Alex Example"",""seats"":2}");\nrequest.Content.Headers.ContentType = null;\nrequest.Content.Headers.TryAddWithoutValidation("Content-Type", "application/json");');
  });

  it('form body', () => {
    expect(toSnippet('csharp', FORM)).toContain('new StringContent("grant_type=client_credentials&scope=read+write");');
  });

  it('multipart with a file', () => {
    const s = toSnippet('csharp', MULTIPART);
    expect(s).toContain([
      'var form = new MultipartFormDataContent();',
      'var part1 = new StringContent("Trip notes");',
      'part1.Headers.ContentType = null;',
      'form.Add(part1, "title");',
      'var part2 = new StreamContent(File.OpenRead(@"C:\\Users\\someone\\scan.png"));',
      'part2.Headers.TryAddWithoutValidation("Content-Type", "image/png");',
      'form.Add(part2, "scan", "scan.png");',
      'request.Content = form;'
    ].join('\n'));
    expect(s).not.toContain('multipart/form-data');
  });

  it('verbatim strings for quotes, $ and backslashes; Latin-1 for non-ASCII header values', () => {
    const s = toSnippet('csharp', TRICKY_REQ);
    expect(s).toContain('request.Headers.TryAddWithoutValidation("X-Note", @"say ""hi"" it\'s $HOME C:\\temp\\new Zürich");');
    expect(s).toContain('RequestHeaderEncodingSelector = (_, _) => Encoding.Latin1');
  });

  it('escapes control characters instead of writing them raw', () => {
    const s = toSnippet('csharp', { method: 'POST', url: 'https://api.example.test/', headers: [], body: 'a\r\nb\t"c"\\' });
    expect(s).toContain('new StringContent("a\\r\\nb\\t\\"c\\"\\\\");');
  });

  it('keeps content headers off a request without a body', () => {
    expect(toSnippet('csharp', { method: 'GET', url: 'https://api.example.test/', headers: [['Content-Type', 'application/json']] })).toContain('// Left out, as there is no body: Content-Type: application/json');
  });
});

describe('PowerShell', () => {
  it('GET with a query', () => {
    expect(toSnippet('powershell', GET)).toBe([
      '$headers = [ordered]@{',
      "  'Accept' = 'application/json'",
      '}',
      '$params = @{',
      "  Method = 'Get'",
      "  Uri = 'https://api.example.test/bookings?status=open&q=a%20b'",
      '  Headers = $headers',
      '}',
      'Invoke-RestMethod @params'
    ].join('\n'));
  });

  it('JSON POST uses -ContentType and -Body', () => {
    const s = toSnippet('powershell', JSON_POST);
    expect(s).toContain("ContentType = 'application/json'");
    expect(s).toContain(`Body = '{"traveller":"Alex Example","seats":2}'`);
    expect(s).not.toContain('$headers');
  });

  it('form body, and the User-Agent through -UserAgent', () => {
    const s = toSnippet('powershell', { ...FORM, headers: [...FORM.headers, ['User-Agent', 'Yept/1.0']] });
    expect(s).toContain("Body = 'grant_type=client_credentials&scope=read+write'");
    expect(s).toContain("UserAgent = 'Yept/1.0'");
  });

  it('multipart with -Form, and says what PowerShell 5.1 and -Form can not do', () => {
    const s = toSnippet('powershell', MULTIPART);
    expect(s).toContain("# -Form needs PowerShell 7 or later. Windows PowerShell 5.1 can't send a multipart form with Invoke-RestMethod.");
    expect(s).toContain('# -Form sends "scan" as application/octet-stream; it was sent as image/png.');
    expect(s).toContain(["$form = [ordered]@{", "  'title' = 'Trip notes'", "  'scan' = (Get-Item -LiteralPath 'C:\\Users\\someone\\scan.png')", '}'].join('\n'));
    expect(s).toContain('Form = $form');
    expect(s).not.toContain('ContentType');
  });

  it('repeated fields go as a list', () => {
    const s = toSnippet('powershell', { ...MULTIPART, form: [MULTIPART.form![1], { ...MULTIPART.form![1], path: 'D:\\b.png', fileName: 'b.png' }] });
    expect(s).toContain("'scan' = @((Get-Item -LiteralPath 'C:\\Users\\someone\\scan.png'), (Get-Item -LiteralPath 'D:\\b.png'))");
  });

  it('single quotes: nothing expands, quotes doubled; UTF-8 bytes for a non-ASCII body', () => {
    const s = toSnippet('powershell', TRICKY_REQ);
    expect(s).toContain(`'X-Note' = 'say "hi" it''s $HOME C:\\temp\\new Zürich'`);
    expect(s).toContain(`Body = [System.Text.Encoding]::UTF8.GetBytes('say "hi" it''s $HOME C:\\temp\\new Zürich')`);
    expect(s).toContain('# .NET sends only ASCII header values');
    expect(s).toContain("Method = 'Put'");
  });

  it('doubles curly single quotes too, and escapes control characters in double quotes', () => {
    expect(toSnippet('powershell', { method: 'GET', url: 'https://api.example.test/', headers: [['X-A', 'it\u2019s']] })).toContain("'X-A' = 'it\u2019\u2019s'");
    expect(toSnippet('powershell', { method: 'POST', url: 'https://api.example.test/', headers: [], body: 'a\r\n$b"`' })).toContain('Body = "a`r`n`$b`"``"');
  });

  it('other methods through -CustomMethod', () => {
    expect(toSnippet('powershell', { method: 'PROPFIND', url: 'https://api.example.test/', headers: [] })).toContain("CustomMethod = 'PROPFIND'");
  });
});

describe('JavaScript fetch', () => {
  it('GET with a query', () => {
    expect(toSnippet('fetch', GET)).toBe([
      "const response = await fetch('https://api.example.test/bookings?status=open&q=a%20b', {",
      '  headers: {',
      "    'Accept': 'application/json'",
      '  }',
      '});',
      '',
      'console.log(response.status);',
      'console.log(await response.text());'
    ].join('\n'));
    expect(toSnippet('fetch', { method: 'GET', url: 'https://api.example.test/', headers: [] })).toMatch(/^const response = await fetch\('https:\/\/api.example.test\/'\);/);
  });

  it('JSON POST and form bodies as strings', () => {
    expect(toSnippet('fetch', JSON_POST)).toContain(`  method: 'POST',\n  headers: {\n    'Content-Type': 'application/json'\n  },\n  body: '{"traveller":"Alex Example","seats":2}'\n});`);
    expect(toSnippet('fetch', FORM)).toContain("body: 'grant_type=client_credentials&scope=read+write'");
  });

  it('multipart with a file read by openAsBlob', () => {
    const s = toSnippet('fetch', MULTIPART);
    expect(s.startsWith("import { openAsBlob } from 'node:fs';")).toBe(true);
    expect(s).toContain("form.append('title', 'Trip notes');");
    expect(s).toContain("form.append('scan', await openAsBlob('C:\\\\Users\\\\someone\\\\scan.png', { type: 'image/png' }), 'scan.png');");
    expect(s).toContain('body: form');
    expect(s).not.toContain('multipart/form-data');
  });

  it('string literals with quotes, $, backslashes and non-ASCII', () => {
    expect(toSnippet('fetch', TRICKY_REQ)).toContain(`'X-Note': 'say "hi" it\\'s $HOME C:\\\\temp\\\\new Zürich'`);
    expect(toSnippet('fetch', { method: 'POST', url: 'https://api.example.test/', headers: [], body: "it's\n" })).toContain(`body: "it's\\n"`);
  });

  it('says when a GET body can not be sent', () => {
    expect(toSnippet('fetch', { method: 'GET', url: 'https://api.example.test/', headers: [], body: 'x' })).toContain("// fetch can't send a body with GET");
  });
});

describe('JavaScript axios', () => {
  it('GET with a query', () => {
    expect(toSnippet('axios', GET)).toBe([
      "import axios from 'axios';",
      '',
      'const response = await axios.request({',
      "  method: 'get',",
      "  url: 'https://api.example.test/bookings?status=open&q=a%20b',",
      '  headers: {',
      "    'Accept': 'application/json'",
      '  }',
      '});',
      '',
      'console.log(response.status);',
      'console.log(response.data);'
    ].join('\n'));
  });

  it('JSON POST keeps the body as written', () => {
    const s = toSnippet('axios', JSON_POST);
    expect(s).toContain(`data: '{"traveller":"Alex Example","seats":2}'`);
    expect(s).toContain('transformRequest: [(data) => data]');
    expect(toSnippet('axios', FORM)).not.toContain('transformRequest');
  });

  it('multipart with a file', () => {
    const s = toSnippet('axios', MULTIPART);
    expect(s).toContain("import { openAsBlob } from 'node:fs';");
    expect(s).toContain("form.append('scan', await openAsBlob('C:\\\\Users\\\\someone\\\\scan.png', { type: 'image/png' }), 'scan.png');");
    expect(s).toContain('data: form');
  });

  it('string literals with quotes, $, backslashes and non-ASCII', () => {
    expect(toSnippet('axios', TRICKY_REQ)).toContain(`data: 'say "hi" it\\'s $HOME C:\\\\temp\\\\new Zürich'`);
  });
});

describe('Python requests', () => {
  it('GET with a query', () => {
    expect(toSnippet('python', GET)).toBe([
      'import requests',
      '',
      "url = 'https://api.example.test/bookings?status=open&q=a%20b'",
      'headers = {',
      "    'Accept': 'application/json',",
      '}',
      '',
      "response = requests.request('GET', url, headers=headers)",
      'print(response.status_code)',
      'print(response.text)'
    ].join('\n'));
  });

  it('JSON POST and form bodies', () => {
    expect(toSnippet('python', JSON_POST)).toContain(`data = '{"traveller":"Alex Example","seats":2}'\n\nresponse = requests.request('POST', url, headers=headers, data=data)`);
    expect(toSnippet('python', FORM)).toContain("data = 'grant_type=client_credentials&scope=read+write'");
  });

  it('multipart with a file', () => {
    expect(toSnippet('python', MULTIPART)).toContain([
      'files = [',
      "    ('title', (None, 'Trip notes')),",
      "    ('scan', ('scan.png', open('C:\\\\Users\\\\someone\\\\scan.png', 'rb'), 'image/png')),",
      ']',
      '',
      "response = requests.request('POST', url, headers=headers, files=files)"
    ].join('\n'));
  });

  it('string literals with quotes, $, backslashes and non-ASCII; UTF-8 for a non-ASCII body', () => {
    const s = toSnippet('python', TRICKY_REQ);
    expect(s).toContain(`'X-Note': 'say "hi" it\\'s $HOME C:\\\\temp\\\\new Zürich',`);
    expect(s).toContain("data=data.encode('utf-8')");
  });
});
