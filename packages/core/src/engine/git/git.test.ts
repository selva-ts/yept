import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_TIMED_OUT, Git, canonical, explainGitError, gitTimeoutMs } from './git';
import { scanForLeaks } from '../guard/leak-scan';

let dir: string;
let remote: string;
let repo: string;
const git = new Git();
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const write = (rel: string, text: string): void => {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const configure = (cwd: string): void => {
  sh(cwd, 'config', 'user.email', 'test@example.test');
  sh(cwd, 'config', 'user.name', 'Yept Test');
  sh(cwd, 'config', 'commit.gpgsign', 'false');
  sh(cwd, 'config', 'core.autocrlf', 'false');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yept-git-'));
  remote = join(dir, 'remote.git');
  repo = join(dir, 'repo');
  sh(dir, 'init', '--bare', '-b', 'main', remote);
  sh(dir, 'clone', remote, repo);
  configure(repo);
  write('api/col/opencollection.yml', 'opencollection: 1.0.0\n');
  write('api/col/A.yml', 'a: 1\n');
  write('api/col/B.yml', 'b: 1\n');
  write('README.md', 'readme\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'push', '-u', 'origin', 'main');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Git', () => {
  it('finds the repo, branch, upstream and ahead/behind', async () => {
    const root = await git.repoRoot(join(repo, 'api', 'col'));
    expect(root?.toLowerCase()).toBe(canonical(repo).toLowerCase());
    const info = await git.info(repo);
    expect(info).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 });
  });

  it('lists only changes under the collection folders', async () => {
    write('api/col/A.yml', 'a: 2\n');
    write('api/col/C.yml', 'c: 1\n');
    write('README.md', 'changed\n');
    const files = await git.status(repo, [join(repo, 'api', 'col')]);
    expect(files.map((f) => `${f.kind}:${f.path}`)).toEqual(['modified:api/col/A.yml', 'untracked:api/col/C.yml']);
  });

  it('commits only the selected files and leaves other staged changes staged', async () => {
    write('api/col/A.yml', 'a: 2\n');
    write('api/col/B.yml', 'b: 2\n');
    write('README.md', 'staged elsewhere\n');
    sh(repo, 'add', 'README.md', 'api/col/B.yml'); // the user staged these with another tool
    write('api/col/C.yml', 'c: 1\n');
    const files = (await git.status(repo, [join(repo, 'api', 'col')])).filter((f) => f.path.endsWith('A.yml') || f.path.endsWith('C.yml'));
    const r = await git.commit(repo, files, 'Update A, add C');
    expect(r.result.ok).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(sh(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['api/col/A.yml', 'api/col/C.yml']);
    expect(sh(repo, 'diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(['README.md', 'api/col/B.yml']); // still staged
  });

  it('commits a deleted file', async () => {
    rmSync(join(repo, 'api', 'col', 'B.yml'));
    const files = await git.status(repo, [join(repo, 'api', 'col')]);
    expect(files[0].kind).toBe('deleted');
    expect((await git.commit(repo, files, 'Remove B')).result.ok).toBe(true);
    expect(sh(repo, 'show', '--name-status', '--format=', 'HEAD').trim()).toBe('D\tapi/col/B.yml');
  });

  it('shows before and after texts for a diff', async () => {
    write('api/col/A.yml', 'a: 2\n');
    const [f] = await git.status(repo, [join(repo, 'api', 'col')]);
    expect(await git.diffTexts(repo, f)).toEqual({ before: 'a: 1\n', after: 'a: 2\n' });
  });

  it('reports a hook that rejects the commit', async () => {
    write('.git/hooks/pre-commit', '#!/bin/sh\necho "no commits today" >&2\nexit 1\n');
    try {
      execFileSync('chmod', ['+x', join(repo, '.git', 'hooks', 'pre-commit')]);
    } catch {
      /* Windows Git runs hooks without the executable bit */
    }
    write('api/col/A.yml', 'a: 3\n');
    const r = await git.commit(repo, await git.status(repo, [join(repo, 'api', 'col')]), 'x');
    expect(r.result.ok).toBe(false);
    expect(r.result.stderr).toContain('no commits today');
    expect(r.explanation).toContain('A Git hook (pre-commit) rejected the commit');
  });

  it('pushes to the upstream, and reports a rejected push accurately (never forces)', async () => {
    write('api/col/A.yml', 'a: 2\n');
    await git.commit(repo, await git.status(repo, [join(repo, 'api', 'col')]), 'mine');
    const ok = await git.push(repo);
    expect(ok.result.ok).toBe(true);
    expect(sh(remote, 'log', '--format=%s', '-1', 'main').trim()).toBe('mine');

    // Someone else pushes first.
    const other = join(dir, 'other');
    sh(dir, 'clone', remote, other);
    configure(other);
    writeFileSync(join(other, 'README.md'), 'theirs\n');
    sh(other, 'commit', '-am', 'theirs');
    sh(other, 'push');
    write('api/col/B.yml', 'b: 9\n');
    await git.commit(repo, await git.status(repo, [join(repo, 'api', 'col')]), 'mine again');
    const rejected = await git.push(repo);
    expect(rejected.result.ok).toBe(false);
    expect(rejected.result.stderr).toMatch(/rejected/);
    expect(rejected.explanation).toMatch(/Use Pull or Sync/);
    expect(sh(remote, 'log', '--format=%s', '-1', 'main').trim()).toBe('theirs'); // remote untouched
  });

  it('asks before setting an upstream for a new branch', async () => {
    sh(repo, 'switch', '-c', 'feature/x');
    write('api/col/A.yml', 'a: 5\n');
    await git.commit(repo, await git.status(repo, [join(repo, 'api', 'col')]), 'feature');
    const first = await git.push(repo);
    expect(first.needsUpstream).toBe(true);
    const second = await git.push(repo, true);
    expect(second.result.ok).toBe(true);
    expect((await git.info(repo)).upstream).toBe('origin/feature/x');
  });

  it('fetches counts, pulls fast-forward and syncs local commits to the upstream', async () => {
    const other = join(dir, 'other');
    sh(dir, 'clone', remote, other);
    configure(other);
    writeFileSync(join(other, 'api/col/A.yml'), 'a: remote\n');
    sh(other, 'commit', '-am', 'remote update'); sh(other, 'push');
    expect((await git.fetch(repo)).result.ok).toBe(true);
    expect((await git.info(repo)).behind).toBe(1);
    expect(readFileSync(join(repo, 'api/col/A.yml'), 'utf8')).toBe('a: 1\n');
    expect((await git.pull(repo)).result.ok).toBe(true);
    expect(readFileSync(join(repo, 'api/col/A.yml'), 'utf8')).toBe('a: remote\n');
    write('api/col/B.yml', 'b: local\n'); sh(repo, 'commit', '-am', 'local update');
    const sync = await git.sync(repo);
    expect(sync.result.ok).toBe(true);
    expect(sync.result.stdout).toContain('Pull (fast-forward only)');
    expect(sh(remote, 'log', '-1', '--format=%s', 'main').trim()).toBe('local update');
    expect(await git.info(repo)).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('stops Sync on divergence without merging, rebasing, stashing or pushing', async () => {
    const other = join(dir, 'other'); sh(dir, 'clone', remote, other); configure(other);
    writeFileSync(join(other, 'README.md'), 'remote\n'); sh(other, 'commit', '-am', 'remote'); sh(other, 'push');
    write('api/col/A.yml', 'local\n'); sh(repo, 'commit', '-am', 'local');
    sh(repo, 'config', 'pull.rebase', 'true'); sh(repo, 'config', 'pull.autostash', 'true');
    const before = sh(repo, 'rev-parse', 'HEAD');
    const r = await git.sync(repo);
    expect(r.result.ok).toBe(false); expect(r.explanation).toContain('diverged');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(sh(remote, 'log', '-1', '--format=%s', 'main').trim()).toBe('remote');
    expect(sh(repo, 'stash', 'list')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('does not overwrite dirty files during a pull or auto-stash them', async () => {
    const other = join(dir, 'other'); sh(dir, 'clone', remote, other); configure(other);
    writeFileSync(join(other, 'api/col/A.yml'), 'remote\n'); sh(other, 'commit', '-am', 'remote'); sh(other, 'push');
    write('api/col/A.yml', 'unsaved on disk\n'); sh(repo, 'config', 'pull.autostash', 'true');
    const r = await git.pull(repo);
    expect(r.result.ok).toBe(false); expect(r.explanation).toContain('Local changes');
    expect(readFileSync(join(repo, 'api/col/A.yml'), 'utf8')).toBe('unsaved on disk\n');
    expect(sh(repo, 'stash', 'list')).toBe('');
  });

  it('uses the configured remote and upstream branch, including when it is not origin', async () => {
    sh(repo, 'remote', 'rename', 'origin', 'team');
    sh(repo, 'branch', '-m', 'work');
    expect((await git.sync(repo)).result.ok).toBe(true);
    expect(await git.info(repo)).toMatchObject({ branch: 'work', upstream: 'team/main' });
    sh(repo, 'branch', '--unset-upstream');
    expect((await git.pull(repo)).explanation).toContain('no upstream');
    expect((await git.sync(repo)).result.ok).toBe(false);
  });

  it('switches only existing local branches on a wholly clean repository', async () => {
    sh(repo, 'branch', 'feature/local');
    expect((await git.info(repo)).branches).toContain('feature/local');
    write('README.md', 'outside collection\n');
    expect((await git.switchBranch(repo, 'feature/local')).result.ok).toBe(false);
    sh(repo, 'restore', 'README.md');
    write('loose.txt', 'untracked\n');
    expect((await git.switchBranch(repo, 'feature/local')).result.ok).toBe(false);
    rmSync(join(repo, 'loose.txt'));
    expect((await git.switchBranch(repo, 'missing')).result.ok).toBe(false);
    expect((await git.switchBranch(repo, 'feature/local')).result.ok).toBe(true);
    expect((await git.info(repo)).branch).toBe('feature/local');
    sh(repo, 'switch', '--detach');
    expect((await git.pull(repo)).explanation).toContain('detached');
    expect((await git.switchBranch(repo, 'main')).result.ok).toBe(true);
  });

  it('creates a branch only on a clean repository, with a valid new name', async () => {
    write('README.md', 'outside collection\n');
    expect((await git.createBranch(repo, 'feature/new')).result.ok).toBe(false);
    sh(repo, 'restore', 'README.md');
    expect((await git.createBranch(repo, 'bad name')).result.ok).toBe(false);
    expect((await git.createBranch(repo, '-x')).result.ok).toBe(false);
    expect((await git.createBranch(repo, 'main')).explanation).toContain('already exists');
    expect((await git.createBranch(repo, 'feature/new')).result.ok).toBe(true);
    expect((await git.info(repo)).branch).toBe('feature/new');
  });

  it('stages and unstages only selected files, preserving working-tree edits and unrelated index entries', async () => {
    write('api/col/A.yml', 'a: 2\n'); write('api/col/B.yml', 'b: 2\n'); write('README.md', 'outside\n'); sh(repo, 'add', 'README.md');
    const files = (await git.status(repo, [join(repo, 'api/col')])).filter((f) => f.path.endsWith('A.yml'));
    expect((await git.stage(repo, files)).result.ok).toBe(true);
    expect(sh(repo, 'diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(['README.md', 'api/col/A.yml']);
    expect((await git.unstage(repo, files)).result.ok).toBe(true);
    expect(sh(repo, 'diff', '--cached', '--name-only').trim()).toBe('README.md');
    expect(readFileSync(join(repo, 'api/col/A.yml'), 'utf8')).toBe('a: 2\n');
  });

  it('does not overwrite ignored local files when switching to a branch that tracks the same path', async () => {
    write('.gitignore', 'local.txt\n'); sh(repo, 'add', '.gitignore'); sh(repo, 'commit', '-m', 'ignore local files');
    sh(repo, 'switch', '-c', 'tracks-local'); write('local.txt', 'branch content\n'); sh(repo, 'add', '-f', 'local.txt'); sh(repo, 'commit', '-m', 'track file');
    sh(repo, 'switch', 'main'); write('local.txt', 'keep local content\n');
    expect((await git.info(repo)).dirty).toBe(false);
    expect((await git.switchBranch(repo, 'tracks-local')).result.ok).toBe(false);
    expect((await git.info(repo)).branch).toBe('main');
    expect(readFileSync(join(repo, 'local.txt'), 'utf8')).toBe('keep local content\n');
  });

  it('discards tracked edits/deletions and trashes new files without touching unselected changes', async () => {
    write('api/col/A.yml', 'a: 2\n'); sh(repo, 'add', 'api/col/A.yml'); write('api/col/A.yml', 'a: 3\n');
    rmSync(join(repo, 'api/col/B.yml'));
    write('api/col/New.yml', 'new\n'); sh(repo, 'add', 'api/col/New.yml');
    write('api/col/Loose.yml', 'loose\n');
    write('README.md', 'keep staged\n'); sh(repo, 'add', 'README.md');
    const trashed: string[] = [];
    const trash = async (p: string): Promise<void> => { trashed.push(p); renameSync(p, join(dir, `trash-${trashed.length}`)); };
    const r = await git.discard(repo, await git.status(repo, [join(repo, 'api/col')]), trash);
    expect(r.result.ok).toBe(true);
    expect(await git.status(repo, [join(repo, 'api/col')])).toEqual([]);
    expect(readFileSync(join(repo, 'api/col/A.yml'), 'utf8')).toBe('a: 1\n');
    expect(readFileSync(join(repo, 'api/col/B.yml'), 'utf8')).toBe('b: 1\n');
    expect(trashed.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['Loose.yml', 'New.yml']);
    expect(sh(repo, 'diff', '--cached', '--name-only').trim()).toBe('README.md');
  });

  it('discards a staged rename without losing the original request', async () => {
    sh(repo, 'mv', 'api/col/A.yml', 'api/col/Renamed.yml');
    const files = await git.status(repo, [join(repo, 'api/col')]);
    expect(files[0].kind).toBe('renamed');
    const r = await git.discard(repo, files, async (p) => { renameSync(p, join(dir, 'trashed-rename')); });
    expect(r.result.ok).toBe(true);
    expect(await git.status(repo, [join(repo, 'api/col')])).toEqual([]);
    expect(readFileSync(join(repo, 'api/col/A.yml'), 'utf8')).toBe('a: 1\n');
  });

  it('gives remote commands time for a sign-in window, and explains a stopped command', () => {
    expect(gitTimeoutMs(['fetch', '--', 'origin'])).toBe(15 * 60_000);
    expect(gitTimeoutMs(['pull', '--ff-only', '--', 'origin', 'refs/heads/main'])).toBe(15 * 60_000);
    expect(gitTimeoutMs(['push', '-u', 'origin', 'main'])).toBe(15 * 60_000);
    expect(gitTimeoutMs(['--literal-pathspecs', 'status', '--porcelain=v2'])).toBe(2 * 60_000);
    expect(explainGitError({ ok: false, code: GIT_TIMED_OUT, stdout: '', stderr: 'Stopped after 15 minutes.' }, 'pull')).toMatch(/^Git pull took too long.*sign-in window/);
  });

  it('stages later edits to a staged rename', async () => {
    sh(repo, 'mv', 'api/col/A.yml', 'api/col/Renamed.yml');
    write('api/col/Renamed.yml', 'a: 2\n');
    const files = await git.status(repo, [join(repo, 'api/col')]);
    expect(files[0]).toMatchObject({ kind: 'renamed', from: 'api/col/A.yml', code: 'RM' });
    const r = await git.stage(repo, files);
    expect(r.result.stderr).toBe('');
    expect(r.result.ok).toBe(true);
    expect(sh(repo, 'show', ':api/col/Renamed.yml')).toBe('a: 2\n');
    expect(sh(repo, 'diff', '--name-only').trim()).toBe('');
  });

  it('treats pathspec characters in selected names literally', async () => {
    write('api/col/[abc].yml', 'literal\n'); write('api/col/a.yml', 'other\n');
    const files = (await git.status(repo, [join(repo, 'api/col')])).filter((f) => f.path.endsWith('[abc].yml'));
    expect((await git.stage(repo, files)).result.ok).toBe(true);
    expect(sh(repo, 'diff', '--cached', '--name-only').trim()).toBe('api/col/[abc].yml');
    await expect(git.stage(repo, [{ ...files[0], path: '../escape.yml' }])).rejects.toThrow('Invalid');
  });

  it('detects conflicts and refuses changes while a merge is in progress', async () => {
    sh(repo, 'switch', '-c', 'conflict'); write('api/col/A.yml', 'other\n'); sh(repo, 'commit', '-am', 'other');
    sh(repo, 'switch', 'main'); write('api/col/A.yml', 'main\n'); sh(repo, 'commit', '-am', 'main');
    try { sh(repo, 'merge', 'conflict'); } catch { /* manufacture an external conflict */ }
    expect((await git.info(repo)).blockedReason).toContain('in progress');
    const files = await git.status(repo, [join(repo, 'api/col')]); expect(files[0].kind).toBe('conflicted');
    expect((await git.sync(repo)).result.ok).toBe(false);
    expect((await git.switchBranch(repo, 'conflict')).result.ok).toBe(false);
    expect((await git.commit(repo, files, 'must not commit')).result.ok).toBe(false);
  });

  it('lists renames between commits under the collection folders, leaving out ties between identical files', async () => {
    const lines = (name: string): string => Array.from({ length: 20 }, (_, i) => `${name}${i}: value ${i}`).join('\n') + '\n';
    write('api/col/Big.yml', lines('big'));
    write('api/col/Dup 1.yml', lines('dup')); write('api/col/Dup 2.yml', lines('dup'));
    write('api/col/Source.yml', lines('source'));
    write('docs/Outside.yml', lines('outside'));
    sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'more');
    const before = (await git.head(repo))!;
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    // A rename with an edit; identical files where Git must pick a source; one source copied to identical targets.
    mkdirSync(join(repo, 'api/col/sub')); sh(repo, 'mv', 'api/col/Big.yml', 'api/col/sub/Bigger.yml'); write('api/col/sub/Bigger.yml', lines('big').replace('big3: value 3', 'big3: changed'));
    sh(repo, 'mv', 'api/col/Dup 1.yml', 'api/col/Dup renamed.yml'); sh(repo, 'rm', '-q', 'api/col/Dup 2.yml');
    sh(repo, 'mv', 'api/col/Source.yml', 'api/col/Target 1.yml'); write('api/col/Target 2.yml', lines('source'));
    sh(repo, 'mv', 'docs/Outside.yml', 'docs/Moved.yml');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-m', 'renames');
    const after = (await git.head(repo))!;

    expect(await git.renames(repo, before, after, [join(repo, 'api', 'col')])).toEqual([{ from: 'api/col/Big.yml', to: 'api/col/sub/Bigger.yml' }]);
    expect(await git.renames(repo, before, after, [])).toEqual([]);
    expect(await git.renames(repo, before, before, [join(repo, 'api', 'col')])).toEqual([]);

    const empty = join(dir, 'empty'); mkdirSync(empty); sh(empty, 'init', '-q');
    expect(await git.head(empty)).toBeNull();
  });
});

describe('scanForLeaks', () => {
  // Assembled at runtime so secret scanners don't flag this synthetic value.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2lnbmF0dXJlLXZhbHVlLXRlc3Q'].join('.');

  it('flags JWTs, literal bearer tokens, credential fields, secret env values and local secrets', () => {
    const findings = scanForLeaks(
      [
        {
          path: 'api/col/Get.yml',
          text: [
            'http:',
            '  auth:',
            '    type: bearer',
            `    token: ${jwt}`,
            '  headers:',
            '    - name: Authorization',
            '      value: Bearer abcdef0123456789xyz',
            '    - name: X-Ok',
            '      value: "{{accessToken}}"',
            '  basic:',
            '    password: hunter2',
            '    username: "{{clientId}}"'
          ].join('\n')
        },
        { path: 'api/col/environments/dev.yml', text: 'variables:\n  - name: baseUrl\n    value: http://x\n  - secret: true\n    name: clientSecret\n    value: oops-real-value\n' },
        { path: 'api/col/Body.yml', text: 'data: |-\n  {"key": "local-secret-123456"}\n' }
      ],
      ['local-secret-123456']
    );
    const kinds = findings.map((f) => `${f.path.split('/').pop()}:${f.line}:${f.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(['Get.yml:4:jwt', 'Get.yml:7:bearer', 'Get.yml:11:credential-field', 'dev.yml:6:secret-with-value', 'Body.yml:2:local-secret']));
    expect(kinds.some((k) => k.includes(':9:') || k.includes(':12:'))).toBe(false); // {{variables}} are fine
    expect(findings.every((f) => !f.excerpt.includes('hunter2') && !f.excerpt.includes('oops-real-value'))).toBe(true);
  });

  it('passes clean collection files', () => {
    const clean = readFileSync(join(__dirname, '../../../../../fixtures/collections/sample-travel/Auth/Login.yml'), 'utf8');
    const env = readFileSync(join(__dirname, '../../../../../fixtures/collections/sample-travel/environments/local.yml'), 'utf8');
    expect(scanForLeaks([{ path: 'Login.yml', text: clean }, { path: 'local.yml', text: env }])).toEqual([]);
  });
});
