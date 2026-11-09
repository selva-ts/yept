import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from './git-service';
import type { EnvService } from '@yept/core/services/env-service';
import { Workspace } from '@yept/core/engine/workspace/workspace';
import { IdentityStore } from '@yept/core/engine/identity/identity-store';

let dir: string, repo: string, workspace: Workspace, identity: IdentityStore, service: GitService;
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const emptyEnv = { allSecretValues: () => [] } as unknown as EnvService;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yept-git-service-')); repo = join(dir, 'repo'); mkdirSync(repo);
  sh(repo, 'init', '-b', 'main'); sh(repo, 'config', 'user.email', 'test@example.test'); sh(repo, 'config', 'user.name', 'Test'); sh(repo, 'config', 'commit.gpgsign', 'false');
  sh(repo, 'config', 'core.autocrlf', 'false');
  cpSync(join(__dirname, '../../../../fixtures/collections/sample-travel'), join(repo, 'collection'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'outside collection\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'initial');
  identity = new IdentityStore(join(dir, 'identity.db'));
  workspace = new Workspace(repo, identity, { trash: async () => {} }); await workspace.load();
  service = new GitService(() => workspace, emptyEnv, async (path) => { renameSync(path, join(dir, 'trashed')); }, async () => { await workspace.load(); });
});
afterEach(() => { identity?.close(); rmSync(dir, { recursive: true, force: true }); });

it('rejects repositories and paths outside the open collections, and ignores renderer-supplied rename metadata', async () => {
  writeFileSync(join(repo, 'README.md'), 'keep this\n');
  const request = join(repo, 'collection/Bookings/List bookings.yml'); writeFileSync(request, 'info:\n  name: Changed\n  type: http\nhttp:\n  method: GET\n  url: https://api.example.test\n');
  const { repos: [status] } = await service.status();
  const file = status.files.find((f) => f.path.endsWith('List bookings.yml'))!;
  await expect(service.action(dir, 'fetch')).rejects.toThrow('open workspace');
  await expect(service.files(repo, 'stage', [{ ...file, path: 'README.md' }])).rejects.toThrow('outside the collections');
  await expect(service.files(repo, 'discard', [{ ...file, path: '../escape.yml' }])).rejects.toThrow();
  expect((await service.files(repo, 'stage', [{ ...file, from: 'README.md' }])).ok).toBe(true);
  expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('collection/Bookings/List bookings.yml');
});

it('unstages only staged selections and trashes a new file through the injected OS callback', async () => {
  const path = join(repo, 'collection/New.yml'); writeFileSync(path, 'new\n');
  const existing = join(repo, 'collection/Bookings/List bookings.yml'); writeFileSync(existing, 'changed\n');
  let { repos: [status] } = await service.status();
  await service.files(repo, 'stage', status.files.filter((f) => !f.path.endsWith('New.yml')));
  ({ repos: [status] } = await service.status());
  expect((await service.files(repo, 'unstage', status.files)).ok).toBe(true);
  expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('');
  expect((await service.files(repo, 'discard', status.files.filter((f) => f.path.endsWith('New.yml')))).ok).toBe(true);
  expect(sh(repo, 'status', '--porcelain')).not.toContain('New.yml');
});

it('retains a repository in the picker when a branch removes its collections', async () => {
  sh(repo, 'switch', '-c', 'without-collections'); sh(repo, 'rm', '-r', 'collection'); sh(repo, 'commit', '-m', 'remove collection'); sh(repo, 'switch', 'main');
  await service.status();
  expect((await service.action(repo, 'switch', 'without-collections')).ok).toBe(true);
  expect(workspace.collectionDirs()).toEqual([]);
  expect((await service.status()).repos).toHaveLength(1);
  expect((await service.action(repo, 'switch', 'main')).ok).toBe(true);
  expect(workspace.collectionDirs()).toHaveLength(1);
});

it('serializes mutations for the same repository through workspace reload', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  service = new GitService(() => workspace, emptyEnv, async () => {}, async () => { started(); await gate; });
  const first = service.action(repo, 'pull');
  await entered;
  try { await expect(service.action(repo, 'pull')).rejects.toThrow('Another Git operation'); }
  finally { release(); await first; }
});

