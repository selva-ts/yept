// Digest, AWS Signature v4 and NTLM through the request pipeline, against the fixture server's own checks:
// the second send after a challenge, signing the final request, masking, history redaction, inherited auth,
// the collection runner, and the Bruno file format.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DIGEST_PASSWORD, DIGEST_USER, NTLM_DOMAIN, NTLM_PASSWORD, NTLM_USER, createFixtureServer
} from '../../../../../fixtures/server/server.mjs';
import { emptyAuth, type AuthConfig, type RequestDoc, type SettingsDoc } from '../../shared/model';
import { emptyEnvLayer, type VarLayers } from '../env/variables';
import { redactResult } from '../history/redact';
import { runSequence } from '../runner/collection-runner';
import { SandboxHost } from '../sandbox/host';
import { run, type RunOptions } from '../runner/runner';
import { applyRequestDoc, applySettingsDoc, parseRequestFile, stringifyRequestFile, toRequestDoc, toSettingsDoc } from '../workspace/bruno-adapter';

let server: Server;
let base = '';
let dir = '';
let sandbox: SandboxHost;

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'yept-auth-'));
  writeFileSync(join(dir, 'note.txt'), 'hello from a file\n');
  sandbox = new SandboxHost(new URL('../sandbox/worker.mjs', import.meta.url), { timeoutMs: 10000 });
});
afterAll(async () => {
  await sandbox.close();
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const digest = (password = '{{digestPassword}}'): AuthConfig => ({ ...emptyAuth(), mode: 'digest', digest: { username: DIGEST_USER, password } });
const ntlm = (password = '{{ntlmPassword}}'): AuthConfig => ({ ...emptyAuth(), mode: 'ntlm', ntlm: { username: NTLM_USER, password, domain: NTLM_DOMAIN } });
const awsv4 = (over: Partial<AuthConfig['awsv4']> = {}): AuthConfig => ({
  ...emptyAuth(),
  mode: 'awsv4',
  awsv4: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: '{{awsSecret}}', sessionToken: '', service: 'execute-api', region: 'eu-west-1', profileName: '', ...over }
});
const doc = (over: Partial<RequestDoc> = {}): RequestDoc => ({
  name: 't', method: 'GET', url: '{{baseUrl}}/auth/digest', params: [], headers: [],
  body: { mode: 'none', json: '', text: '', xml: '', formUrlEncoded: [], multipartForm: [] },
  auth: digest(), vars: { req: [], res: [] }, script: { req: '', res: '' }, tests: '', assertions: [], docs: '',
  settings: { encodeUrl: true, timeoutMs: 0, followRedirects: true, maxRedirects: 5, forwardAuthorizationHeader: false, sendCookies: true },
  ...over
});
const layers = (): VarLayers => ({
  collection: [], folders: [], request: [], runtime: {},
  environment: { ...emptyEnvLayer(), file: { baseUrl: base }, secrets: { digestPassword: DIGEST_PASSWORD, ntlmPassword: NTLM_PASSWORD, awsSecret: AWS_SECRET_ACCESS_KEY } }
});
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  runId: 'r', environment: 'dev', layers: layers(), secretNames: ['digestPassword', 'ntlmPassword', 'awsSecret'], defaultTimeoutMs: 5000, maxBodyBytes: 1024 * 1024, collectionPath: dir, sandbox, ...over
});
const json = (r: Awaited<ReturnType<typeof run>>): Record<string, unknown> => JSON.parse(r.result.body.text);
const settings = (auth: AuthConfig): SettingsDoc => ({ name: 'Sample', headers: [], auth, vars: [], script: { req: '', res: '' }, tests: '', docs: '' });

