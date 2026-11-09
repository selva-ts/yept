// Two-way sync between the URL and the Params table, as in Bruno: the URL is the source of truth for
// enabled query params; disabled ones live only in the table. Values stay raw (no decoding) so {{vars}} survive.
import type { Param } from './model';

function split(url: string): { base: string; query: string; hash: string } {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = noHash.indexOf('?');
  return q >= 0 ? { base: noHash.slice(0, q), query: noHash.slice(q + 1), hash } : { base: noHash, query: '', hash };
}

export function queryFromUrl(url: string): { name: string; value: string }[] {
  const { query } = split(url);
  if (!query) return [];
  return query.split('&').filter((p) => p !== '').map((pair) => {
    const eq = pair.indexOf('=');
    return eq >= 0 ? { name: pair.slice(0, eq), value: pair.slice(eq + 1) } : { name: pair, value: '' };
  });
}

export function pathParamNames(url: string): string[] {
  const { base } = split(url);
  const withoutOrigin = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return [...withoutOrigin.matchAll(/\/:([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/** After the URL was edited: rebuild query params from it, keep disabled ones, keep path param values. */
export function paramsFromUrl(url: string, current: Param[]): Param[] {
  const query: Param[] = queryFromUrl(url).map((q) => ({ ...q, enabled: true, type: 'query' }));
  const disabled = current.filter((p) => p.type === 'query' && !p.enabled);
  const path: Param[] = pathParamNames(url).map((name) => {
    const existing = current.find((p) => p.type === 'path' && p.name === name);
    return existing ?? { name, value: '', enabled: true, type: 'path' };
  });
  return [...query, ...disabled, ...path];
}

/** After the Params table was edited: rewrite the URL's query from the enabled query params. */
export function urlFromParams(url: string, params: Param[]): string {
  const { base, hash } = split(url);
  const query = params
    .filter((p) => p.type === 'query' && p.enabled && p.name !== '')
    .map((p) => (p.value === '' ? p.name : `${p.name}=${p.value}`))
    .join('&');
  return `${base}${query ? `?${query}` : ''}${hash}`;
}
