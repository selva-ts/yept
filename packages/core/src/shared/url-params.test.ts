import { describe, expect, it } from 'vitest';
import { paramsFromUrl, pathParamNames, queryFromUrl, urlFromParams } from './url-params';
import type { Param } from './model';

describe('url-params', () => {
  it('parses query pairs without decoding', () => {
    expect(queryFromUrl('{{baseUrl}}/x?a=1&b={{id}}&c&d=a%20b#frag')).toEqual([
      { name: 'a', value: '1' }, { name: 'b', value: '{{id}}' }, { name: 'c', value: '' }, { name: 'd', value: 'a%20b' }
    ]);
  });

  it('finds path params but not the port', () => {
    expect(pathParamNames('http://localhost:4010/users/:id/orders/:orderId?x=:y')).toEqual(['id', 'orderId']);
  });

  it('URL edits rebuild query params and keep disabled ones and path values', () => {
    const current: Param[] = [
      { name: 'old', value: '1', enabled: true, type: 'query' },
      { name: 'off', value: '2', enabled: false, type: 'query' },
      { name: 'id', value: '42', enabled: true, type: 'path' }
    ];
    expect(paramsFromUrl('/users/:id?new=3', current)).toEqual([
      { name: 'new', value: '3', enabled: true, type: 'query' },
      { name: 'off', value: '2', enabled: false, type: 'query' },
      { name: 'id', value: '42', enabled: true, type: 'path' }
    ]);
  });

  it('table edits rewrite only the query, keeping the fragment', () => {
    const params: Param[] = [
      { name: 'a', value: '1', enabled: true, type: 'query' },
      { name: 'b', value: '', enabled: true, type: 'query' },
      { name: 'c', value: '3', enabled: false, type: 'query' }
    ];
    expect(urlFromParams('{{baseUrl}}/x?zzz=9#top', params)).toBe('{{baseUrl}}/x?a=1&b#top');
    expect(urlFromParams('{{baseUrl}}/x?zzz=9', [])).toBe('{{baseUrl}}/x');
  });

  it('round-trips', () => {
    const url = 'https://api.example.test/v1/items?page=2&q={{term}}';
    expect(urlFromParams(url, paramsFromUrl(url, []))).toBe(url);
  });
});
