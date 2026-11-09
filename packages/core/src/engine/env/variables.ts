// Variable layering. Precedence follows Bruno so shared collections behave the same in both tools
// (lowest to highest): collection < environment < folder (outer to inner) < request < runtime.
// The environment layer is itself built from: shared file < local override < local secret < script session.
import type { KeyValue, VarSource } from '../../shared/model';

export interface EnvLayer {
  /** Non-secret values from the shared environment file. */
  file: Record<string, string>;
  /** This machine's overrides. */
  overrides: Record<string, string>;
  /** This machine's secret values (decrypted). */
  secrets: Record<string, string>;
  /** Values set by scripts with bru.setEnvVar during this app session. */
  session: Record<string, string>;
}

export interface VarLayers {
  collection: KeyValue[];
  environment: EnvLayer;
  folders: KeyValue[][];
  request: KeyValue[];
  runtime: Record<string, string>;
}

const enabledMap = (list: KeyValue[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const v of list) if (v.enabled && v.name) out[v.name] = v.value;
  return out;
};

export const emptyEnvLayer = (): EnvLayer => ({ file: {}, overrides: {}, secrets: {}, session: {} });

/** The merged environment as scripts see it (bru.getEnvVar). */
export function envVariables(env: EnvLayer): Record<string, string> {
  return { ...env.file, ...env.overrides, ...env.secrets, ...env.session };
}

export interface Resolved {
  values: Record<string, string>;
  sources: Record<string, VarSource>;
  collection: Record<string, string>;
  folder: Record<string, string>;
  request: Record<string, string>;
}

export function resolveLayers(l: VarLayers): Resolved {
  const values: Record<string, string> = {};
  const sources: Record<string, VarSource> = {};
  const put = (map: Record<string, string>, source: VarSource): void => {
    for (const [k, v] of Object.entries(map)) {
      values[k] = v;
      sources[k] = source;
    }
  };
  const collection = enabledMap(l.collection);
  const folder = Object.assign({}, ...l.folders.map(enabledMap)) as Record<string, string>;
  const request = enabledMap(l.request);
  put(collection, 'collection');
  put(l.environment.file, 'environment');
  put(l.environment.overrides, 'override');
  put(l.environment.secrets, 'secret');
  put(l.environment.session, 'session');
  for (const f of l.folders) put(enabledMap(f), 'folder');
  put(request, 'request');
  put(l.runtime, 'runtime');
  return { values, sources, collection, folder, request };
}
