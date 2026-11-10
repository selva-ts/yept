// Deterministic local fixture API used by the tests. No external network.
// Usage: node fixtures/server/server.mjs [port]   (default 4010)
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { authSchemeRoute } from './auth-schemes.mjs';

export { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DIGEST_PASSWORD, DIGEST_USER, NTLM_DOMAIN, NTLM_PASSWORD, NTLM_USER } from './auth-schemes.mjs';

export const CLIENT_ID = 'sample-client';
export const CLIENT_SECRET = 'sample-secret';
export const OAUTH_USER = 'sample-user';
export const OAUTH_PASSWORD = 'sample-password';

const issuedTokens = new Set();
let tokenRequests = 0;
const tokenGrants = {};
let lastUpload = null;
const htmlHits = {};
const created = new Map();
let changingRuns = 0;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A 24x16 RGB PNG: the left half blue, the right half orange. */
export function fixturePng() {
  const width = 24, height = 16;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0]; // filter: none
    for (let x = 0; x < width; x++) row.push(...(x < width / 2 ? [30, 90, 200] : [240, 140, 20]));
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** A one-page PDF that says "Fixture PDF", with a binary comment line as real PDFs have. */
export function fixturePdf() {
  const content = 'BT /F1 24 Tf 40 70 Td (Fixture PDF) Tj ET';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const BOOKINGS = [
  { id: 'bk-1001', traveller: 'Alex Example', destination: 'Lisbon', status: 'confirmed' },
  { id: 'bk-1002', traveller: 'Sam Sample', destination: 'Oslo', status: 'pending' }
];

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function bearerOk(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return m && issuedTokens.has(m[1]);
}

export function createFixtureServer() {
  const authorizationCodes = new Map();
  const refreshTokens = new Set();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const raw = await readBody(req);
    const body = raw.toString('utf8');
    let m;

    if (req.method === 'GET' && url.pathname === '/auth/authorize') {
      const query = url.searchParams;
      const redirect = new URL(query.get('redirect_uri') || 'http://invalid.example.test');
      if (!['127.0.0.1', 'localhost'].includes(redirect.hostname) || query.get('response_type') !== 'code' ||
        query.get('client_id') !== CLIENT_ID || query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge')) {
        return send(res, 400, { error: 'invalid_request' });
      }
      const code = randomUUID();
      authorizationCodes.set(code, { redirect: redirect.href, challenge: query.get('code_challenge') });
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', query.has('wrong_state') ? 'wrong-state' : query.get('state'));
      return send(res, 302, '', { Location: redirect.href });
    }
    // OAuth2 token endpoint. Credentials in a Basic header or in the form body.
    // ?expires_in=N sets the token lifetime (default 3600); the scope asked for is echoed back.
    if (req.method === 'POST' && url.pathname === '/auth/token') {
      tokenRequests++;
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      const form = new URLSearchParams(body);
      const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString().split(':') : [form.get('client_id'), form.get('client_secret')];
      const grant = form.get('grant_type');
      tokenGrants[grant] = (tokenGrants[grant] ?? 0) + 1;
      const publicClient = !secret && (grant === 'authorization_code' || grant === 'refresh_token');
      if (id !== CLIENT_ID || (!publicClient && secret !== CLIENT_SECRET)) return send(res, 401, { error: 'invalid_client', error_description: 'Unknown client or wrong secret' });
      if (grant === 'authorization_code') {
        const code = form.get('code');
        const saved = authorizationCodes.get(code);
        authorizationCodes.delete(code);
        const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!saved || saved.redirect !== form.get('redirect_uri') || saved.challenge !== challenge) {
          return send(res, 400, { error: 'invalid_grant', error_description: `Rejected code ${code}` });
        }
      } else if (grant === 'password') {
        if (form.get('username') !== OAUTH_USER || form.get('password') !== OAUTH_PASSWORD) {
          return send(res, 400, { error: 'invalid_grant', error_description: `Rejected password ${form.get('password')}` });
        }
      } else if (grant === 'refresh_token') {
        if (!refreshTokens.delete(form.get('refresh_token')) || url.searchParams.has('reject_refresh')) {
          return send(res, 400, { error: 'invalid_grant', error_description: `Rejected token ${form.get('refresh_token')}` });
        }
      } else if (grant !== 'client_credentials') return send(res, 400, { error: 'unsupported_grant_type' });
      const token = randomUUID();
      issuedTokens.add(token);
      const scope = form.get('scope');
      const refresh = grant !== 'client_credentials' || url.searchParams.has('refresh') ? randomUUID() : undefined;
      if (refresh) refreshTokens.add(refresh);
      return send(res, 200, { access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: Number(url.searchParams.get('expires_in') ?? 3600), ...(scope ? { scope } : {}) });
    }
    // Token requests so far, for tests that check a cached token is reused.
    if (url.pathname === '/auth/stats') return send(res, 200, { tokenRequests, tokenGrants });
    // Invalidates every issued token, as a server-side revocation would.
    if (req.method === 'POST' && url.pathname === '/auth/revoke') {
      issuedTokens.clear();
      return send(res, 200, { revoked: true });
    }
    // Digest (/auth/digest), NTLM (/auth/ntlm) and AWS Signature v4 (/auth/aws/...): see auth-schemes.mjs.
    const scheme = authSchemeRoute(req, url, raw);
    if (scheme) return send(res, scheme.status, scheme.body, scheme.headers);
    // Accepts the token as ?access_token= instead of a header.
    if (url.pathname === '/bookings-by-query' && req.method === 'GET') {
      if (!issuedTokens.has(url.searchParams.get('access_token') ?? '')) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { items: BOOKINGS, total: BOOKINGS.length });
    }

    if (url.pathname === '/bookings' && req.method === 'GET') {
      if (!bearerOk(req)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { items: BOOKINGS, total: BOOKINGS.length });
    }

    if (url.pathname === '/bookings' && req.method === 'POST') {
      if (!bearerOk(req)) return send(res, 401, { error: 'unauthorized' });
      const input = JSON.parse(body || '{}');
      const booking = { id: `bk-${randomUUID().slice(0, 8)}`, ...input, status: 'pending' };
      created.set(booking.id, booking);
      return send(res, 201, booking);
    }

    // One booking: the fixed ones, or one created above. DELETE removes a created one (204), then GET gives 404.
    if ((m = /^\/bookings\/([\w-]+)$/.exec(url.pathname))) {
      if (!bearerOk(req)) return send(res, 401, { error: 'unauthorized' });
      const booking = created.get(m[1]) ?? BOOKINGS.find((b) => b.id === m[1]);
      if (req.method === 'GET') return booking ? send(res, 200, booking) : send(res, 404, { error: 'not_found', id: m[1] });
      if (req.method === 'DELETE') {
        if (!created.delete(m[1])) return send(res, 404, { error: 'not_found', id: m[1] });
        res.writeHead(204);
        return res.end();
      }
    }

    // Echo exactly what was received.
    if (url.pathname === '/echo') {
      return send(res, 200, {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body
      });
    }

    // Parses a multipart/form-data body and describes each part: field name, text value or file name, size,
    // content type and a SHA-256 of the file bytes (so tests can check a file arrived intact without echoing it).
    if (url.pathname === '/upload' && req.method === 'POST') {
      const type = req.headers['content-type'] ?? '';
      if (!type.startsWith('multipart/form-data')) return send(res, 415, { error: 'expected multipart/form-data', contentType: type });
      let form;
      try {
        form = await new Response(raw, { headers: { 'content-type': type } }).formData();
      } catch (e) {
        return send(res, 400, { error: 'bad multipart body', message: String(e) });
      }
      const parts = [];
      for (const [name, value] of form) {
        if (typeof value === 'string') parts.push({ name, value });
        else {
          const bytes = Buffer.from(await value.arrayBuffer());
          parts.push({ name, fileName: value.name, size: bytes.length, contentType: value.type, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
      }
      lastUpload = { contentLength: Number(req.headers['content-length'] ?? -1), received: raw.length, parts };
      return send(res, 200, lastUpload);
    }
    // The last /upload, for tests that can't read the whole response from the UI.
    if (url.pathname === '/upload/last') return send(res, 200, lastUpload ?? {});

    if ((m = /^\/status\/(\d{3})$/.exec(url.pathname))) return send(res, Number(m[1]), { status: Number(m[1]) });

    if ((m = /^\/delay\/(\d+)$/.exec(url.pathname))) {
      return setTimeout(() => send(res, 200, { delayedMs: Number(m[1]) }), Number(m[1]));
    }

    // Never responds; for timeout and cancel tests.
    if (url.pathname === '/hang') return;

    // Sends headers and a first chunk, then stalls: the body never completes.
    if (url.pathname === '/stall-body') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial');
      return;
    }

    // /redirect/3 -> /redirect/2 -> /redirect/1 -> /echo ; /redirect-loop never ends.
    if ((m = /^\/redirect\/(\d+)$/.exec(url.pathname))) {
      const n = Number(m[1]);
      res.writeHead(302, { Location: n > 1 ? `/redirect/${n - 1}` : '/echo' });
      return res.end();
    }
    if (url.pathname === '/redirect-loop') {
      res.writeHead(302, { Location: '/redirect-loop' });
      return res.end();
    }

    // Cookies. /cookies/set?sid=abc&theme=dark sets each as a session cookie; add max-age=N to make them
    // persistent, or path=/x to scope them. /cookies/echo returns the Cookie header received.
    // /cookies/redirect sets hop=1 and redirects to /cookies/echo, so the next hop can be checked.
    if (url.pathname === '/cookies/set') {
      const maxAge = url.searchParams.get('max-age');
      const path = url.searchParams.get('path') ?? '/';
      const pairs = [...url.searchParams].filter(([k]) => k !== 'max-age' && k !== 'path');
      const cookies = pairs.map(([k, v]) => `${k}=${v}; Path=${path}${maxAge ? `; Max-Age=${maxAge}` : ''}`);
      return send(res, 200, { set: pairs.map(([k]) => k) }, { 'Set-Cookie': cookies });
    }
    if (url.pathname === '/cookies/echo') {
      const header = req.headers.cookie ?? '';
      const cookies = Object.fromEntries(header.split(';').filter((p) => p.includes('=')).map((p) => p.trim().split('=')));
      return send(res, 200, { header, cookies });
    }
    if (url.pathname === '/cookies/redirect') {
      res.writeHead(302, { Location: '/cookies/echo', 'Set-Cookie': 'hop=1; Path=/' });
      return res.end();
    }

    if (url.pathname === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    }

    // Media for the image and PDF preview: a 24x16 PNG (two colours) and a one-page PDF, both built here.
    if (url.pathname === '/media/image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fixturePng());
    }
    if (url.pathname === '/media/doc.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(fixturePdf());
    }
    // A download: the bytes of /binary with a file name in Content-Disposition.
    if (url.pathname === '/download') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="sample-export.bin"' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    }
    // Changes on every call: an X-Run-Count header, a cookie and the body. For comparing two runs in history.
    if (url.pathname === '/changing') {
      changingRuns++;
      return send(res, 200, { run: changingRuns, items: ['bk-1001', 'bk-1002'] }, { 'X-Run-Count': String(changingRuns), 'X-Fixed': 'same', 'Set-Cookie': `visit=v${changingRuns}; Path=/` });
    }

    // An HTML page that tries everything the response preview must block: a script, a refresh, remote image and
    // stylesheet, a form, links and a frame. Each of the URLs it points at counts requests (see /html/stats).
    if (url.pathname === '/html') {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        `<!DOCTYPE html><html><head><title>Fixture page</title><meta http-equiv="refresh" content="1;url=${origin}/html/hit/refresh">` +
          `<link rel="stylesheet" href="${origin}/html/hit/css"><style>h1{color:rgb(200,30,30)}</style>` +
          `<script>document.title='script ran';document.body&&document.body.setAttribute('data-script','ran')</script></head>` +
          `<body><h1>Booking summary</h1><p>Traveller <b>Alex Example</b>, <a href="${origin}/html/hit/link" target="_blank">details</a>.</p>` +
          `<img alt="pixel" src="${origin}/html/hit/img"><form action="${origin}/html/hit/form" method="post"><button>Submit</button></form>` +
          `<iframe src="${origin}/html/hit/frame"></iframe><ul><li>Lisbon</li><li>Oslo</li></ul></body></html>`
      );
    }
    // Links a hostile page might use to reach the operating system: none of them may leave the preview.
    if (url.pathname === '/html/links') {
      const origin = `http://${req.headers.host}`;
      const links = [
        ['web page', 'https://api.example.test/docs'],
        ['local file', 'file:///C:/Windows/win.ini'],
        ['network share', 'file://server.example.test/share/run.bat'],
        ['settings', 'ms-settings:privacy'],
        ['email', 'mailto:someone@example.test'],
        ['script', 'javascript:alert(1)'],
        ['same server', `${origin}/html/hit/newtab`]
      ];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        `<!DOCTYPE html><html><head><title>Links</title></head><body><h1>Links</h1><ul>` +
          links.map(([name, href]) => `<li><a href="${href}" target="_blank">${name}</a></li>`).join('') +
          `</ul><a href="${origin}/html/hit/top" target="_top">top</a></body></html>`
      );
    }
    if (url.pathname === '/html/rows') {
      const rows = Number(url.searchParams.get('n') ?? 10000);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><body><table>${Array.from({ length: rows }, (_, i) => `<tr><td>${i}</td><td>Row ${i}</td></tr>`).join('')}</table></body></html>`);
    }
    if ((m = /^\/html\/hit\/(\w+)$/.exec(url.pathname))) {
      htmlHits[m[1]] = (htmlHits[m[1]] ?? 0) + 1;
      return send(res, 200, 'hit');
    }
    if (url.pathname === '/html/stats') return send(res, 200, htmlHits);
    if (url.pathname === '/xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Bookings</title><link>https://api.example.test/</link><item><id>bk-1001</id></item></channel></rss>');
    }

    if (url.pathname === '/big') {
      const mb = Number(url.searchParams.get('mb') ?? 1);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('x'.repeat(mb * 1024 * 1024));
    }

    send(res, 404, { error: 'not_found', path: url.pathname });
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const port = Number(process.argv[2] ?? 4010);
  createFixtureServer().listen(port, () => console.log(`fixture server on http://localhost:${port}`));
}
