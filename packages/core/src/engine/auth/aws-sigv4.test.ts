// AWS SigV4 against cases from the published AWS signing test suite (aws-signing-test-suite/v4).
// All cases use the suite's example credentials, region us-east-1, service "service" and 2015-08-30T12:36:00Z.
import { describe, expect, it } from 'vitest';
import { sha256Hex, signV4 } from './aws-sigv4';

const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' };
const now = new Date('2015-08-30T12:36:00Z');
const EMPTY = sha256Hex('');
const host = { Host: 'example.amazonaws.com' };

interface Case {
  name: string;
  method: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  body?: string;
  sessionToken?: string;
  signBody?: boolean;
  signature: string;
  canonical?: string;
}

const CASES: Case[] = [
  {
    name: 'get-vanilla',
    method: 'GET',
    path: '/',
    signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    canonical: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`
  },
  {
    name: 'get-vanilla-query-order-key-case',
    method: 'GET',
    path: '/',
    query: 'Param2=value2&Param1=value1',
    signature: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    canonical: `GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`
  },
  { name: 'get-vanilla-utf8-query', method: 'GET', path: '/', query: 'ሴ=bar', signature: '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04' },
  { name: 'get-utf8', method: 'GET', path: '/ሴ', signature: '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85' },
  { name: 'get-space-normalized', method: 'GET', path: '/example space/', signature: '652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741' },
  {
    name: 'get-vanilla-with-session-token',
    method: 'GET',
    path: '/',
    sessionToken: '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267',
    signature: '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8'
  },
  { name: 'post-header-value-case', method: 'POST', path: '/', headers: { 'My-Header1': 'VALUE1' }, signature: 'cdbc9802e29d2942e5e10b5bccfdd67c5f22c7c4e8ae67b53629efa58b974b7d' },
  {
    name: 'post-x-www-form-urlencoded',
    method: 'POST',
    path: '/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '13' },
    body: 'Param1=value1',
    signBody: true,
    signature: 'd3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b'
  }
];

describe('AWS SigV4 test suite', () => {
  it.each(CASES)('$name', (c) => {
    const r = signV4(
      { method: c.method, path: c.path, query: c.query ?? '', headers: { ...host, ...c.headers }, bodyHash: sha256Hex(c.body ?? '') },
      { ...creds, sessionToken: c.sessionToken },
      { now, signBody: c.signBody }
    );
    if (c.canonical) expect(r.canonicalRequest).toBe(c.canonical);
    expect(r.signature).toBe(c.signature);
    expect(r.headers.Authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${r.canonicalRequest.split('\n').at(-2)}, Signature=${c.signature}`);
    expect(r.headers['X-Amz-Date']).toBe('20150830T123600Z');
    if (c.sessionToken) expect(r.headers['X-Amz-Security-Token']).toBe(c.sessionToken);
  });

  it('leaves the User-Agent and an existing Authorization header out of the signature', () => {
    const r = signV4({ method: 'GET', path: '/', query: '', headers: { ...host, 'User-Agent': 'Yept/1.0', Authorization: 'x' }, bodyHash: EMPTY }, creds, { now });
    expect(r.signature).toBe(CASES[0].signature);
  });

  it('encodes each path segment again for most services, but only once for S3', () => {
    const req = { method: 'GET', path: '/my%20file.txt', query: '', headers: host, bodyHash: EMPTY };
    expect(signV4(req, creds, { now }).canonicalRequest.split('\n')[1]).toBe('/my%2520file.txt');
    expect(signV4(req, { ...creds, service: 's3' }, { now }).canonicalRequest.split('\n')[1]).toBe('/my%20file.txt');
  });
});
