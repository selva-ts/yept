// Packaging self-tests (`Yept --self-test`): prove that the packaged app can use node:sqlite, @usebruno/* packages, the cookie jar and worker sandboxes.
import { app } from 'electron';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CookieJar } from 'tough-cookie';
import { parseRequest, stringifyRequest } from '@usebruno/filestore';
import tls from 'node:tls';
import { caCertificates } from '@yept/core/engine/net/ca';
import brunoJs from '@usebruno/js';
import { SandboxHost, type SandboxHooks } from '@yept/core/engine/sandbox/host';
import sandboxWorkerPath from '@yept/core/engine/sandbox/worker.mjs?modulePath';
import type { SelfTestResult } from '@shared/ipc';
import { convertSource } from '@yept/core/engine/import/collection-io';
import { runGit } from '@yept/core/engine/git/git';

const SAMPLE_YML = `info:
  name: Ping
  type: http
  seq: 1

http:
  method: GET
  url: "{{baseUrl}}/ping"

settings:
  encodeUrl: true
  timeout: 0
  followRedirects: true
  maxRedirects: 5
  forwardAuthorizationHeader: false
`;

/** Appends a line to selftest-progress.txt, so a run that stops early shows how far it got. */
export function selfTestProgress(line: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'selftest-progress.txt'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Progress is only a diagnostic.
  }
}

async function timed(name: string, fn: () => Promise<string> | string): Promise<SelfTestResult> {
  const started = performance.now();
  selfTestProgress(`RUN ${name}`);
  try {
    const detail = await fn();
    selfTestProgress(`PASS ${name}`);
    return { name, ok: true, detail, ms: Math.round(performance.now() - started) };
  } catch (e) {
    selfTestProgress(`FAIL ${name}`);
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - started) };
  }
}

const response = { status: 200, statusText: 'OK', headers: {}, data: { ok: true }, responseTime: 1 };
const request = { method: 'GET', url: 'http://example.test', headers: {} };
const job = (script: string) => ({ kind: 'post-response' as const, script, request, response, envVariables: {}, runtimeVariables: {}, collectionPath: process.cwd(), collectionName: 'self-test', processEnv: {} });

export async function runSelfTests(): Promise<SelfTestResult[]> {
  return [
    await timed('node:sqlite (history store)', () => {
      const db = new DatabaseSync(join(app.getPath('userData'), 'selftest.db'));
      db.exec('CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL)');
      db.prepare('INSERT INTO runs (at) VALUES (?)').run(new Date().toISOString());
      const { n } = db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number };
      const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      db.close();
      return `SQLite ${v}, ${n} row(s) in ${app.getPath('userData')}`;
    }),
    await timed('@usebruno/filestore YAML round-trip', () => {
      const out = stringifyRequest(parseRequest(SAMPLE_YML, { format: 'yml' }), { format: 'yml' });
      if (out.trimEnd() !== SAMPLE_YML.trimEnd()) throw new Error('round-trip changed the file');
      return 'byte-identical';
    }),
    await timed('CA bundle (Windows store + Node roots)', () =>
      `${caCertificates().length} trusted roots (system ${tls.getCACertificates('system').length}, default ${tls.getCACertificates('default').length})`),
    await timed('@usebruno/js tests (in process)', async () => {
      const r = await new brunoJs.TestRuntime({ runtime: 'quickjs' }).runTests(
        'test("ok", () => { expect(res.status).to.equal(200); });',
        { method: 'GET', url: 'http://example.test', headers: {} },
        { status: 200, statusText: 'OK', headers: {}, data: {}, responseTime: 1 },
        {}, {}, process.cwd(), () => {}, {}, { runtime: 'quickjs' }
      );
      return JSON.stringify((r.results ?? []).map((t: { status: string }) => t.status));
    }),
    await timed('Import converters (Postman, pm.* script translation)', async () => {
      const pm = {
        info: { name: 'Self test', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ name: 'Ping', event: [{ listen: 'test', script: { exec: ['pm.environment.set("x", pm.response.json().id);'] } }], request: { method: 'GET', url: 'http://example.test/ping' } }]
      };
      const src = await convertSource(JSON.stringify(pm), 'self-test.json');
      const script = String(src.model.items[0]?.request?.script?.res ?? '');
      if (!script.includes('bru.setEnvVar')) throw new Error(`script not translated: ${script}`);
      return `${src.format}, script translated`;
    }),
    await timed('Git available', async () => {
      const r = await runGit(['--version'], process.cwd());
      if (!r.ok) throw new Error(r.stderr || 'git not found');
      return r.stdout.trim();
    }),
    await timed('Sandbox worker: script sets a variable and uses bru.sendRequest', async () => {
      const host = new SandboxHost(sandboxWorkerPath, { timeoutMs: 2000, poolSize: 1 });
      try {
        // The packaged @usebruno/requests stand-in hands the call to the host; nothing goes on the network here.
        const sendRequest: SandboxHooks['sendRequest'] = async (config) => ({
          reply: { ok: true, response: { status: 201, statusText: 'Created', headers: {}, data: { url: (config as { url: string }).url }, responseTime: 1 } }
        });
        const r = await host.run(job('bru.setVar("status", String(res.status)); const s = await bru.sendRequest({ url: "http://example.test/x" }); bru.setVar("sent", s.status + " " + s.data.url);'), { sendRequest });
        if (!r.ok || r.runtimeVariables?.status !== '200' || r.runtimeVariables?.sent !== '201 http://example.test/x') throw new Error(r.error ?? `variables ${JSON.stringify(r.runtimeVariables)}`);
        return 'status=200, sendRequest=201';
      } finally {
        await host.close();
      }
    }),
    await timed('Cookie jar and bru.cookies in the sandbox', async () => {
      const jar = new CookieJar();
      jar.setCookieSync('sid=abc; Path=/', 'http://example.test/');
      const host = new SandboxHost(sandboxWorkerPath, { timeoutMs: 2000, poolSize: 1 });
      try {
        const r = await host.run({ ...job('bru.setVar("sid", bru.cookies.get("sid")); await bru.cookies.upsert({ key: "lang", value: "en" });'), cookies: jar.serializeSync() });
        const names = (r.cookies?.cookies ?? []).map((c) => c.key).sort().join(',');
        if (!r.ok || r.runtimeVariables?.sid !== 'abc' || names !== 'lang,sid') throw new Error(r.error ?? `read ${r.runtimeVariables?.sid}, jar ${names}`);
        return 'read sid, added lang';
      } finally {
        await host.close();
      }
    }),
    await timed('Sandbox worker: runaway script stopped', async () => {
      const host = new SandboxHost(sandboxWorkerPath, { timeoutMs: 2000, poolSize: 1 });
      try {
        const r = await host.run(job('while (true) {}'));
        if (r.ok) throw new Error('runaway script was not stopped');
        return r.error ?? 'stopped';
      } finally {
        await host.close();
      }
    })
  ];
}