it('reports a failed workspace reload alongside a successful Git result, without replacing it', async () => {
  service = new GitService(() => workspace, emptyEnv, async () => {}, async () => { throw new Error('collection unreadable'); });
  const r = await service.action(repo, 'switch', 'main');
  expect(r.ok).toBe(true);
  expect(r.output).toContain('could not reload the collections afterwards (collection unreadable)');
});

it('keeps the identity of a request a teammate renamed and edited, after a pull', async () => {
  const remote = join(dir, 'remote.git'); const teammate = join(dir, 'teammate');
  sh(dir, 'init', '--bare', '-b', 'main', remote); sh(repo, 'remote', 'add', 'origin', remote); sh(repo, 'push', '-u', 'origin', 'main');
  sh(dir, 'clone', remote, teammate); sh(teammate, 'config', 'user.email', 'mate@example.test'); sh(teammate, 'config', 'user.name', 'Mate'); sh(teammate, 'config', 'commit.gpgsign', 'false');
  const id = workspace.requestIdForFile(join(repo, 'collection/Bookings/List bookings.yml'))!;
  const login = workspace.requestIdForFile(join(repo, 'collection/Auth/Login.yml'))!;
  expect(id).toBeTruthy();

  // Renamed, moved and edited: the content fingerprint alone can't follow it.
  mkdirSync(join(teammate, 'collection/Reports'));
  sh(teammate, 'mv', 'collection/Bookings/List bookings.yml', 'collection/Reports/All bookings.yml');
  const moved = join(teammate, 'collection/Reports/All bookings.yml');
  writeFileSync(moved, readFileSync(moved, 'utf8').replace('status=all', 'status=open').replace('name: List bookings', 'name: All bookings'));
  sh(teammate, 'commit', '-qam', 'rename bookings'); sh(teammate, 'push', '-q');

  const r = await service.action(repo, 'pull');
  expect(r.ok).toBe(true);
  expect(r.output).toContain('History kept for 1 renamed request:\n  collection/Bookings/List bookings.yml → collection/Reports/All bookings.yml');
  expect(workspace.requestIdForFile(join(repo, 'collection/Reports/All bookings.yml'))).toBe(id);
  expect(workspace.getRequest(id).doc.url).toContain('status=open');
  expect(workspace.requestIdForFile(join(repo, 'collection/Auth/Login.yml'))).toBe(login);
});

it('leaves an ambiguous rename unmatched after a branch switch', async () => {
  // Two identical requests; the branch deletes both and adds one edited copy, so Git must pick a source.
  const listing = readFileSync(join(repo, 'collection/Bookings/List bookings.yml'), 'utf8');
  writeFileSync(join(repo, 'collection/Bookings/Twin.yml'), listing.replace('name: List bookings', 'name: Twin'));
  writeFileSync(join(repo, 'collection/Bookings/List bookings.yml'), listing.replace('name: List bookings', 'name: Twin'));
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'twins'); await workspace.load();
  const ids = ['List bookings.yml', 'Twin.yml'].map((f) => workspace.requestIdForFile(join(repo, 'collection/Bookings', f))!);
  sh(repo, 'switch', '-qc', 'merged'); sh(repo, 'rm', '-q', 'collection/Bookings/Twin.yml');
  sh(repo, 'mv', 'collection/Bookings/List bookings.yml', 'collection/Bookings/One.yml');
  writeFileSync(join(repo, 'collection/Bookings/One.yml'), listing.replace('name: List bookings', 'name: One'));
  sh(repo, 'commit', '-qam', 'merge twins'); sh(repo, 'switch', '-q', 'main'); await workspace.load();

  const r = await service.action(repo, 'switch', 'merged');
  expect(r.ok).toBe(true);
  expect(r.output).not.toContain('History kept');
  expect(ids).not.toContain(workspace.requestIdForFile(join(repo, 'collection/Bookings/One.yml')));
});