describe('Digest auth', () => {
  it.each(['MD5', 'SHA-256'])('answers a %s challenge with qop=auth and sends once more', async (algorithm) => {
    const r = await run(doc({ url: `{{baseUrl}}/auth/digest?algorithm=${algorithm}` }), opts());
    expect(r.result.status).toBe(200);
    expect(json(r)).toMatchObject({ authenticated: true, algorithm, user: DIGEST_USER });
    expect(r.result.hops?.map((h) => h.status)).toEqual([401, 200]);
    expect(r.result.timeline.find((t) => t.label === 'Digest challenge')?.detail).toBe('Re-sent with credentials');
    expect(r.sent!.headers.find(([k]) => k === 'Authorization')![1]).toMatch(new RegExp(`^Digest username="${DIGEST_USER}".*algorithm=${algorithm}`));
  });

  it('sends a multipart body again, files read a second time', async () => {
    const body = { ...doc().body, mode: 'multipartForm' as const, multipartForm: [{ name: 'file', type: 'file' as const, value: '', files: ['note.txt'], localFiles: [], contentType: '', enabled: true }] };
    const r = await run(doc({ method: 'POST', body }), opts());
    expect(r.result.status).toBe(200);
    expect(r.result.hops).toHaveLength(2);
  });

  it('a wrong password ends with the 401, after one retry', async () => {
    const r = await run(doc({ auth: digest('not-the-password') }), opts());
    expect(r.result.status).toBe(401);
    expect(r.result.hops).toHaveLength(2);
  });

  it('a 401 without a Digest challenge is the answer, and says so', async () => {
    const r = await run(doc({ url: '{{baseUrl}}/auth/ntlm' }), opts());
    expect(r.result.status).toBe(401);
    expect(r.result.hops).toHaveLength(1);
    expect(r.result.timeline.find((t) => t.label === 'Digest challenge')?.detail).toBe('The 401 response has no Digest challenge');
  });

  it('an Authorization header on the request wins over the auth settings', async () => {
    const r = await run(doc({ headers: [{ name: 'Authorization', value: 'Bearer own-token', enabled: true }] }), opts());
    expect(r.result.status).toBe(401);
    expect(r.result.hops).toHaveLength(1);
  });
});

describe('NTLM auth', () => {
  it('completes the three-message handshake on one connection', async () => {
    const r = await run(doc({ url: '{{baseUrl}}/auth/ntlm', auth: ntlm() }), opts());
    expect(r.result.status).toBe(200);
    expect(json(r)).toMatchObject({ authenticated: true, user: `${NTLM_DOMAIN}\\${NTLM_USER}` });
    expect(r.result.hops?.map((h) => h.status)).toEqual([401, 200]);
    expect(r.result.hops?.[1].timings.reused).toBe(true);
  });

  it('takes DOMAIN\\user in the user name, and posts the body with each message', async () => {
    const auth: AuthConfig = { ...ntlm(), ntlm: { username: `${NTLM_DOMAIN}\\${NTLM_USER}`, password: '{{ntlmPassword}}', domain: '' } };
    const r = await run(doc({ method: 'POST', url: '{{baseUrl}}/auth/ntlm', auth, body: { ...doc().body, mode: 'json', json: '{"a":1}' } }), opts());
    expect(r.result.status).toBe(200);
  });

  it('a wrong password ends with the 401', async () => {
    const r = await run(doc({ url: '{{baseUrl}}/auth/ntlm', auth: ntlm('not-the-password') }), opts());
    expect(r.result.status).toBe(401);
    expect(json(r)).toMatchObject({ error: 'wrong NTLM credentials' });
  });
});

