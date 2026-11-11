import { describe, expect, it } from 'vitest';
import { CurlParseError, curlRequestName, parseCurl, requestFromCurl, toCurl, type CurlRequest, type ParsedCurl } from './curl';
import { emptyAuth, type RequestDoc } from './model';

describe('toCurl', () => {
  it('builds a GET with headers, leaving out the ones curl sets', () => {
    const c = toCurl({ method: 'GET', url: 'https://api.example.test/a?b=1', headers: [['Host', 'api.example.test'], ['Accept', '*/*'], ['Accept-Encoding', 'gzip'], ['Connection', 'keep-alive']] });
    expect(c).toBe(["curl 'https://api.example.test/a?b=1'", "-H 'Accept: */*'", '--compressed'].join(' \\\n  '));
  });

  it('quotes single quotes and sends the body as-is', () => {
    const c = toCurl({ method: 'POST', url: 'https://api.example.test/', headers: [['Content-Type', 'application/json'], ['Content-Length', '20']], body: `{"name":"O'Brien"}` });
    expect(c).toContain('-X POST');
    expect(c).toContain(`--data-raw '{"name":"O'\\''Brien"}'`);
    expect(c).not.toContain('Content-Length');
  });

  it('sends multipart parts with -F, leaving the Content-Type and boundary to curl', () => {
    const c = toCurl(MULTIPART);
    expect(c.split(' \\\n  ')).toEqual([
      "curl -X POST 'https://api.example.test/upload'",
      "-H 'Accept: */*'",
      `--form-string 'title=@not-a-file O'\\''Brien'`,
      `-F 'meta="{\\"a\\":\\"b;c\\"}";type=application/json'`,
      `-F 'report=@"C:\\\\Users\\\\someone\\\\report \\"v2\\".pdf";filename="report \\"v2\\".pdf";type=application/pdf'`,
      `-F 'pic=@"/tmp/p.png";filename="p.png"'`
    ]);
  });
});

const MULTIPART: CurlRequest = {
  method: 'POST',
  url: 'https://api.example.test/upload',
  headers: [['Content-Type', 'multipart/form-data; boundary=----YeptFormBoundaryabc'], ['Content-Length', '512'], ['Accept', '*/*']],
  body: 'multipart/form-data, 4 parts',
  form: [
    { name: 'title', type: 'text', value: "@not-a-file O'Brien", contentType: '' },
    { name: 'meta', type: 'text', value: '{"a":"b;c"}', contentType: 'application/json' },
    { name: 'report', type: 'file', fileName: 'report "v2".pdf', path: 'C:\\Users\\someone\\report "v2".pdf', size: 10, contentType: 'application/pdf' },
    { name: 'pic', type: 'file', fileName: 'p.png', path: '/tmp/p.png', size: 1, contentType: '' }
  ]
};

const text = (name: string, value: string, contentType = ''): object => ({ name, type: 'text', value, files: [], localFiles: [], contentType, enabled: true });
const file = (name: string, path: string, contentType = ''): object => ({ name, type: 'file', value: '', files: [], localFiles: [path], contentType, enabled: true });
const field = (name: string, value: string): object => ({ name, value, enabled: true });

interface Case {
  name: string;
  command: string;
  expected: Partial<Record<keyof ParsedCurl, unknown>>;
  /** Each pattern must match one of the notes; no pattern means no notes at all. */
  notes?: RegExp[];
}

