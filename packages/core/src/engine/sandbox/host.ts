// Runs user scripts in warm worker threads with a hard time limit.
// A worker that times out or is cancelled is terminated and replaced, so one runaway script never blocks the next run.
// bru.sendRequest calls come back from the worker as messages; the caller's hook sends them, inside the same time limit.
import { Worker } from 'node:worker_threads';
import type { SerializedCookieJar } from 'tough-cookie';
import type { KeyValue } from '../../shared/model';

export interface SandboxRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  data?: unknown;
  timeout?: number;
  collectionVariables?: Record<string, string>;
  folderVariables?: Record<string, string>;
  requestVariables?: Record<string, string>;
}

export interface SandboxResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  data: unknown;
  responseTime: number;
}

export interface SandboxJob {
  kind: 'pre-request' | 'post-response' | 'post-vars' | 'tests' | 'assertions';
  script?: string;
  vars?: KeyValue[];
  assertions?: KeyValue[];
  request: SandboxRequest;
  response?: SandboxResponse;
  envVariables: Record<string, string>;
  runtimeVariables: Record<string, string>;
  collectionPath: string;
  collectionName: string;
  processEnv: Record<string, string>;
  /** A copy of the request's cookie jar for bru.cookies. Absent when automatic cookies are off. */
  cookies?: SerializedCookieJar;
}

export interface SandboxResult {
  ok: boolean;
  /** Script error, timeout or post-response-variable errors. */
  error?: string;
  request?: Omit<SandboxRequest, 'collectionVariables' | 'folderVariables' | 'requestVariables'>;
  /** Full new values when the script changed them, otherwise null. */
  envVariables: Record<string, string> | null;
  runtimeVariables: Record<string, string> | null;
  logs: { level: string; text: string }[];
  /** Raw test or assertion results from @usebruno/js (kind 'tests' / 'assertions'). */
  results?: RawResult[];
  /** The whole jar when a script changed cookies, otherwise absent. */
  cookies?: SerializedCookieJar;
  /** True when the caller's signal stopped the script. */
  cancelled?: boolean;
}

/** What bru.sendRequest resolves with: the fields of an axios response that scripts use. */
export interface ScriptHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  /** Parsed JSON, or the body as text. */
  data: unknown;
  responseTime: number;
}

/** What bru.sendRequest rejects with, shaped like an axios error. `response` is set for a non-2xx status. */
export interface ScriptHttpError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  response?: ScriptHttpResponse;
}

export type ScriptSendReply = { ok: true; response: ScriptHttpResponse } | { ok: false; error: ScriptHttpError };

export interface SandboxHooks {
  /** Stops the script (and any request it is waiting for). */
  signal?: AbortSignal;
  /**
   * Sends a bru.sendRequest call. `cookies` is the script's changed copy of the jar, to apply before sending;
   * `signal` aborts when the script ends, times out or is cancelled. Returns the reply and the jar afterwards.
   */
  sendRequest?: (config: unknown, cookies: SerializedCookieJar | null, signal: AbortSignal) => Promise<{ reply: ScriptSendReply; cookies?: SerializedCookieJar }>;
}

export interface RawResult {
  status?: string;
  description?: string;
  error?: string;
  lhsExpr?: string;
  rhsExpr?: string;
}

interface Slot {
  worker: Worker;
  busy: boolean;
}

export interface SandboxOptions {
  timeoutMs?: number;
  poolSize?: number;
  /** Worker heap cap. QuickJS memory sits outside it, so the timeout is the hard stop. */
  maxOldGenerationSizeMb?: number;
}

let jobSeq = 0;

export class SandboxHost {
  private slots: Slot[] = [];
  private waiting: ((slot: Slot) => void)[] = [];
  private readonly timeoutMs: number;
  private closed = false;

  constructor(private workerPath: string | URL, private options: SandboxOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    for (let i = 0; i < (options.poolSize ?? 2); i++) this.slots.push({ worker: this.spawn(), busy: false });
  }

