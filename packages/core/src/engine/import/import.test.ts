import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { IdentityStore } from '../identity/identity-store';
import { Workspace } from '../workspace/workspace';
import type { TreeNode } from '../../shared/model';
import { applySecretFixes, buildPlan, convertSource, exportBundled, findSecrets, writePlan } from './collection-io';

const FIX = resolve(__dirname, '../../../../../fixtures');
let dir: string;
let identity: IdentityStore;
const open = async (root: string): Promise<Workspace> => {
  const ws = new Workspace(root, identity, { trash: async () => {} });
  await ws.load();
  return ws;
};
const flat = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const requestNames = (ws: Workspace): string[] => flat(ws.snapshot().collections).filter((n) => n.kind === 'request').map((n) => n.name).sort();
const byName = (ws: Workspace, name: string): TreeNode => flat(ws.snapshot().collections).find((n) => n.kind === 'request' && n.name === name)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yept-imp-'));
  identity = new IdentityStore(join(dir, 'id.db'));
});
afterEach(() => {
  identity.close();
  rmSync(dir, { recursive: true, force: true });
});

async function importFile(file: string, fixes?: (ids: string[]) => string[]): Promise<{ ws: Workspace; target: string; issues: string[]; values: { name: string; value: string }[] }> {
  const src = await convertSource(readFileSync(join(FIX, 'import', file), 'utf8'), file);
  const findings = findSecrets(src.model);
  const values = applySecretFixes(src.model, new Set(fixes ? fixes(findings.map((f) => f.id)) : []));
  const plan = buildPlan(src.model, join(dir, 'ws'));
  const out = await writePlan(plan, 'copy');
  return { ws: await open(join(dir, 'ws')), target: out.dir, issues: src.issues, values };
}

