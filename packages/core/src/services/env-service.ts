// Environments for the main process: shared files (via the workspace) plus this machine's local layers.
// Secret values are encrypted with Electron safeStorage (Windows DPAPI) and never sent to the renderer
// except on an explicit "reveal".
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { LocalStore } from '@yept/core/engine/env/local-store';
import { emptyEnvLayer, resolveLayers, type VarLayers } from '@yept/core/engine/env/variables';
import { caFileAnchors } from '@yept/core/engine/net/ca';
import type { VariableUpdates } from '@yept/core/engine/runner/runner';
import type { RequestContext, Workspace } from '@yept/core/engine/workspace/workspace';
import type { EnvironmentList, RequestPreview } from '@yept/core/shared/ipc';
import type { AuthConfig, Environment, EnvironmentView, RequestDoc, ResolvedVar, TlsSettings } from '@yept/core/shared/model';
import type { AppHost } from './host';

/** What {{name}} can refer to and a collection file can hold. */
export const VARIABLE_NAME = /^[A-Za-z_][\w.-]{0,127}$/;

export interface RunEnvironment {
  environment: string;
  layers: VarLayers;
  secretNames: string[];
  tls: { skipVerify: boolean; ca?: string[] };
}

export class EnvService {
  private store: LocalStore | null = null;
  /** In-memory, per (collection, environment): runtime variables and script session values. */
  private runtime = new Map<string, Record<string, string>>();
  private session = new Map<string, Record<string, string>>();

  /** A store passed in is shared with other services, so their saved selections and secrets stay in step. */
  constructor(private ws: () => Workspace, private host: Pick<AppHost, 'userDataPath' | 'cipher'>, store?: LocalStore) {
    this.store = store ?? null;
  }

  private local(): LocalStore {
    this.store ??= new LocalStore(join(this.host.userDataPath(), 'local-environments.json'), this.host.cipher);
    return this.store;
  }

  private key(dir: string, env: string): string {
    return `${dir.toLowerCase()}::${env}`;
  }

  active(collectionId: string): string | null {
    const dir = this.ws().collectionDir(collectionId);
    const name = this.local().activeEnv(dir);
    return name && this.ws().getEnvironment(collectionId, name) ? name : null;
  }

  list(collectionId: string): EnvironmentList {
    const ws = this.ws();
    const dir = ws.collectionDir(collectionId);
    const local = this.local();
    const environments: EnvironmentView[] = ws.listEnvironments(collectionId).map(({ env, path }) => {
      const overrides = local.overrides(dir, env.name);
      const secretNames = new Set(local.secretNames(dir, env.name));
      return {
        name: env.name,
        path,
        tls: local.tls(dir, env.name),
        variables: env.variables.map((v) => ({ ...v, override: overrides[v.name], hasSecret: secretNames.has(v.name) }))
      };
    });
    return { collectionId, readOnly: ws.getSettings(collectionId).readOnly, active: this.active(collectionId), environments };
  }

  setActive(collectionId: string, name: string | null): EnvironmentList {
    this.local().setActiveEnv(this.ws().collectionDir(collectionId), name ?? undefined);
    return this.list(collectionId);
  }

  async save(collectionId: string, previousName: string | null, env: Environment): Promise<EnvironmentList> {
    const dir = this.ws().collectionDir(collectionId);
    await this.ws().saveEnvironment(collectionId, previousName, env);
    if (previousName && previousName !== env.name) {
      this.local().renameEnv(dir, previousName, env.name);
      for (const m of [this.runtime, this.session]) {
        const v = m.get(this.key(dir, previousName));
        m.delete(this.key(dir, previousName));
        if (v) m.set(this.key(dir, env.name), v);
      }
    }
    return this.list(collectionId);
  }

  async remove(collectionId: string, name: string): Promise<EnvironmentList> {
    const dir = this.ws().collectionDir(collectionId);
    await this.ws().deleteEnvironment(collectionId, name);
    this.local().deleteEnv(dir, name);
    this.runtime.delete(this.key(dir, name));
    this.session.delete(this.key(dir, name));
    return this.list(collectionId);
  }

  setOverride(collectionId: string, env: string, name: string, value: string | null): EnvironmentList {
    this.local().setOverride(this.ws().collectionDir(collectionId), env, name, value ?? undefined);
    return this.list(collectionId);
  }

  setSecret(collectionId: string, env: string, name: string, value: string | null): EnvironmentList {
    this.local().setSecret(this.ws().collectionDir(collectionId), env, name, value ?? undefined);
    return this.list(collectionId);
  }

  revealSecret(collectionId: string, env: string, name: string): string | null {
    return this.local().secrets(this.ws().collectionDir(collectionId), env)[name] ?? null;
  }

  setTls(collectionId: string, env: string, tls: TlsSettings): EnvironmentList {
    this.local().setTls(this.ws().collectionDir(collectionId), env, tls);
    return this.list(collectionId);
  }

  async storeAsSecret(collectionId: string, env: string, name: string, value: string): Promise<EnvironmentList> {
    const current = this.ws().getEnvironment(collectionId, env);
    if (!current) throw new Error(`Environment not found: ${env}`);
    const existing = current.variables.find((v) => v.name === name);
    if (!existing || !existing.secret) {
      const variables = existing
        ? current.variables.map((v) => (v.name === name ? { ...v, secret: true, value: '' } : v))
        : [...current.variables, { name, value: '', secret: true, enabled: true }];
      await this.ws().saveEnvironment(collectionId, env, { ...current, variables });
    }
    this.local().setSecret(this.ws().collectionDir(collectionId), env, name, value);
    return this.list(collectionId);
  }

