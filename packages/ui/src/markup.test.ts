import { describe, expect, it } from 'vitest';
import { formatMarkup, markupKind, PREVIEW_CSP, previewDocument, mediaDocument } from './markup';

describe('markupKind', () => {
  it('uses the content type first', () => {
    expect(markupKind('text/html; charset=utf-8', 'hello')).toBe('html');
    expect(markupKind('application/xhtml+xml', '<?xml version="1.0"?><html/>')).toBe('html');
    expect(markupKind('application/xml', '<a/>')).toBe('xml');
    expect(markupKind('application/rss+xml', '<rss/>')).toBe('xml');
    expect(markupKind('application/json', '<!doctype html>')).toBeNull();
  });

  it('recognises HTML and XML bodies sent with another content type', () => {
    expect(markupKind('text/plain', '﻿  <!DOCTYPE html>\n<html><body>x</body></html>')).toBe('html');
    expect(markupKind('', '<!-- generated -->\n<html lang="en">')).toBe('html');
    expect(markupKind('application/octet-stream', '<?xml version="1.0"?><a/>')).toBe('xml');
    expect(markupKind('text/plain', 'not <html> at the start')).toBeNull();
    expect(markupKind('text/plain', '<htmlish>')).toBeNull();
  });
});

describe('formatMarkup', () => {
  it('indents HTML, keeps <pre> and short inline content together', () => {
    const out = formatMarkup('<!doctype html><html><head><title>T</title></head><body><div><p>Hi <b>there</b></p><ul><li>one</li><li>two</li></ul><pre>  a\n   b</pre><br></div></body></html>', 'html');
    expect(out).toBe(
      [
        '<!doctype html>',
        '<html>',
        '<head>',
        '  <title>T</title>',
        '</head>',
        '<body>',
        '  <div>',
        '    <p>Hi <b>there</b></p>',
        '    <ul>',
        '      <li>one</li>',
        '      <li>two</li>',
        '    </ul>',
        '    <pre>  a\n   b</pre><br>',
        '  </div>',
        '</body>',
        '</html>'
      ].join('\n')
    );
  });

  it('formats XML without HTML rules: <link> has content, case is kept, every element on its own line', () => {
    const out = formatMarkup('<?xml version="1.0"?><rss><channel><link>https://api.example.test/</link><Item id="1"><Name>Alex</Name><b>bold?</b></Item></channel></rss>', 'xml');
    expect(out).toBe(
      [
        '<?xml version="1.0"?>',
        '<rss>',
        '  <channel>',
        '    <link>https://api.example.test/</link>',
        '    <Item id="1">',
        '      <Name>Alex</Name>',
        '      <b>bold?</b>',
        '    </Item>',
        '  </channel>',
        '</rss>'
      ].join('\n')
    );
  });

  it('copes with broken markup instead of throwing', () => {
    expect(() => formatMarkup('<div><p>unclosed <span attr="x', 'html')).not.toThrow();
    expect(() => formatMarkup('<a><b></a>', 'xml')).not.toThrow();
  });
});

describe('previewDocument', () => {
  it('blocks scripts and every request', () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).not.toMatch(/script-src|unsafe-eval|https?:|'self'/);
  });

  it('puts the policy first, after a doctype so the page keeps standards mode', () => {
    const doc = previewDocument('<!DOCTYPE html><html><head><script>alert(1)</script></head></html>');
    expect(doc.startsWith(`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><html>`)).toBe(true);
    expect(previewDocument('<p>x</p>').startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });
});

it('builds the image and PDF preview from data: images only, under the preview policy', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const doc = mediaDocument([
    { src: png, alt: 'Page "1" <b>' },
    { src: 'http://127.0.0.1:4010/media/image.png', alt: 'remote' },
    { src: 'data:text/html;base64,PHNjcmlwdD4=', alt: 'html' },
    { src: 'data:image/png;base64,abc" onerror="x', alt: 'broken out' }
  ]);
  expect(doc.indexOf(`content="${PREVIEW_CSP}"`)).toBeGreaterThan(0);
  expect(doc).toContain(`<img src="${png}" alt="Page &quot;1&quot; &lt;b&gt;">`);
  expect(doc.match(/<img /g)).toHaveLength(1);
  expect(doc).not.toMatch(/127\.0\.0\.1|text\/html|onerror|<script/);
});
