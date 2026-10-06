// Commit / rollback of selected files (no vscode imports, integration-tested against real repos).
import { promises as fs } from 'fs';
import * as path from 'path';
import { Repo } from '../git/repo';
import { FileChange, pathsOf } from './statusParser';

const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

function nulList(paths: string[]): string {
  return paths.map((p) => p + '\0').join('');
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export interface CommitRequest {
  /** Files to commit (untracked ones are added first). Ignored for a merge commit. */
  changes: FileChange[];
  message: string;
  amend: boolean;
  /**
   * During a merge git cannot commit a subset of files, so the caller passes every change and
   * sets this; the commit then uses the whole index instead of `--only`.
   */
  commitAll: boolean;
}

/**
 * Commits exactly the given files as they are in the working tree, leaving everything else that is
 * staged untouched (`git commit --only`, JetBrains behaviour). Returns the new HEAD sha.
 */
export async function commitFiles(repo: Repo, req: CommitRequest): Promise<string> {
  const gitDir = await repo.gitDir();
  const msgFile = path.join(gitDir, 'JBGIT_COMMIT_MSG');
  await fs.writeFile(msgFile, req.message, 'utf8');
  try {
    const untracked = req.changes.filter((c) => c.kind === 'untracked').map((c) => c.path);
    if (untracked.length) {
      await repo.exec(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: LITERAL, input: nulList(untracked) });
    }
    const args = ['commit', '-F', msgFile];
    if (req.amend) {
      args.push('--amend');
    }
    const paths = unique(req.changes.flatMap(pathsOf));
    if (req.commitAll) {
      if (paths.length) {
        await repo.exec(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: LITERAL, input: nulList(paths) });
      }
      await repo.exec(args, { env: LITERAL });
    } else if (paths.length) {
      await repo.exec([...args, '--only', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        env: LITERAL,
        input: nulList(paths),
      });
    } else if (req.amend) {
      await repo.exec([...args, '--only'], { env: LITERAL }); // reword the last commit only
    } else {
      throw new Error('No files selected for commit.');
    }
    return (await repo.out(['rev-parse', 'HEAD'])).trim();
  } finally {
    await fs.rm(msgFile, { force: true });
  }
}

/**
 * JetBrains "Rollback": restores modified/deleted files from HEAD, undoes renames, and un-adds added
 * files (they stay on disk as unversioned files). Untracked and conflicted files are ignored.
 */
export async function rollbackFiles(repo: Repo, changes: FileChange[]): Promise<void> {
  const restore: string[] = [];
  const unadd: string[] = [];
  const removeRenamed: string[] = [];
  for (const c of changes) {
    switch (c.kind) {
      case 'modified':
      case 'deleted':
        restore.push(c.path);
        break;
      case 'renamed':
        restore.push(c.origPath!);
        removeRenamed.push(c.path);
        break;
      case 'added':
        unadd.push(c.path);
        break;
      default:
        break;
    }
  }
  if (removeRenamed.length) {
    await repo.exec(['rm', '-q', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env: LITERAL,
      input: nulList(removeRenamed),
    });
  }
  if (restore.length) {
    await repo.exec(['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env: LITERAL,
      input: nulList(restore),
    });
  }
  if (unadd.length) {
    await repo.exec(['rm', '-q', '--cached', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env: LITERAL,
      input: nulList(unadd),
    });
  }
}

/** Last commit message, used to prefill Amend. */
export async function headMessage(repo: Repo): Promise<string> {
  const res = await repo.exec(['log', '-1', '--format=%B'], { allowFailure: true });
  return res.exitCode === 0 ? res.stdout.trimEnd() : '';
}

/** Remote branches that already contain HEAD (amending those needs a force push). */
export async function remoteBranchesContainingHead(repo: Repo): Promise<string[]> {
  const res = await repo.exec(['branch', '-r', '--contains', 'HEAD', '--format=%(refname:short)'], { allowFailure: true });
  return res.exitCode === 0 ? res.stdout.split('\n').filter(Boolean) : [];
}