  private spawn(): Worker {
    const w = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb ?? 256 } });
    w.unref();
    return w;
  }

  private acquire(): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(slot: Slot): void {
    const next = this.waiting.shift();
    if (next) next(slot);
    else slot.busy = false;
  }

  async run(job: SandboxJob, hooks: SandboxHooks = {}): Promise<SandboxResult> {
    if (this.closed) throw new Error('Sandbox is closed');
    const cancelled = (): SandboxResult => ({ ok: false, error: 'Cancelled', cancelled: true, envVariables: null, runtimeVariables: null, logs: [] });
    if (hooks.signal?.aborted) return cancelled();
    const slot = await this.acquire();
    if (hooks.signal?.aborted) {
      this.release(slot);
      return cancelled();
    }
    const id = ++jobSeq;
    // Ends every bru.sendRequest still in flight when the script finishes, times out or is cancelled.
    const sends = new AbortController();
    const inFlight = new Set<Promise<void>>();
    return new Promise<SandboxResult>((resolve) => {
      let done = false;
      const finish = (r: SandboxResult, replace = false): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        hooks.signal?.removeEventListener('abort', onCancel);
        sends.abort();
        slot.worker.off('message', onMessage);
        slot.worker.off('error', onError);
        if (replace) {
          void slot.worker.terminate();
          slot.worker = this.spawn();
        }
        this.release(slot);
        // Requests stopped by the abort above finish quickly; waiting lets the caller record them with this result.
        void Promise.allSettled([...inFlight]).then(() => resolve(r));
      };
      const onSend = async (m: { callId: number; config: unknown; cookies: SerializedCookieJar | null }): Promise<void> => {
        let out: { reply: ScriptSendReply; cookies?: SerializedCookieJar };
        try {
          out = hooks.sendRequest
            ? await hooks.sendRequest(m.config, m.cookies, sends.signal)
            : { reply: { ok: false, error: { name: 'Error', message: 'bru.sendRequest is not available here' } } };
        } catch (e) {
          out = { reply: { ok: false, error: { name: 'Error', message: `bru.sendRequest failed: ${(e as Error).message}` } } };
        }
        if (!done) slot.worker.postMessage({ type: 'send-result', callId: m.callId, ...out.reply, cookies: out.cookies ?? null });
      };
      const onMessage = (m: { id: number; type?: string; ok: boolean; error?: string; logs: SandboxResult['logs']; result?: Omit<SandboxResult, 'ok' | 'logs'>; callId: number; config: unknown; cookies: SerializedCookieJar | null }): void => {
        if (m.id !== id) return;
        if (m.type === 'send') {
          const p = onSend(m).finally(() => inFlight.delete(p));
          inFlight.add(p);
          return;
        }
        if (m.ok) finish({ ok: !m.result?.error, error: m.result?.error ?? undefined, request: m.result?.request, envVariables: m.result?.envVariables ?? null, runtimeVariables: m.result?.runtimeVariables ?? null, logs: m.logs, results: m.result?.results, cookies: m.result?.cookies ?? undefined });
        else finish({ ok: false, error: m.error, envVariables: null, runtimeVariables: null, logs: m.logs, results: m.result?.results });
      };
      const onError = (e: Error): void => finish({ ok: false, error: `Sandbox crashed: ${e.message}`, envVariables: null, runtimeVariables: null, logs: [] }, true);
      const timer = setTimeout(() => {
        const waiting = inFlight.size ? ', while waiting for bru.sendRequest (requests a script sends count towards its time limit)' : '';
        finish({ ok: false, error: `Script timed out after ${this.timeoutMs} ms and was stopped${waiting}`, envVariables: null, runtimeVariables: null, logs: [] }, true);
      }, this.timeoutMs);
      const onCancel = (): void => finish(cancelled(), true);
      hooks.signal?.addEventListener('abort', onCancel, { once: true });
      slot.worker.on('message', onMessage);
      slot.worker.once('error', onError);
      slot.worker.postMessage({ id, ...job });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}
