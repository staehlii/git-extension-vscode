// Conflict resolution helpers (no vscode imports, integration-tested against real repos).
import { promises as fs } from 'fs';
import * as path from 'path';
import { Repo } from '../git/repo';

const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
const nul = (paths: string[]) => paths.map((p) => p + '\0').join('');

export type Side = 'ours' | 'theirs';

/** Stages present for each unmerged path (1 = base, 2 = ours, 3 = theirs). */
export async function unmergedStages(repo: Repo, paths?: string[]): Promise<Map<string, Set<number>>> {
  const out = await repo.out(['ls-files', '-u', '-z', '--', ...(paths ?? [])], { env: LITERAL });
  const result = new Map<string, Set<number>>();
  for (const entry of out.split('\0')) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = entry.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const stage = Number(entry.slice(0, tab).split(' ')[2]);
    const file = entry.slice(tab + 1);
    (result.get(file) ?? result.set(file, new Set()).get(file)!).add(stage);
  }
  return result;
}

/**
 * JetBrains "Accept Yours" / "Accept Theirs": takes one side's version of each file and marks it
 * resolved. If that side deleted the file, the file is removed.
 */
export async function acceptSide(repo: Repo, paths: string[], side: Side): Promise<void> {
  const stages = await unmergedStages(repo, paths);
  const stage = side === 'ours' ? 2 : 3;
  const keep = paths.filter((p) => stages.get(p)?.has(stage));
  const remove = paths.filter((p) => stages.has(p) && !stages.get(p)!.has(stage));
  if (keep.length) {
    await repo.exec(['checkout', `--${side}`, '--pathspec-from-file=-', '--pathspec-file-nul'], { env: LITERAL, input: nul(keep) });
    await repo.exec(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: LITERAL, input: nul(keep) });
  }
  if (remove.length) {
    await repo.exec(['rm', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: LITERAL, input: nul(remove) });
  }
}

/** Stages the files as they are now (after manual resolution). Deleted files are removed from the index. */
export async function markResolved(repo: Repo, paths: string[]): Promise<void> {
  await repo.exec(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: LITERAL, input: nul(paths) });
}

const MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/** True if the file on disk still contains git conflict markers. */
export async function hasConflictMarkers(file: string): Promise<boolean> {
  try {
    return MARKER.test(await fs.readFile(file, 'utf8'));
  } catch {
    return false; // deleted file
  }
}

async function describe(repo: Repo, rev: string): Promise<string> {
  const res = await repo.exec(['log', '-1', '--format=%h %s', rev, '--'], { allowFailure: true });
  return res.exitCode === 0 ? res.stdout.trim() : rev;
}

async function readGitFile(repo: Repo, name: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(path.join(await repo.gitDir(), name), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** Human labels for both sides of the current conflict, e.g. for the Conflicts dialog. */
export async function sideLabels(repo: Repo): Promise<{ ours: string; theirs: string }> {
  const state = await repo.operationState();
  const branch = (await repo.currentBranch()) ?? 'HEAD';
  switch (state) {
    case 'merging': {
      const msg = (await readGitFile(repo, 'MERGE_MSG'))?.split('\n')[0];
      return { ours: branch, theirs: msg?.replace(/^Merge /, '') ?? 'MERGE_HEAD' };
    }
    case 'rebasing': {
      // During a rebase "ours" is the branch being rebased onto and "theirs" the commit being replayed.
      const onto = (await readGitFile(repo, 'rebase-merge/onto')) ?? (await readGitFile(repo, 'rebase-apply/onto'));
      const headName = (await readGitFile(repo, 'rebase-merge/head-name'))?.replace(/^refs\/heads\//, '');
      return {
        ours: onto ? `upstream ${await describe(repo, onto)}` : 'upstream',
        theirs: `${headName ?? 'your commit'}: ${await describe(repo, 'REBASE_HEAD')}`,
      };
    }
    case 'cherry-picking':
      return { ours: branch, theirs: `cherry-pick ${await describe(repo, 'CHERRY_PICK_HEAD')}` };
    case 'reverting':
      return { ours: branch, theirs: `revert of ${await describe(repo, 'REVERT_HEAD')}` };
    default:
      return { ours: branch, theirs: 'theirs' };
  }
}
