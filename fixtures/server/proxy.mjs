// A small HTTP proxy for tests: forwards plain HTTP requests (full URL as the target) and opens CONNECT tunnels,
// recording each one. Every request goes to `target` (host:port) whatever host it names, so tests can use synthetic
// names like api.example.test. With `username` set, it asks for Basic sign-in (407) like a company proxy.
import http from 'node:http';
import net from 'node:net';

export function createTestProxy({ target, username, password } = {}) {
  const seen = [];
  const expected = username === undefined ? undefined : `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;
  const signedIn = (header) => expected === undefined || header === expected;
  const route = (authority) => {
    if (target) return target;
    const u = new URL(`http://${authority}`);
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 80 };
  };

  const server = http.createServer((req, res) => {
    const auth = req.headers['proxy-authorization'];
    seen.push({ kind: 'http', method: req.method, url: req.url, auth: auth !== undefined });
    if (!signedIn(auth)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"', 'Content-Type': 'text/plain' });
      return res.end('Proxy sign-in needed');
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Not a proxy request');
    }
    const to = route(url.host);
    const headers = { ...req.headers, 'x-via-test-proxy': '1' };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request({ host: to.host, port: to.port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Upstream failed');
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, socket, head) => {
    const auth = req.headers['proxy-authorization'];
    seen.push({ kind: 'connect', authority: req.url, auth: auth !== undefined });
    if (!signedIn(auth)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const to = route(req.url);
    const upstream = net.connect(to.port, to.host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('error', close);
  });

  return { server, seen };
}
