// The pre-commit hook's checker, bundled to one file that the hook runs with Node. It scans the staged version of every
// file in a collection folder with the engine's leak scanner and exits 1, with the findings, when it finds something.
// Git runs hooks at the top of the working tree, with GIT_INDEX_FILE set for partial commits; runGit keeps that.
import { runGit } from '@yept/core/engine/git/git';
import { scanForLeaks } from '@yept/core/engine/guard/leak-scan';
import { collectionFolders, hookReport, inCollections } from './leak-check';

async function git(args: string[]): Promise<string> {
  const r = await runGit(args, process.cwd());
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const list = (out: string): string[] => out.split('\0').filter(Boolean);

async function main(): Promise<number> {
  const staged = list(await git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--no-renames']));
  if (!staged.length) return 0;
  const folders = collectionFolders(list(await git(['ls-files', '-z', '--cached'])));
  const files: { path: string; text: string }[] = [];
  for (const path of inCollections(staged, folders)) {
    const text = await git(['cat-file', 'blob', `:${path}`]);
    if (!text.includes('\0')) files.push({ path, text });
  }
  const findings = scanForLeaks(files);
  if (!findings.length) return 0;
  process.stderr.write(hookReport(findings));
  return 1;
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`Yept leak check could not run: ${error instanceof Error ? error.message : String(error)}\nTo commit without the check: git commit --no-verify\n`);
  process.exitCode = 1;
});