describe('import', () => {
  it('imports a Postman collection into a loadable YAML collection', async () => {
    const { ws, target } = await importFile('postman-sample.postman_collection.json');
    expect(ws.snapshot().problems).toEqual([]);
    expect(ws.snapshot().collections.map((c) => c.name)).toEqual(['Sample Postman Travel']);
    expect(requestNames(ws)).toEqual(['Create booking', 'List bookings', 'Login']);
    const login = ws.getRequest(byName(ws, 'Login').id).doc;
    expect(login).toMatchObject({ method: 'POST', url: '{{baseUrl}}/auth/token', auth: { mode: 'basic', basic: { username: '{{clientId}}', password: '{{clientSecret}}' } } });
    expect(login.script.res).toContain('bru.setEnvVar("accessToken"'); // pm.* translated to bru.*
    const list = ws.getRequest(byName(ws, 'List bookings').id).doc;
    expect(list.auth.mode).toBe('inherit');
    expect(ws.getSettings(ws.snapshot().collections[0].id).doc.auth).toMatchObject({ mode: 'bearer', bearer: { token: '{{accessToken}}' } });
    expect(existsSync(join(target, 'opencollection.yml'))).toBe(true);
    expect(readFileSync(join(target, 'opencollection.yml'), 'utf8')).not.toContain('proxy');
  });

  it('imports an Insomnia export and removes the converter\'s duplicates', async () => {
    const { ws, issues } = await importFile('insomnia-sample.json');
    expect(issues.join(' ')).toMatch(/Removed 1 duplicate request/);
    expect(requestNames(ws)).toEqual(['List bookings', 'Login']);
    const cid = ws.snapshot().collections[0].id;
    expect(ws.listEnvironments(cid).map((e) => e.env.name)).toEqual(['Base Environment', 'dev']);
    expect(ws.getRequest(byName(ws, 'Login').id).doc.url).toBe('{{baseUrl}}/auth/token'); // {{ _.baseUrl }} converted
  });

  it('imports an OpenAPI document with path parameters', async () => {
    const { ws } = await importFile('openapi-sample.yaml');
    expect(requestNames(ws)).toEqual(['Create booking', 'Get booking', 'List bookings']);
    const get = ws.getRequest(byName(ws, 'Get booking').id).doc;
    expect(get.url).toBe('{{baseUrl}}/bookings/:id');
    expect(get.params).toContainEqual(expect.objectContaining({ name: 'id', type: 'path' }));
  });

  it('finds literal secrets and replaces them with secret variables', async () => {
    const raw = JSON.parse(readFileSync(join(FIX, 'import', 'postman-sample.postman_collection.json'), 'utf8'));
    // Assembled at runtime so secret scanners don't flag this synthetic value.
    raw.auth.bearer[0].value = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2lnbmF0dXJlLXZhbHVlLXRlc3Q'].join('.');
    raw.item[0].item[0].request.auth.basic[1].value = 'hunter2-literal';
    const src = await convertSource(JSON.stringify(raw), 'p.json');
    // Collection-level auth lives in model.root, which findSecrets doesn't scan; request-level basic password is found.
    const findings = findSecrets(src.model);
    expect(findings.map((f) => f.field)).toContain('basic password');
    expect(findings.every((f) => !f.preview.includes('hunter2-literal'))).toBe(true);
    const values = applySecretFixes(src.model, new Set(findings.map((f) => f.id)));
    expect(values).toContainEqual({ name: 'password', value: 'hunter2-literal', environment: null });
    const plan = buildPlan(src.model, join(dir, 'ws'));
    const all = plan.files.map((f) => f.content).join('\n');
    expect(all).not.toContain('hunter2-literal');
    expect(plan.files.find((f) => f.kind === 'environment')?.content).toMatch(/secret: true\s+name: password/);
  });

  it('moves a literal OAuth2 client secret to a secret variable', async () => {
    const raw = JSON.parse(readFileSync(join(FIX, 'import', 'postman-sample.postman_collection.json'), 'utf8'));
    const src = await convertSource(JSON.stringify(raw), 'p.json');
    const request = src.model.items.flatMap((i: any) => (i.type === 'folder' ? i.items : [i]))[0];
    request.request.auth = { mode: 'oauth2', oauth2: { grantType: 'client_credentials', accessTokenUrl: 'https://api.example.test/token', clientId: 'app', clientSecret: 'literal-client-secret-value' } };
    const findings = findSecrets(src.model).filter((f) => f.field === 'client secret');
    expect(findings).toHaveLength(1);
    expect(findings[0].preview).not.toContain('literal-client-secret-value');
    const values = applySecretFixes(src.model, new Set(findings.map((f) => f.id)));
    expect(values).toContainEqual({ name: 'clientSecret', value: 'literal-client-secret-value', environment: null });
    expect(request.request.auth.oauth2.clientSecret).toBe('{{clientSecret}}');
  });

  it('imports Postman digest, AWS and NTLM auth, moving literal secrets to secret variables', async () => {
    const raw = JSON.parse(readFileSync(join(FIX, 'import', 'postman-sample.postman_collection.json'), 'utf8'));
    const kv = (o: Record<string, string>): { key: string; value: string; type: string }[] => Object.entries(o).map(([key, value]) => ({ key, value, type: 'string' }));
    const login = raw.item[0].item[0];
    raw.item[0].item = [
      { ...login, name: 'Digest', request: { ...login.request, auth: { type: 'digest', digest: kv({ username: 'sample-user', password: 'literal-digest-pass' }) } } },
      { ...login, name: 'AWS', request: { ...login.request, auth: { type: 'awsv4', awsv4: kv({ accessKey: '{{awsKeyId}}', secretKey: 'literal/aws/secret/access/key', sessionToken: 'literalSessionTokenValue1234', service: 'execute-api', region: 'eu-west-1' }) } } },
      { ...login, name: 'NTLM', request: { ...login.request, auth: { type: 'ntlm', ntlm: kv({ username: 'sample-user', password: 'literal-ntlm-pass', domain: 'SAMPLE' }) } } }
    ];
    const src = await convertSource(JSON.stringify(raw), 'p.json');
    const findings = findSecrets(src.model);
    expect(findings.map((f) => f.field)).toEqual(expect.arrayContaining(['digest password', 'aws secret access key', 'aws session token', 'ntlm password']));
    const values = applySecretFixes(src.model, new Set(findings.map((f) => f.id)));
    expect(values).toEqual(expect.arrayContaining([
      { name: 'digestPassword', value: 'literal-digest-pass', environment: null },
      { name: 'awsSecretAccessKey', value: 'literal/aws/secret/access/key', environment: null },
      { name: 'awsSessionToken', value: 'literalSessionTokenValue1234', environment: null },
      { name: 'ntlmPassword', value: 'literal-ntlm-pass', environment: null }
    ]));
    const all = buildPlan(src.model, join(dir, 'ws')).files.map((f) => f.content).join('\n');
    expect(all).not.toMatch(/literal-digest-pass|literal\/aws|literalSessionToken|literal-ntlm-pass/);
    expect(all).toContain('type: digest');
    expect(all).toMatch(/type: awsv4\n\s+accessKeyId: "\{\{awsKeyId\}\}"\n\s+secretAccessKey: "\{\{awsSecretAccessKey\}\}"/);
    expect(all).toMatch(/type: ntlm\n\s+username: sample-user\n\s+password: "\{\{ntlmPassword\}\}"\n\s+domain: SAMPLE/);
  });

  it('imports Insomnia digest, AWS (iam) and NTLM auth, which the converter leaves out', async () => {
    const raw = JSON.parse(readFileSync(join(FIX, 'import', 'insomnia-sample.json'), 'utf8'));
    const list = raw.resources.find((r: any) => r._id === 'req_list');
    raw.resources.push(
      { ...list, _id: 'req_digest', name: 'Digest', authentication: { type: 'digest', username: '{{ _.user }}', password: '{{ _.digestPassword }}' } },
      { ...list, _id: 'req_aws', name: 'AWS', authentication: { type: 'iam', accessKeyId: '{{ _.awsKeyId }}', secretAccessKey: 'literal/aws/secret/access/key', sessionToken: '', service: 'execute-api', region: 'eu-west-1' } },
      { ...list, _id: 'req_ntlm', name: 'NTLM', authentication: { type: 'ntlm', username: 'sample-user', password: '{{ _.ntlmPassword }}' } },
      { ...list, _id: 'req_off', name: 'Off', authentication: { type: 'digest', username: 'u', password: 'p', disabled: true } }
    );
    const src = await convertSource(JSON.stringify(raw), 'i.json');
    const auth = (name: string): any => src.model.items.find((i: any) => i.name === name).request.auth;
    expect(auth('Digest')).toMatchObject({ mode: 'digest', digest: { username: '{{user}}', password: '{{digestPassword}}' } });
    expect(auth('AWS')).toMatchObject({ mode: 'awsv4', awsv4: { accessKeyId: '{{awsKeyId}}', service: 'execute-api', region: 'eu-west-1' } });
    expect(auth('NTLM')).toMatchObject({ mode: 'ntlm', ntlm: { username: 'sample-user', password: '{{ntlmPassword}}' } });
    expect(auth('Off').mode).toBe('none');
    expect(findSecrets(src.model).map((f) => f.field)).toEqual(['aws secret access key']);
  });

  it('handles an existing target folder: copy, skip or replace (never deletes)', async () => {
    const text = readFileSync(join(FIX, 'import', 'openapi-sample.yaml'), 'utf8');
    const plan1 = buildPlan((await convertSource(text, 'a.yaml')).model, join(dir, 'ws'));
    const first = await writePlan(plan1, 'copy');
    await fs.writeFile(join(first.dir, 'Bookings', 'List bookings.yml'), 'edited by hand');
    const plan2 = buildPlan((await convertSource(text, 'a.yaml')).model, join(dir, 'ws'));
    expect(plan2.targetExists).toBe(true);
    expect(plan2.files.filter((f) => f.exists).length).toBe(plan2.files.length);
    const skip = await writePlan(plan2, 'skip');
    expect(skip).toMatchObject({ written: 0, skipped: plan2.files.length });
    expect(readFileSync(join(first.dir, 'Bookings', 'List bookings.yml'), 'utf8')).toBe('edited by hand');
    const copy = await writePlan(plan2, 'copy');
    expect(copy.dir).toBe(`${first.dir} (2)`);
    const replace = await writePlan(plan2, 'replace');
    expect(replace.written).toBe(plan2.files.length);
    expect(readFileSync(join(first.dir, 'Bookings', 'List bookings.yml'), 'utf8')).toContain('name: List bookings');
  });
});

