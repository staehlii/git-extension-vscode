// Loads commits for, and runs, an interactive rebase (no vscode imports, integration-tested).
import { promises as fs } from 'fs';
import * as path from 'path';
import { GitResult } from '../git/gitCli';
import { Repo } from '../git/repo';
import { buildTodo, RebaseEntry, shellQuote, validateEntries } from './rebaseModel';

export interface RebaseCommit {
  sha: string;
  parents: string[];
  author: string;
  date: number;
  subject: string;
  message: string;
}

/** Commits after `base` up to HEAD, oldest first (the order git applies them). `base` null = from the root. */
export async function loadRebaseCommits(repo: Repo, base: string | null): Promise<RebaseCommit[]> {
  const out = await repo.out(['log', '--reverse', '--format=%H%x1f%P%x1f%an%x1f%at%x1f%B%x1e', base ? `${base}..HEAD` : 'HEAD', '--']);
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, parents, author, date, message] = r.split('\x1f');
      const trimmed = message.trimEnd();
      return { sha, parents: parents ? parents.split(' ') : [], author, date: Number(date), subject: trimmed.split('\n')[0], message: trimmed };
    });
}

/**
 * Runs `git rebase -i` with the given plan. Resolves with git's result; a non-zero exit code
 * usually means the rebase stopped (conflict or `edit`) and is still in progress.
 */
export async function runInteractiveRebase(repo: Repo, base: string | null, entries: RebaseEntry[]): Promise<GitResult> {
  const problem = validateEntries(entries);
  if (problem) {
    throw new Error(problem);
  }
  // Message files must outlive this call: `exec` lines run again after a stop is continued.
  const dir = path.join(await repo.gitDir(), 'jbgit-rebase');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const messageFile = (i: number) => path.join(dir, `message-${i}.txt`);
  await Promise.all(
    entries.map((e, i) => (e.action === 'reword' ? fs.writeFile(messageFile(i), e.message!.trim() + '\n', 'utf8') : undefined)),
  );
  const todo = path.join(dir, 'todo');
  await fs.writeFile(todo, buildTodo(entries, messageFile), 'utf8');

  const args = ['rebase', '--interactive', '--autostash', base ?? '--root'];
  return repo.exec(args, {
    allowFailure: true,
    env: {
      GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todo)}`,
      GIT_EDITOR: 'true', // accept combined squash messages without opening an editor
    },
  });
}