  allSecretValues(collectionDirs: string[]): string[] {
    return this.local().allSecretValues(collectionDirs);
  }

  /** Stores imported secret values as local secrets for a collection's environments. */
  storeImportedSecrets(collectionId: string, values: { name: string; value: string; environment: string | null }[]): void {
    const dir = this.ws().collectionDir(collectionId);
    const envs = this.ws().listEnvironments(collectionId).map((e) => e.env.name);
    for (const v of values) for (const env of v.environment ? [v.environment] : envs) this.local().setSecret(dir, env, v.name, v.value);
  }

  /** Sets one runtime variable for this session, as an extraction would ("Set as variable" in the response). */
  setRuntime(collectionId: string, env: string, name: string, value: string): void {
    if (!this.ws().getEnvironment(collectionId, env)) throw new Error(`Environment not found: ${env}`);
    if (!VARIABLE_NAME.test(name)) throw new Error('Use letters, digits, _ . or - for the variable name');
    const k = this.key(this.ws().collectionDir(collectionId), env);
    this.runtime.set(k, { ...(this.runtime.get(k) ?? {}), [name]: value });
  }

  clearRuntime(collectionId: string, env: string): void {
    const dir = this.ws().collectionDir(collectionId);
    this.runtime.delete(this.key(dir, env));
    this.session.delete(this.key(dir, env));
  }

  /**
   * Builds the variable layers for a run or preview: in the collection's active environment, or in `chosen` (a collection
   * run captures its environment when it starts; '' for none).
   */
  async forRun(ctx: RequestContext, chosen?: string): Promise<RunEnvironment> {
    const environment = chosen ?? this.active(ctx.collectionId) ?? '';
    const env = environment ? this.ws().getEnvironment(ctx.collectionId, environment) : undefined;
    if (environment && !env) throw new Error(`Environment not found: ${environment}`);
    const dir = ctx.collectionDir;
    const local = this.local();
    const file: Record<string, string> = {};
    for (const v of env?.variables ?? []) if (v.enabled && !v.secret) file[v.name] = v.value;
    const layer = environment
      ? {
          file,
          overrides: local.overrides(dir, environment),
          secrets: local.secrets(dir, environment),
          session: { ...(this.session.get(this.key(dir, environment)) ?? {}) }
        }
      : emptyEnvLayer();
    const tls = environment ? local.tls(dir, environment) : { skipVerify: false, caFile: '' };
    let ca: string[] | undefined;
    if (tls.caFile) {
      let pem: string;
      try {
        pem = await fs.readFile(tls.caFile, 'utf8');
      } catch (e) {
        throw new Error(`Can't read the CA certificate file for "${environment}": ${(e as Error).message}`);
      }
      try {
        ca = caFileAnchors(pem);
      } catch (e) {
        throw new Error(`Can't use the CA certificate file for "${environment}": ${(e as Error).message}`);
      }
    }
    return {
      environment,
      secretNames: (env?.variables ?? []).filter((v) => v.secret).map((v) => v.name),
      tls: { skipVerify: tls.skipVerify, ca },
      layers: {
        collection: ctx.collection.vars,
        environment: layer,
        folders: ctx.folders.map((f) => f.vars),
        request: [],
        runtime: { ...(environment ? (this.runtime.get(this.key(dir, environment)) ?? {}) : {}) }
      }
    };
  }

  /** Stores what a run produced: runtime map replaced, session merged, secrets written encrypted. */
  apply(collectionDir: string, environment: string, updates: VariableUpdates): void {
    if (!environment) return; // without an environment, nothing is kept between runs
    const k = this.key(collectionDir, environment);
    this.runtime.set(k, updates.runtime);
    const session = { ...(this.session.get(k) ?? {}) };
    for (const [name, v] of Object.entries(updates.session)) {
      if (v === undefined) delete session[name];
      else session[name] = v;
    }
    this.session.set(k, session);
    if (Object.keys(updates.secrets).length) this.local().setSecrets(collectionDir, environment, updates.secrets);
  }

  /** How a request resolves in the active environment, and the auth it will actually use after inheritance. */
  async requestPreview(ctx: RequestContext, doc: RequestDoc): Promise<RequestPreview> {
    const e = await this.forRun(ctx);
    let auth: AuthConfig = doc.auth;
    let authFrom = 'request';
    if (auth.mode === 'inherit') {
      const folder = [...ctx.folders].reverse().find((f) => f.auth.mode !== 'inherit');
      if (folder) {
        auth = folder.auth;
        authFrom = `folder "${folder.name}"`;
      } else if (ctx.collection.auth.mode !== 'inherit') {
        auth = ctx.collection.auth;
        authFrom = `collection "${ctx.collectionName}"`;
      } else {
        auth = { ...auth, mode: 'none' };
        authFrom = `collection "${ctx.collectionName}"`;
      }
    }
    return { environment: e.environment || null, vars: this.preview(e.layers, doc.vars.req, e.secretNames), auth, authFrom, skipVerify: e.tls.skipVerify };
  }

  /** Resolved variables for the preview line, secret values masked. */
  preview(layers: VarLayers, requestVars: VarLayers['request'], secretNames: string[]): ResolvedVar[] {
    const r = resolveLayers({ ...layers, request: requestVars });
    const secret = new Set([...secretNames, ...Object.keys(layers.environment.secrets)]);
    return Object.entries(r.values).map(([name, value]) => ({
      name,
      value: secret.has(name) && r.sources[name] === 'secret' ? '••••••' : value,
      source: r.sources[name],
      secret: secret.has(name)
    }));
  }
}