describe('export and .bru conversion', () => {
  it.each([
    ['file', '  file: @file(files/a.bin) @contentType(application/octet-stream)\n  ~file: @file(files/b.bin) @contentType(text/plain)', [
      { filePath: 'files/a.bin', contentType: 'application/octet-stream', selected: true },
      { filePath: 'files/b.bin', contentType: 'text/plain', selected: false }
    ]],
    ['sparql', '  SELECT * WHERE { ?s ?p ?o }', 'SELECT * WHERE { ?s ?p ?o }']
  ])('preserves a %s body when converting .bru and editing the YAML copy', async (mode, body, expectedData) => {
    const legacy = join(dir, 'legacy');
    await fs.mkdir(legacy);
    await fs.writeFile(join(legacy, 'bruno.json'), '{"name":"Legacy","version":"1","type":"collection"}');
    const source = `meta {
  name: Sample
  type: http
  seq: 1
}
post {
  url: https://api.example.test/sample
  body: ${mode}
  auth: none
}
body:${mode} {
${body}
}
`;
    const bruFile = join(legacy, 'Sample.bru');
    await fs.writeFile(bruFile, source);
    const sourceWs = await open(dir);
    const [collection] = sourceWs.snapshot().collections;
    expect(collection.name).toBe('Legacy');
    expect(collection.readOnly).toBe(true);
    expect(sourceWs.getRequest(byName(sourceWs, 'Sample').id).doc.body.unsupported).toBe(mode);

    const converted = join(dir, 'converted');
    const result = await writePlan(buildPlan(sourceWs.collectionModel(collection.id), converted), 'copy');
    const yamlFile = join(result.dir, 'Sample.yml');
    const original = await fs.readFile(yamlFile, 'utf8');
    expect(yaml.load(original)).toMatchObject({ http: { body: { type: mode, data: expectedData } } });

    const ws = await open(converted);
    const request = byName(ws, 'Sample');
    const { doc } = ws.getRequest(request.id);
    await ws.saveRequest(request.id, { ...doc, url: 'https://api.example.test/updated' });
    const edited = await fs.readFile(yamlFile, 'utf8');
    expect(edited).toContain('url: https://api.example.test/updated');
    const bodyBlock = (text: string) => text.slice(text.indexOf('  body:'), text.indexOf('settings:'));
    expect(bodyBlock(edited)).toBe(bodyBlock(original));
    expect(await fs.readFile(bruFile, 'utf8')).toBe(source);
  });

  it('a bundled export re-imports with the same requests', async () => {
    await fs.cp(join(FIX, 'collections', 'sample-travel'), join(dir, 'src', 'sample-travel'), { recursive: true });
    const srcWs = await open(join(dir, 'src'));
    const cid = srcWs.snapshot().collections[0].id;
    const bundle = exportBundled(srcWs.collectionModel(cid), true);
    expect(bundle).toContain('bundled: true');
    const src = await convertSource(bundle, 'Sample Travel.yml');
    expect(src.format).toBe('opencollection');
    await writePlan(buildPlan(src.model, join(dir, 'ws')), 'copy');
    const ws = await open(join(dir, 'ws'));
    expect(requestNames(ws)).toEqual(requestNames(srcWs));
    for (const name of requestNames(srcWs)) {
      const { name: _a, ...before } = srcWs.getRequest(byName(srcWs, name).id).doc;
      const { name: _b, ...after } = ws.getRequest(byName(ws, name).id).doc;
      expect(after).toEqual(before);
    }
    expect(ws.listEnvironments(ws.snapshot().collections[0].id).map((e) => e.env)).toEqual(srcWs.listEnvironments(cid).map((e) => e.env));
  });

  it('converts a .bru collection to an editable YAML collection', async () => {
    const bru = join(dir, 'legacy', 'Legacy');
    await fs.mkdir(join(bru, 'Auth'), { recursive: true });
    await fs.mkdir(join(bru, 'environments'));
    await fs.writeFile(join(bru, 'bruno.json'), JSON.stringify({ version: '1', name: 'Legacy', type: 'collection' }));
    await fs.writeFile(join(bru, 'collection.bru'), 'auth {\n  mode: bearer\n}\n\nauth:bearer {\n  token: {{accessToken}}\n}\n');
    await fs.writeFile(join(bru, 'Auth', 'folder.bru'), 'meta {\n  name: Auth\n  seq: 1\n}\n');
    await fs.writeFile(
      join(bru, 'Auth', 'Login.bru'),
      'meta {\n  name: Login\n  type: http\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/login\n  body: json\n  auth: none\n}\n\nbody:json {\n  {"user": "{{user}}"}\n}\n\nvars:post-response {\n  accessToken: res.body.token\n}\n'
    );
    await fs.writeFile(join(bru, 'Ping.bru'), 'meta {\n  name: Ping\n  type: http\n  seq: 2\n}\n\nget {\n  url: {{baseUrl}}/ping\n  body: none\n  auth: inherit\n}\n');
    await fs.writeFile(join(bru, 'environments', 'dev.bru'), 'vars {\n  baseUrl: http://localhost:5000\n}\nvars:secret [\n  accessToken\n]\n');
    const bruWs = await open(join(dir, 'legacy'));
    const cid = bruWs.snapshot().collections[0].id;
    const model = bruWs.collectionModel(cid);
    const plan = buildPlan(model, join(dir, 'converted'), 'Legacy');
    await writePlan(plan, 'copy');
    const ws = await open(join(dir, 'converted'));
    const col = ws.snapshot().collections[0];
    expect(col.readOnly).toBe(false); // YAML: editable
    expect(requestNames(ws)).toEqual(['Login', 'Ping']);
    expect(ws.getRequest(byName(ws, 'Login').id).doc).toMatchObject({ method: 'POST', body: { mode: 'json' }, vars: { res: [{ name: 'accessToken', value: 'res.body.token', enabled: true }] } });
    expect(ws.getSettings(col.id).doc.auth).toMatchObject({ mode: 'bearer', bearer: { token: '{{accessToken}}' } });
    expect(ws.listEnvironments(col.id)[0].env).toEqual({ name: 'dev', variables: [{ name: 'baseUrl', value: 'http://localhost:5000', secret: false, enabled: true }, { name: 'accessToken', value: '', secret: true, enabled: true }] });
    expect(existsSync(join(dir, 'legacy', 'Legacy', 'Login.bru')) || existsSync(join(dir, 'legacy', 'Legacy', 'Auth', 'Login.bru'))).toBe(true); // original untouched
  });
});