// Synthetic commands in the forms people paste: hand-written, from API docs, and from browser dev tools (bash and cmd).
const CORPUS: Case[] = [
  {
    name: 'plain GET',
    command: 'curl https://api.example.test/users',
    expected: { method: 'GET', url: 'https://api.example.test/users', headers: [], body: { mode: 'none' }, auth: undefined, settings: {} }
  },
  {
    name: 'GET with a query, a header and joined switches',
    command: `curl -sSL 'https://api.example.test/users?page=2&limit=10' -H 'Accept: application/json'`,
    expected: { method: 'GET', url: 'https://api.example.test/users?page=2&limit=10', headers: [['Accept', 'application/json']], settings: { followRedirects: true } },
    notes: [/only change curl's own output.*-s, -S/]
  },
  {
    name: 'POST JSON over several lines',
    command: `curl -X POST https://api.example.test/bookings \\\n  -H 'Content-Type: application/json' \\\n  -d '{"traveller":"Alex Example","destination":"Oslo"}'`,
    expected: { method: 'POST', headers: [['Content-Type', 'application/json']], body: { mode: 'json', json: '{"traveller":"Alex Example","destination":"Oslo"}' } }
  },
  {
    name: '--json sets the JSON headers',
    command: `curl --json '{"a":1}' https://api.example.test/items`,
    expected: { method: 'POST', headers: [['Content-Type', 'application/json'], ['Accept', 'application/json']], body: { mode: 'json', json: '{"a":1}' } }
  },
  {
    name: '-d without a Content-Type is a form, decoded into fields',
    command: `curl https://api.example.test/token -d 'grant_type=client_credentials&scope=read%20write' -d 'note=a+b'`,
    expected: { method: 'POST', headers: [], body: { mode: 'formUrlEncoded', formUrlEncoded: [field('grant_type', 'client_credentials'), field('scope', 'read write'), field('note', 'a b')] } }
  },
  {
    name: '-d that is not name=value stays text, sent as curl sends it',
    command: `curl https://api.example.test/items -d '{"a":1}'`,
    expected: { method: 'POST', headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: { mode: 'text', text: '{"a":1}' } }
  },
  {
    name: '-G moves the data, URL-encoded, into the query',
    command: `curl -G https://api.example.test/search --data-urlencode 'q=café & co' -d limit=5`,
    expected: { method: 'GET', url: 'https://api.example.test/search?q=caf%C3%A9%20%26%20co&limit=5', body: { mode: 'none' } }
  },
  {
    name: '-u is basic auth; the password may contain colons',
    command: `curl -u 'alex:pa:ss' https://api.example.test/me`,
    expected: { method: 'GET', auth: { mode: 'basic', username: 'alex', password: 'pa:ss' }, headers: [], credentials: ['the -u password'] }
  },
  {
    name: '-u without a password',
    command: 'curl --user alex https://api.example.test/me',
    expected: { auth: { mode: 'basic', username: 'alex', password: '' }, credentials: [] },
    notes: [/no password/]
  },
  {
    name: '--oauth2-bearer is bearer auth',
    command: 'curl --oauth2-bearer test-token-123 https://api.example.test/me',
    expected: { auth: { mode: 'bearer', token: 'test-token-123' }, credentials: ['the bearer token'] }
  },
  {
    name: 'an Authorization header stays a header',
    command: `curl https://api.example.test/me -H 'Authorization: Bearer test.token.value' -H 'X-Api-Key: test-key'`,
    expected: { auth: undefined, headers: [['Authorization', 'Bearer test.token.value'], ['X-Api-Key', 'test-key']], credentials: ['the Authorization header', 'the X-Api-Key header'] }
  },
  {
    name: 'multipart text and file parts, dropping the stale multipart Content-Type',
    command: `curl https://api.example.test/upload -H 'Content-Type: multipart/form-data; boundary=x' -F 'title=Quarterly report' -F 'file=@/home/alex/report.pdf;type=application/pdf'`,
    expected: { method: 'POST', headers: [], body: { mode: 'multipartForm', multipartForm: [text('title', 'Quarterly report'), file('file', '/home/alex/report.pdf', 'application/pdf')] } },
    notes: [/Content-Type header is left out/]
  },
  {
    name: '--form-string never reads files; -F text can carry a type',
    command: `curl https://api.example.test/upload --form-string 'note=@not-a-file' -F 'meta={"k":"v"};type=application/json'`,
    expected: { body: { mode: 'multipartForm', multipartForm: [text('note', '@not-a-file'), text('meta', '{"k":"v"}', 'application/json')] } }
  },
  {
    name: '-F name=<file is reported and left empty',
    command: `curl https://api.example.test/upload -F 'bio=<bio.txt'`,
    expected: { body: { mode: 'multipartForm', multipartForm: [text('bio', '')] } },
    notes: [/reads the value from a file/]
  },
  {
    name: '-I is HEAD',
    command: 'curl -I https://api.example.test/health',
    expected: { method: 'HEAD', body: { mode: 'none' } }
  },
  {
    name: 'DELETE with an attached method and header',
    command: `curl -XDELETE -H'X-Request-Id: 42' https://api.example.test/bookings/7`,
    expected: { method: 'DELETE', url: 'https://api.example.test/bookings/7', headers: [['X-Request-Id', '42']] }
  },
  {
    name: 'Chrome "Copy as cURL (bash)" with $\'…\' and --compressed',
    command: [
      "curl 'https://api.example.test/notes' \\",
      "  -H 'accept: */*' \\",
      "  -H 'content-type: application/json' \\",
      "  -b 'session=test-session; theme=dark' \\",
      `  --data-raw $'{"text":"line one\\\\nline two","name":"Zo\\u00eb","q":"it\\'s"}' \\`,
      '  --compressed'
    ].join('\n'),
    expected: {
      method: 'POST',
      headers: [['accept', '*/*'], ['content-type', 'application/json'], ['Cookie', 'session=test-session; theme=dark'], ['Accept-Encoding', 'gzip, deflate, br']],
      body: { mode: 'json', json: `{"text":"line one\\nline two","name":"Zoë","q":"it's"}` },
      credentials: ['the Cookie header']
    }
  },
  {
    name: 'Chrome "Copy as cURL (cmd)" with ^ escapes and a line break in the body',
    command: [
      'curl ^"https://api.example.test/notes?a=1^&b=2^" ^',
      '  -H ^"content-type: text/plain^" ^',
      '  --data-raw ^"line ^\\^"one^\\^"^',
      '',
      'line two 100^%^" ^',
      '  --compressed'
    ].join('\r\n'),
    expected: {
      method: 'POST',
      url: 'https://api.example.test/notes?a=1&b=2',
      headers: [['content-type', 'text/plain'], ['Accept-Encoding', 'gzip, deflate, br']],
      body: { mode: 'text', text: 'line "one"\nline two 100%' }
    }
  },
  {
    name: 'double-quoted bash with escapes',
    command: `curl -X POST "https://api.example.test/items" -H "Content-Type: application/json" -d "{\\"name\\":\\"O'Brien\\",\\"cost\\":\\"\\$5\\"}"`,
    expected: { method: 'POST', body: { mode: 'json', json: `{"name":"O'Brien","cost":"$5"}` } }
  },
  {
    name: 'XML body',
    command: `curl https://api.example.test/soap -H 'Content-Type: text/xml; charset=utf-8' --data-binary '<Envelope><Body/></Envelope>'`,
    expected: { method: 'POST', body: { mode: 'xml', xml: '<Envelope><Body/></Envelope>' } }
  },
  {
    name: 'User-Agent, Referer, an empty header and a removed one',
    command: `curl https://api.example.test/ -A 'TestAgent/1.0' -e 'https://www.example.test/;auto' -H 'X-Empty;' -H 'Accept:'`,
    expected: { headers: [['User-Agent', 'TestAgent/1.0'], ['Referer', 'https://www.example.test/'], ['X-Empty', '']] },
    notes: [/removes a header curl adds itself/]
  },
  {
    name: 'Content-Length is left out',
    command: `curl https://api.example.test/items -H 'Content-Type: application/json' -H 'Content-Length: 7' -d '{"a":1}'`,
    expected: { headers: [['Content-Type', 'application/json']] },
    notes: [/Content-Length header is left out/]
  },
  {
    name: 'redirect and timeout settings',
    command: 'curl --location-trusted --max-redirs 3 -m 2.5 https://api.example.test/r',
    expected: { settings: { followRedirects: true, forwardAuthorizationHeader: true, maxRedirects: 3, timeoutMs: 2500 } }
  },
  {
    name: 'options with no per-request setting are reported',
    command: 'curl -k --cert client.pem -x http://proxy.example.test:8080 --digest -o out.json --frobnicate -c jar.txt https://api.example.test/',
    expected: { method: 'GET', url: 'https://api.example.test/', headers: [] },
    notes: [/-k is not imported: TLS/, /--cert is not imported: client certificates/, /-x is not imported: set a proxy in Settings/, /--digest is not imported/, /-c is not imported: cookies/, /output.*-o/, /Not recognised.*--frobnicate/]
  },
  {
    name: 'file-reading options are reported, never read',
    command: `curl https://api.example.test/items -d @body.json -H @headers.txt -b cookies.txt`,
    expected: { method: 'POST', headers: [], body: { mode: 'none' } },
    notes: [/-d @body.json reads the body from a file/, /-H @headers.txt reads headers from a file/, /-b cookies.txt reads cookies from a file/]
  },
  {
    name: 'a pipe ends the command',
    command: `curl -s https://api.example.test/users | jq '.[0]'`,
    expected: { url: 'https://api.example.test/users' },
    notes: [/Everything from "\|"/, /-s/]
  },
  {
    name: 'an unsupported method is reported',
    command: 'curl -X PROPFIND https://api.example.test/dav/',
    expected: { method: 'GET' },
    notes: [/PROPFIND is not supported/]
  },
  {
    name: 'a prompt, curl.exe, variables and no scheme',
    command: '$ curl.exe "{{baseUrl}}/users/{{userId}}" -H "Authorization: Bearer {{token}}"',
    expected: { url: '{{baseUrl}}/users/{{userId}}', headers: [['Authorization', 'Bearer {{token}}']] }
  }
];

describe('parseCurl', () => {
  it('has a corpus of at least 20 commands', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of CORPUS) {
    it(c.name, () => {
      const parsed = parseCurl(c.command);
      expect(parsed).toMatchObject(c.expected);
      if (!c.notes) expect(parsed.notes).toEqual([]);
      for (const n of c.notes ?? []) expect(parsed.notes.some((x) => n.test(x)), `${n} in ${JSON.stringify(parsed.notes)}`).toBe(true);
    });
  }

  it.each([
    ['wget https://api.example.test/', /not a curl command/],
    [`curl -H 'Accept: */*'`, /no URL/],
    [`curl 'https://api.example.test/`, /quote/],
    ['curl ^"https://api.example.test/', /quote/],
    ['curl https://api.example.test/a --next https://api.example.test/b', /--next/],
    ['curl https://api.example.test/ -d a=1 -F b=2', /both -d and -F/],
    ['curl https://api.example.test/ -F novalue', /name=value/],
    ['curl https://api.example.test/ -H', /needs a value/]
  ])('refuses %s', (command, message) => {
    expect(() => parseCurl(command)).toThrow(CurlParseError);
    expect(() => parseCurl(command)).toThrow(message);
  });

  describe('reads back what "Copy as cURL" writes', () => {
    it('GET with headers', () => {
      const p = parseCurl(toCurl({ method: 'GET', url: 'https://api.example.test/a?b=1', headers: [['Host', 'api.example.test'], ['Accept', '*/*'], ['Accept-Encoding', 'gzip, deflate, br']] }));
      expect(p).toMatchObject({ method: 'GET', url: 'https://api.example.test/a?b=1', headers: [['Accept', '*/*'], ['Accept-Encoding', 'gzip, deflate, br']], notes: [] });
    });

    it.each(['GET', 'HEAD', 'DELETE', 'OPTIONS'])('%s without a body', (method) => {
      expect(parseCurl(toCurl({ method, url: 'https://api.example.test/x', headers: [] }))).toMatchObject({ method, body: { mode: 'none' } });
    });

    it('a body with quotes, line breaks and non-ASCII text', () => {
      const body = `{"name":"O'Brien","note":"a\\nb","city":"Zürich"}\n`;
      const p = parseCurl(toCurl({ method: 'PUT', url: 'https://api.example.test/p/1', headers: [['Content-Type', 'application/json'], ['Content-Length', '60']], body }));
      expect(p).toMatchObject({ method: 'PUT', headers: [['Content-Type', 'application/json']], body: { mode: 'json', json: body }, notes: [] });
    });

    it('a form body', () => {
      const p = parseCurl(toCurl({ method: 'POST', url: 'https://api.example.test/t', headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'a=1+2&b=%26' }));
      expect(p.body).toMatchObject({ mode: 'formUrlEncoded', formUrlEncoded: [field('a', '1 2'), field('b', '&')] });
    });

    it('multipart parts', () => {
      const p = parseCurl(toCurl(MULTIPART));
      expect(p.notes).toEqual([]);
      expect(p.headers).toEqual([['Accept', '*/*']]);
      expect(p.body.multipartForm).toEqual([
        text('title', "@not-a-file O'Brien"),
        text('meta', '{"a":"b;c"}', 'application/json'),
        file('report', 'C:\\Users\\someone\\report "v2".pdf', 'application/pdf'),
        file('pic', '/tmp/p.png')
      ]);
    });
  });
});

describe('requestFromCurl', () => {
  const blank: RequestDoc = {
    name: 'New', method: 'GET', url: '', params: [], headers: [],
    body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
    auth: { ...emptyAuth(), mode: 'inherit' },
    vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
    settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true }
  };

  it('fills the request and keeps what the command does not set', () => {
    const doc = requestFromCurl(blank, parseCurl(`curl -u alex:pw -m 3 'https://api.example.test/users/:id?expand=roles' -H 'Accept: application/json'`));
    expect(doc).toMatchObject({
      name: 'New',
      method: 'GET',
      url: 'https://api.example.test/users/:id?expand=roles',
      params: [{ name: 'expand', value: 'roles', enabled: true, type: 'query' }, { name: 'id', value: '', enabled: true, type: 'path' }],
      headers: [{ name: 'Accept', value: 'application/json', enabled: true }],
      auth: { mode: 'basic', basic: { username: 'alex', password: 'pw' } },
      settings: { timeoutMs: 3000, followRedirects: true, maxRedirects: 5 }
    });
  });

  it('leaves auth inherited when the command has none', () => {
    expect(requestFromCurl(blank, parseCurl('curl https://api.example.test/')).auth.mode).toBe('inherit');
  });
});

describe('curlRequestName', () => {
  it.each([
    ['curl -X POST https://api.example.test/v1/users?x=1', 'POST users'],
    ['curl https://api.example.test/files/my%20file.txt', 'GET my file.txt'],
    ['curl https://api.example.test', 'GET api.example.test'],
    ['curl {{baseUrl}}/health', 'GET health']
  ])('%s → %s', (command, name) => {
    expect(curlRequestName(parseCurl(command))).toBe(name);
  });
});
