import { expect, it } from 'vitest';
import { externalUrl, openExternalUrl } from './external-links';

it('allows http and https web pages, normalised as parsed', () => {
  expect(externalUrl('https://api.example.test/docs?q=1#top')).toBe('https://api.example.test/docs?q=1#top');
  expect(externalUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/');
  expect(externalUrl('HTTPS://API.Example.TEST')).toBe('https://api.example.test/');
  expect(externalUrl('  https://api.example.test/a b')).toBe('https://api.example.test/a%20b');
  // Backslashes in a web URL are path separators, not a UNC path.
  expect(externalUrl('https:\\\\api.example.test\\share')).toBe('https://api.example.test/share');
});

it('refuses every other scheme, local paths and anything unparseable', () => {
  for (const url of [
    'file:///C:/Windows/System32/calc.exe',
    'file://server/share/run.bat',
    '\\\\server\\share\\run.bat',
    'C:\\Windows\\System32\\calc.exe',
    '/etc/passwd',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'mailto:someone@example.test',
    'ms-settings:privacy',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x',
    'ftp://files.example.test/',
    'smb://server/share',
    'about:blank',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'yept://open',
    'http:',
    'https://',
    'api.example.test/docs',
    '',
    'not a url'
  ]) expect(externalUrl(url), url).toBeNull();
  expect(externalUrl(undefined as unknown as string)).toBeNull();
});

it('opens only allowed URLs and swallows a failure to open', async () => {
  const opened: string[] = [];
  const open = (url: string) => (opened.push(url), url.includes('fail') ? Promise.reject(new Error('no browser')) : Promise.resolve());
  expect(openExternalUrl('file:///C:/Windows/win.ini', open)).toBe(false);
  expect(openExternalUrl('javascript:alert(1)', open)).toBe(false);
  expect(openExternalUrl('https://api.example.test/docs', open)).toBe(true);
  expect(openExternalUrl('https://api.example.test/fail', open)).toBe(true);
  await Promise.resolve();
  expect(opened).toEqual(['https://api.example.test/docs', 'https://api.example.test/fail']);
});
