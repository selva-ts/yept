import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { minimalEnvironment, releaseTag, selfTestCount, variantSummary, verifyRelease } from './ci.mjs';

const sha = 'a'.repeat(40);
const approved = { event: 'workflow_dispatch', approved: 'true', ref: 'refs/tags/v1.2.3', version: '1.2.3', sha };

it('requires a manual approval for the exact stable package version tag', () => {
  expect(releaseTag(approved)).toBe('v1.2.3');
});

it.each([
  { event: 'push' }, { event: 'pull_request' }, { approved: 'false' }, { approved: '' }, { approved: true },
  { ref: 'refs/heads/main' }, { ref: 'refs/tags/v1.2.4' }, { ref: 'refs/tags/v1.2.3\n' },
  { version: '01.2.3', ref: 'refs/tags/v01.2.3' }, { version: '1.2.3-beta', ref: 'refs/tags/v1.2.3-beta' },
  { version: '1.2.3\n', ref: 'refs/tags/v1.2.3\n' }, { sha: '' }, { sha: 'main' }, { sha: sha + '\n' }
])('rejects an unapproved or mismatched release context %j', (change) => {
  expect(() => releaseTag({ ...approved, ...change })).toThrow();
});

it('counts successful packaged results and fails on empty, failed or non-zero output', () => {
  expect(selfTestCount('PASS synthetic SQLite\r\nPASS synthetic sandbox\r\n', 0)).toBe(2);
  expect(() => selfTestCount('', 0)).toThrow();
  expect(() => selfTestCount('PASS synthetic SQLite\nFAIL synthetic sandbox\n', 0)).toThrow();
  expect(() => selfTestCount('PASS synthetic SQLite\n', 1)).toThrow();
  expect(() => selfTestCount('Uncaught error\n', 0)).toThrow();
});

it('keeps only the minimal Windows environment and replaces the isolated profile', () => {
  const names = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
  const kept = Object.fromEntries(names.map(name => [name, `synthetic-${name}`]));
  const env = { ...kept, NODE_OPTIONS: 'synthetic-option', ELECTRON_RUN_AS_NODE: '1', PRIVATE_EXAMPLE: 'synthetic-secret', YEPT_USER_DATA: 'old-profile' };
  expect(minimalEnvironment(env, 'new-profile')).toEqual({ ...kept, YEPT_USER_DATA: 'new-profile' });
  expect(env.YEPT_USER_DATA).toBe('old-profile');
  expect(env.NODE_OPTIONS).toBe('synthetic-option');
});

it('uses Path when PATH is absent and prefers PATH when both exist', () => {
  expect(minimalEnvironment({ Path: 'synthetic-path' }, 'profile')).toEqual({ PATH: 'synthetic-path', YEPT_USER_DATA: 'profile' });
  expect(minimalEnvironment({ PATH: '', Path: 'other-path' }, 'profile')).toEqual({ PATH: '', YEPT_USER_DATA: 'profile' });
});

it('omits absent environment variables', () => {
  expect(minimalEnvironment({}, 'profile')).toEqual({ YEPT_USER_DATA: 'profile' });
});

it('summarizes the exit and recorded results without progress timestamps', () => {
  const progress = '2026-01-01T00:00:00.000Z main process loaded\r\n2026-01-01T00:00:01.000Z results written\r\n';
  expect(variantSummary('minimal-env', { code: 0, signal: null, ms: 2400 }, progress, 'PASS synthetic SQLite\r\nPASS synthetic sandbox\r\n'))
    .toBe('minimal-env: exit 0 after 2400 ms; 2 progress lines, last "results written"; 2 PASS');
});

it('summarizes a timeout kill and missing results', () => {
  expect(variantSummary('visible', { code: null, signal: 'SIGKILL', ms: 60000 }, 'main process loaded\n', ''))
    .toBe('visible: signal SIGKILL after 60000 ms; 1 progress lines, last "main process loaded"; no results');
});

it('summarizes launch errors on one line even when no files were written', () => {
  expect(variantSummary('playwright', { error: 'synthetic launch\nfailed', ms: 310 }, '', ''))
    .toBe('playwright: launch error "synthetic launch\\nfailed" after 310 ms; no progress; no results');
});

it('reports missing progress and counts only PASS result lines', () => {
  expect(variantSummary('no-stdin', { code: 1, ms: 100 }, '\r\n', 'FAIL synthetic sandbox\nPASS synthetic SQLite\n'))
    .toBe('no-stdin: exit 1 after 100 ms; no progress; 1 PASS');
  expect(variantSummary('visible', { code: 1, ms: 100 }, '', 'FAIL synthetic sandbox\n'))
    .toBe('visible: exit 1 after 100 ms; no progress; 0 PASS');
});

it('keeps result evidence when Playwright launch rejects', () => {
  expect(variantSummary('playwright', { error: 'synthetic disconnect', ms: 500 }, 'results written\n', 'PASS synthetic SQLite\n'))
    .toBe('playwright: launch error "synthetic disconnect" after 500 ms; 1 progress lines, last "results written"; 1 PASS');
});

let root, tempRoot;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(async () => {
  tempRoot = await realpath(tmpdir());
  root = await mkdtemp(resolve(tempRoot, 'yept-ci-test-'));
});
afterEach(async () => {
  const path = relative(tempRoot, await realpath(root));
  expect(path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)).toBeTruthy();
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});

async function repository() {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fictional Example');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  git('add', 'package.json');
  git('commit', '-m', 'Synthetic fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
}
const context = () => ({ GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_APPROVED: 'true', GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_SHA: git('rev-parse', 'HEAD') });

it.each([false, true])('accepts a main commit with a lightweight or annotated tag (annotated=%s)', async (annotated) => {
  await repository();
  git('tag', ...(annotated ? ['-a', 'v1.2.3', '-m', 'Synthetic version'] : ['v1.2.3']));
  expect(await verifyRelease(root, context())).toBe('v1.2.3');
});

it('rejects a tag on an unmerged branch', async () => {
  await repository();
  git('switch', '-c', 'synthetic-feature');
  git('commit', '--allow-empty', '-m', 'Synthetic unmerged change');
  git('tag', 'v1.2.3');
  await expect(verifyRelease(root, context())).rejects.toThrow('already be on origin/main');
});

it('rejects a checkout that does not match its selected tag', async () => {
  await repository();
  git('tag', 'v1.2.3');
  git('commit', '--allow-empty', '-m', 'Synthetic later change');
  await expect(verifyRelease(root, context())).rejects.toThrow('does not match');
});

it('rejects a checkout that differs from the workflow commit even when the tag is correct', async () => {
  await repository();
  git('tag', 'v1.2.3');
  const env = context();
  git('commit', '--allow-empty', '-m', 'Synthetic later checkout');
  await expect(verifyRelease(root, env)).rejects.toThrow('does not match the workflow commit');
});
