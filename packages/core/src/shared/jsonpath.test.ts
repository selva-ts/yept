import { describe, expect, it } from 'vitest';
import { checkJsonPath, JSONPATH_MAX_MATCHES, queryJsonPath, suggestVariableName, variableText } from './jsonpath';

const store = {
  store: {
    book: [
      { category: 'reference', author: 'A. Example', title: 'Sample Atlas', price: 8.95 },
      { category: 'fiction', author: 'B. Sample', title: 'Test Voyage', price: 12.99 },
      { category: 'fiction', author: 'C. Fixture', title: 'Mock Harbour', isbn: '0-000-00000-0', price: 8.99 },
      { category: 'fiction', author: 'D. Demo', title: 'Stub Lantern', isbn: '0-000-00000-1', price: 22.99 }
    ],
    bicycle: { color: 'red', price: 19.95 },
    'x-request-id': 'req-1'
  },
  limit: 10
};

const values = (expr: string, root: unknown = store): unknown[] => {
  const r = queryJsonPath(root, expr);
  if (!r.ok) throw new Error(r.error);
  return r.matches.map((m) => m.value);
};
const paths = (expr: string, root: unknown = store): string[] => {
  const r = queryJsonPath(root, expr);
  if (!r.ok) throw new Error(r.error);
  return r.matches.map((m) => m.path);
};

describe('queryJsonPath', () => {
  it('selects children with dots and brackets', () => {
    expect(values('$.store.bicycle.color')).toEqual(['red']);
    expect(values("$['store']['bicycle']['color']")).toEqual(['red']);
    expect(values('$["store"].bicycle["price"]')).toEqual([19.95]);
    expect(values('$.store.x-request-id')).toEqual(['req-1']);
    expect(values('$')).toEqual([store]);
  });

  it('is permissive about the leading $', () => {
    expect(values('store.bicycle.color')).toEqual(['red']);
    expect(values('.store.bicycle.color')).toEqual(['red']);
    expect(values('[\'limit\']')).toEqual([10]);
    expect(values('')).toEqual([store]);
  });

  it('indexes arrays, including from the end', () => {
    expect(values('$.store.book[0].title')).toEqual(['Sample Atlas']);
    expect(values('$.store.book[-1].title')).toEqual(['Stub Lantern']);
    expect(values('$.store.book[9]')).toEqual([]);
    expect(values('$.store.book[0,2].price')).toEqual([8.95, 8.99]);
  });

  it('slices arrays', () => {
    expect(values('$.store.book[1:3].price')).toEqual([12.99, 8.99]);
    expect(values('$.store.book[:2].price')).toEqual([8.95, 12.99]);
    expect(values('$.store.book[-2:].price')).toEqual([8.99, 22.99]);
    expect(values('$.store.book[::2].price')).toEqual([8.95, 8.99]);
    expect(values('$.store.book[::-1].price')).toEqual([22.99, 8.99, 12.99, 8.95]);
  });

  it('takes wildcards and recursive descent', () => {
    expect(values('$.store.book[*].author')).toEqual(['A. Example', 'B. Sample', 'C. Fixture', 'D. Demo']);
    expect(values('$.store.bicycle.*')).toEqual(['red', 19.95]);
    expect(values('$..price')).toEqual([8.95, 12.99, 8.99, 22.99, 19.95]);
    expect(values('$..book[2].title')).toEqual(['Mock Harbour']);
    expect(values('$..book[-1:].title')).toEqual(['Stub Lantern']);
    expect(values('$..*').length).toBeGreaterThan(20);
  });

  it('filters with comparisons, existence and logic', () => {
    expect(values('$.store.book[?(@.price < 10)].title')).toEqual(['Sample Atlas', 'Mock Harbour']);
    expect(values('$.store.book[?(@.isbn)].title')).toEqual(['Mock Harbour', 'Stub Lantern']);
    expect(values('$.store.book[?(!@.isbn)].title')).toEqual(['Sample Atlas', 'Test Voyage']);
    expect(values("$.store.book[?(@.category == 'fiction' && @.price > 20)].title")).toEqual(['Stub Lantern']);
    expect(values('$.store.book[?(@.price < 9 || @.price > 20)].title')).toEqual(['Sample Atlas', 'Mock Harbour', 'Stub Lantern']);
    expect(values('$.store.book[?@.price >= 12.99].title')).toEqual(['Test Voyage', 'Stub Lantern']);
    expect(values('$.store.book[?(@.price < $.limit)].title')).toEqual(['Sample Atlas', 'Mock Harbour']);
    expect(values("$..book[?(@.author != 'B. Sample')].title")).toHaveLength(3);
    expect(values('$.store.book[?(@.title.length > 11)].title')).toEqual(['Sample Atlas', 'Mock Harbour', 'Stub Lantern']);
    expect(values('$.store[?(@.color)]')).toEqual([{ color: 'red', price: 19.95 }]);
  });

  it('gives each match a readable path', () => {
    expect(paths('$.store.book[?(@.price > 20)].title')).toEqual(['$.store.book[3].title']);
    expect(paths('$.store.x-request-id')).toEqual(["$.store['x-request-id']"]);
  });

  it('returns a message for invalid expressions instead of throwing', () => {
    for (const bad of ['$.', '$[', '$[1', "$['open", '$.store.book[?(@.price = 10)]', '$.store.book[?(@.price <)]', '$[::0]', '$.store book', '$..', '$[?(@..a)]', '$[a]']) {
      const r = queryJsonPath(store, bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length, bad).toBeGreaterThan(0);
      expect(checkJsonPath(bad), bad).not.toBeNull();
    }
    expect(checkJsonPath('$.store.book[?(@.price < 10)]')).toBeNull();
  });

  it('handles values that are not objects', () => {
    expect(values('$.a', 'text')).toEqual([]);
    expect(values('$[0]', null)).toEqual([]);
    expect(values('$[*]', [1, null, 'x'])).toEqual([1, null, 'x']);
  });

  it('copes with large arrays and caps the number of matches', () => {
    const big = { items: Array.from({ length: 200_000 }, (_, i) => ({ id: i, even: i % 2 === 0 })) };
    const started = Date.now();
    expect(values('$.items[?(@.id == 199999)].id', big)).toEqual([199999]);
    expect(values('$.items[-1].id', big)).toEqual([199999]);
    const all = queryJsonPath(big, '$..id');
    expect(all.ok && all.matches.length).toBe(JSONPATH_MAX_MATCHES);
    expect(all.ok && all.capped).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('copes with deep nesting', () => {
    let deep: unknown = { leaf: 'bottom' };
    for (let i = 0; i < 20_000; i++) deep = { next: deep };
    expect(values('$..leaf', deep)).toEqual(['bottom']);
  });
});

describe('set as variable helpers', () => {
  it('suggests a variable name from the path', () => {
    expect(suggestVariableName('$.access_token')).toBe('access_token');
    expect(suggestVariableName('$.data.items[0].id')).toBe('id');
    expect(suggestVariableName("$['x-request-id']")).toBe('x_request_id');
    expect(suggestVariableName('$[3]')).toBe('value');
  });

  it('keeps strings as they are and other values as JSON', () => {
    expect(variableText('abc')).toBe('abc');
    expect(variableText(12)).toBe('12');
    expect(variableText({ a: [1] })).toBe('{"a":[1]}');
    expect(variableText(null)).toBe('null');
  });
});
