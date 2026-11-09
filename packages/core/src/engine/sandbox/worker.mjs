// Sandbox worker: runs one script job at a time through @usebruno/js in QuickJS.
// The host terminates this worker on timeout; that's the hard stop for runaway scripts.
// Plain JavaScript on purpose: it runs as-is under Vitest and is bundled by electron-vite for the app.
import { parentPort } from 'node:worker_threads';
import brunoJs from '@usebruno/js';
import quickjs from '@usebruno/js/src/sandbox/quickjs/index.js';
import { CookieJar } from 'tough-cookie';

const { ScriptRuntime, VarsRuntime, TestRuntime, AssertRuntime } = brunoJs;
// QuickJS loads asynchronously on first require; synchronous runs (post-response variables) fail with
// "reading 'newContext'" until it's ready, so every job waits for Bruno's own loader first.
const ready = quickjs.loader();
const CONFIG = { runtime: 'quickjs' };

const text = (a) => {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
};

// Only plain data crosses back to the host.
const plainRequest = (r) =>
  r ? { method: r.method, url: r.url, headers: { ...(r.headers ?? {}) }, data: r.data, timeout: r.timeout } : undefined;

// bru.cookies works on a copy of the request's jar; the copy goes back to the host only if a script changed it.
// The local @usebruno/requests stand-in reads this bridge from globalThis.
function cookieBridge(data) {
  const state = { jar: CookieJar.deserializeSync(data), dirty: false };
  const plain = (c) => ({
    key: c.key,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expires: c.expires instanceof Date ? c.expires.toISOString() : undefined
  });
  const forUrl = (url) => state.jar.getCookiesSync(url);
  const keep = (predicate) => {
    const s = state.jar.serializeSync();
    state.jar = CookieJar.deserializeSync({ ...s, cookies: s.cookies.filter(predicate) });
    state.dirty = true;
  };
  const put = (url, c) => {
    const key = c.key ?? c.name;
    if (!key) throw new Error('A cookie needs a key');
    let line = `${key}=${c.value ?? ''}; Path=${c.path ?? '/'}`;
    if (c.domain) line += `; Domain=${c.domain}`;
    if (c.expires) line += `; Expires=${new Date(c.expires).toUTCString()}`;
    if (c.secure) line += '; Secure';
    if (c.httpOnly) line += '; HttpOnly';
    if (c.sameSite) line += `; SameSite=${c.sameSite}`;
    state.jar.setCookieSync(line, url);
    state.dirty = true;
  };
  // Node-style callback when given, otherwise a promise, like Bruno's own jar.
  const reply = (cb, fn) => {
    let value;
    try {
      value = fn();
    } catch (e) {
      if (typeof cb === 'function') return void cb(e, null);
      return Promise.reject(e);
    }
    if (typeof cb === 'function') return void cb(null, value);
    return Promise.resolve(value);
  };
  // A filter that keeps every cookie except those sent to `url` (and named `name`, when given).
  const notFor = (url, name) => {
    const hit = forUrl(url).filter((m) => name === undefined || m.key === name);
    return (c) => !hit.some((m) => m.key === c.key && m.domain === c.domain && m.path === c.path);
  };
  const jar = {
    getCookie: (url, name, cb) => reply(cb, () => {
      const c = forUrl(url).find((x) => x.key === name);
      return c ? plain(c) : null;
    }),
    getCookies: (url, cb) => reply(cb, () => forUrl(url).map(plain)),
    hasCookie: (url, name, cb) => reply(cb, () => forUrl(url).some((x) => x.key === name)),
    setCookie: (url, nameOrCookie, valueOrCb, maybeCb) => {
      if (nameOrCookie && typeof nameOrCookie === 'object') return reply(typeof valueOrCb === 'function' ? valueOrCb : undefined, () => put(url, nameOrCookie));
      const cb = typeof maybeCb === 'function' ? maybeCb : typeof valueOrCb === 'function' ? valueOrCb : undefined;
      return reply(cb, () => put(url, { key: nameOrCookie, value: typeof valueOrCb === 'string' ? valueOrCb : '' }));
    },
    setCookies: (url, cookies, cb) => reply(cb, () => (cookies ?? []).forEach((c) => put(url, c))),
    deleteCookie: (url, name, cb) => reply(cb, () => keep(notFor(url, name))),
    deleteCookies: (url, cb) => reply(cb, () => keep(notFor(url))),
    clear: (cb) => reply(cb, () => keep(() => false))
  };
  return {
    jar: () => jar,
    getCookiesForUrl: (url) => forUrl(url).map(plain),
    changed: () => (state.dirty ? state.jar.serializeSync() : null),
    // After a bru.sendRequest the host's jar is current (it took this copy's changes first): start again from it.
    reset: (data) => {
      state.jar = CookieJar.deserializeSync(data);
      state.dirty = false;
    }
  };
}