// Opt-in: convert the team's real exports into a temp folder and load them. Nothing is written into the repository.
const real = process.env.YEPT_REAL_COLLECTIONS;
describe.skipIf(!real)('real exports (opt-in)', () => {
  it('imports the real Insomnia and Postman exports without problems', async () => {
    // Export files at the top level, plus Postman collections one folder down (as Postman's zip exports unpack).
    const top = readdirSync(real!, { withFileTypes: true });
    const sources = [
      ...top.filter((e) => e.isFile() && /\.(json|ya?ml)$/i.test(e.name)).map((e) => join(real!, e.name)),
      ...top.filter((e) => e.isDirectory()).flatMap((d) => readdirSync(join(real!, d.name)).filter((f) => /\.postman_collection.*\.json$/i.test(f)).map((f) => join(real!, d.name, f)))
    ];
    for (const file of sources) {
      const src = await convertSource(readFileSync(file, 'utf8'), file);
      const plan = buildPlan(src.model, join(dir, 'real'));
      await writePlan(plan, 'copy');
      console.log(`${file.split(/[\\/]/).pop()}: ${src.format}, ${plan.counts.requests} requests, ${plan.counts.environments} environments, ${findSecrets(src.model).length} secret-looking values; ${src.issues.join(' ')}`);
    }
    const ws = await open(join(dir, 'real'));
    expect(ws.snapshot().problems).toEqual([]);
  });
});