describe('AWS Signature v4', () => {
  it('signs the final request: method, path, query and body', async () => {
    const r = await run(doc({ method: 'POST', url: '{{baseUrl}}/auth/aws/items/a b?z=1&a=x y', auth: awsv4(), body: { ...doc().body, mode: 'json', json: '{"name":"Alex Example"}' } }), opts());
    expect(r.result.status).toBe(200);
    expect(json(r)).toMatchObject({ authenticated: true, service: 'execute-api', region: 'eu-west-1', sessionToken: false });
    expect(r.result.hops).toHaveLength(1);
    expect(r.result.timeline.find((t) => t.label === 'AWS Signature v4')?.detail).toBe('Signed for execute-api in eu-west-1');
  });

  it('signs a multipart body and a session token', async () => {
    const body = { ...doc().body, mode: 'multipartForm' as const, multipartForm: [{ name: 'file', type: 'file' as const, value: '', files: ['note.txt'], localFiles: [], contentType: 'text/plain', enabled: true }] };
    const r = await run(doc({ method: 'PUT', url: '{{baseUrl}}/auth/aws/upload', auth: awsv4({ sessionToken: 'sample-session-token-value' }), body }), opts());
    expect(r.result.status).toBe(200);
    expect(json(r)).toMatchObject({ sessionToken: true });
    expect(JSON.stringify(r.result)).not.toContain('sample-session-token-value');
  });

  it('a wrong secret is rejected by the server', async () => {
    const r = await run(doc({ url: '{{baseUrl}}/auth/aws/items', auth: awsv4({ secretAccessKey: 'wrong/secret/value' }) }), opts());
    expect(r.result.status).toBe(403);
  });

  it('asks for keys instead of reading an AWS profile', async () => {
    const r = await run(doc({ url: '{{baseUrl}}/auth/aws/items', auth: awsv4({ accessKeyId: '', secretAccessKey: '', profileName: 'dev' }) }), opts());
    expect(r.result.outcome).toBe('prepare_error');
    expect(r.result.error?.message).toMatch(/AWS profile "dev" can't be read by Yept/);
    const r2 = await run(doc({ url: '{{baseUrl}}/auth/aws/items', auth: awsv4({ region: '' }) }), opts());
    expect(r2.result.error?.message).toBe('AWS service and region are required');
  });
});

describe('masking, history and inherited auth', () => {
  it.each([
    ['digest', '/auth/digest', digest(DIGEST_PASSWORD), DIGEST_PASSWORD],
    ['ntlm', '/auth/ntlm', ntlm(NTLM_PASSWORD), NTLM_PASSWORD],
    ['awsv4', '/auth/aws/x', awsv4({ secretAccessKey: AWS_SECRET_ACCESS_KEY }), AWS_SECRET_ACCESS_KEY]
  ])('%s: a password typed into the auth settings is masked, and history gets no Authorization value', async (_mode, path, auth, secret) => {
    const r = await run(doc({ url: `{{baseUrl}}${path}`, auth, script: { req: `console.log("${secret}")`, res: '' } }), opts());
    expect(r.result.status).toBe(200);
    expect(JSON.stringify(r.result)).not.toContain(secret);
    const shown = (r.result.hops ?? []).flatMap((h) => h.requestHeaders).filter(([k]) => k.toLowerCase() === 'authorization');
    expect(shown.length).toBeGreaterThan(0);
    for (const [, v] of shown) expect(v).toBe('••••••');
    expect(r.secrets.map((s) => s.value)).toContain(secret);
    const stored = redactResult(r.result, r.secrets);
    expect(JSON.stringify(stored)).not.toContain(secret);
    const sentAuth = [stored.request.headers, ...(stored.hops ?? []).map((h) => h.requestHeaders)].flat().filter(([k]) => /^(authorization|x-amz-security-token)$/i.test(k));
    expect(sentAuth.length).toBeGreaterThan(0);
    for (const [, v] of sentAuth) expect(v).toBe('«redacted»');
  });

  it('requests inherit each mode from the collection or folder, and run in a collection run', async () => {
    const inherit = { ...emptyAuth(), mode: 'inherit' };
    const items = [
      { name: 'Digest', url: '{{baseUrl}}/auth/digest?algorithm=SHA-256', inherited: { collection: settings(digest()), folders: [] } },
      { name: 'NTLM', url: '{{baseUrl}}/auth/ntlm', inherited: { collection: settings(digest()), folders: [settings(ntlm())] } },
      { name: 'AWS', url: '{{baseUrl}}/auth/aws/list?page=2', inherited: { collection: settings(awsv4()), folders: [settings(inherit)] } }
    ];
    const plan = items.map((it, i) => ({ requestId: String(i), name: it.name, method: 'GET' as const, folder: '' }));
    let n = 0;
    const result = await runSequence(plan, {
      stopOnFailure: true,
      newRunId: () => `run-${++n}`,
      runStep: async (item, runId) => {
        const it = items[Number(item.requestId)];
        return (await run(doc({ url: it.url, auth: inherit, tests: 'test("signed in", () => expect(res.status).to.equal(200));' }), opts({ runId, inherited: it.inherited }))).result;
      }
    });
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed']);
    expect(result.ended).toBe('completed');
  });
});

describe('Bruno files', () => {
  const file = (auth: string): string => `info:
  name: Secure
  type: http
  seq: 1

http:
  method: GET
  url: "{{baseUrl}}/secure"
  auth:
${auth}
settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: true
`;
  const DIGEST = file(`    type: digest
    username: sample-user
    password: "{{digestPassword}}"
`);
  const NTLM = file(`    type: ntlm
    username: sample-user
    password: "{{ntlmPassword}}"
    domain: SAMPLE
`);
  const AWS = file(`    type: awsv4
    accessKeyId: "{{awsKeyId}}"
    secretAccessKey: "{{awsSecret}}"
    sessionToken: "{{awsSession}}"
    service: execute-api
    region: eu-west-1
    profileName: sample-profile
`);

  it.each([
    ['digest', DIGEST],
    ['ntlm', NTLM],
    ['awsv4', AWS]
  ])('%s: an unchanged file is written back byte for byte', (mode, text) => {
    const item = parseRequestFile(text, 'yml');
    const d = toRequestDoc(item);
    expect(d.auth.mode).toBe(mode);
    expect(stringifyRequestFile(applyRequestDoc(item, d))).toBe(text);
    // Editing something else leaves the auth block as it was.
    const other = stringifyRequestFile(applyRequestDoc(item, { ...d, url: '{{baseUrl}}/secure/v2' }));
    expect(other.slice(other.indexOf('  auth:'), other.indexOf('settings:'))).toBe(text.slice(text.indexOf('  auth:'), text.indexOf('settings:')));
  });

  it('edits are saved in Bruno shape, empty fields left out', () => {
    const d = toRequestDoc(parseRequestFile(DIGEST, 'yml'));
    expect(d.auth.digest).toEqual({ username: 'sample-user', password: '{{digestPassword}}' });
    const toNtlm = stringifyRequestFile(applyRequestDoc(parseRequestFile(DIGEST, 'yml'), { ...d, auth: { ...d.auth, mode: 'ntlm', ntlm: { username: 'alex', password: '{{pw}}', domain: '' } } }));
    expect(toNtlm).toBe(file(`    type: ntlm
    username: alex
    password: "{{pw}}"
`));
    const a = toRequestDoc(parseRequestFile(AWS, 'yml'));
    expect(a.auth.awsv4).toMatchObject({ accessKeyId: '{{awsKeyId}}', service: 'execute-api', region: 'eu-west-1', profileName: 'sample-profile' });
    const edited = stringifyRequestFile(applyRequestDoc(parseRequestFile(AWS, 'yml'), { ...a, auth: { ...a.auth, awsv4: { ...a.auth.awsv4, region: 'ap-south-1', sessionToken: '' } } }));
    expect(edited).toBe(AWS.replace('eu-west-1', 'ap-south-1').replace('    sessionToken: "{{awsSession}}"\n', ''));
  });

  it('collection and folder settings keep and save the new modes', () => {
    const root = { request: { auth: { mode: 'ntlm', ntlm: { username: 'sample-user', password: '{{ntlmPassword}}', domain: 'SAMPLE' } } } };
    const s = toSettingsDoc('Sample', root, 'none');
    expect(s.auth).toMatchObject({ mode: 'ntlm', ntlm: { domain: 'SAMPLE' } });
    expect(applySettingsDoc(root, { ...s, auth: { ...s.auth, ntlm: { ...s.auth.ntlm, domain: 'OTHER' } } }).request.auth.ntlm).toEqual({ username: 'sample-user', password: '{{ntlmPassword}}', domain: 'OTHER' });
  });
});