// bru.sendRequest: the host sends the request through Yept's runner and replies with an axios-shaped response
// or error. Only plain data crosses: the options are copied as JSON, so functions in them are dropped.
const pendingSends = new Map();
let sendSeq = 0;

function sendBridge(jobId, cookies) {
  return (config) =>
    new Promise((resolve, reject) => {
      const callId = ++sendSeq;
      pendingSends.set(callId, { resolve, reject, cookies });
      let plainConfig;
      try {
        plainConfig = config === undefined ? null : JSON.parse(JSON.stringify(config));
      } catch (e) {
        pendingSends.delete(callId);
        reject(new Error(`bru.sendRequest: the options can't be sent (${e?.message ?? e})`));
        return;
      }
      parentPort.postMessage({ id: jobId, type: 'send', callId, config: plainConfig, cookies: cookies?.changed() ?? null });
    });
}

function settleSend(m) {
  const p = pendingSends.get(m.callId);
  if (!p) return;
  pendingSends.delete(m.callId);
  if (m.cookies) p.cookies?.reset(m.cookies);
  if (m.ok) p.resolve(m.response);
  else {
    // An Error with the axios fields as own properties: @usebruno/js copies them into QuickJS. The worker's own
    // stack would only point at this file.
    const err = Object.assign(new Error(m.error?.message ?? 'bru.sendRequest failed'), m.error ?? {});
    delete err.stack;
    p.reject(err);
  }
}

parentPort.on('message', async (job) => {
  if (job.type === 'send-result') {
    settleSend(job);
    return;
  }
  const logs = [];
  const onConsoleLog = (level, args) => logs.push({ level, text: (args ?? []).map(text).join(' ') });
  const cookies = job.cookies ? cookieBridge(job.cookies) : null;
  globalThis.__yeptCookies = cookies;
  globalThis.__yeptSendRequest = sendBridge(job.id, cookies);
  try {
    await ready;
    let r;
    if (job.kind === 'pre-request') {
      r = await new ScriptRuntime(CONFIG).runRequestScript(
        job.script, job.request, job.envVariables, job.runtimeVariables, job.collectionPath, onConsoleLog, job.processEnv, CONFIG, null, {}, null, job.collectionName
      );
    } else if (job.kind === 'post-response') {
      r = await new ScriptRuntime(CONFIG).runResponseScript(
        job.script, job.request, job.response, job.envVariables, job.runtimeVariables, job.collectionPath, onConsoleLog, job.processEnv, CONFIG, null, {}, null, job.collectionName
      );
    } else if (job.kind === 'post-vars') {
      r = new VarsRuntime(CONFIG).runPostResponseVars(job.vars, job.request, job.response, job.envVariables, job.runtimeVariables, job.collectionPath, job.processEnv);
    } else if (job.kind === 'tests') {
      try {
        r = await new TestRuntime(CONFIG).runTests(
          job.script, job.request, job.response, job.envVariables, job.runtimeVariables, job.collectionPath, onConsoleLog, job.processEnv, CONFIG, null, {}, null, job.collectionName
        );
      } catch (e) {
        // A syntax error or a top-level throw stops the whole script; keep any tests that already ran.
        const partial = e?.partialResults?.results ?? [];
        parentPort.postMessage({ id: job.id, ok: false, logs, error: String(e?.message ?? e), result: { results: partial } });
        return;
      }
    } else if (job.kind === 'assertions') {
      r = { results: new AssertRuntime(CONFIG).runAssertions(job.assertions, job.request, job.response, job.envVariables, job.runtimeVariables, job.processEnv) };
    } else {
      throw new Error(`Unknown sandbox job: ${job.kind}`);
    }
    parentPort.postMessage({
      id: job.id,
      ok: true,
      logs,
      result: {
        request: plainRequest(r?.request),
        envVariables: r?.envVariables ?? null,
        runtimeVariables: r?.runtimeVariables ?? null,
        error: r?.error ?? null,
        results: r?.results ? JSON.parse(JSON.stringify(r.results)) : undefined,
        cookies: cookies?.changed() ?? null
      }
    });
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, logs, error: String(e?.message ?? e) });
  }
});
