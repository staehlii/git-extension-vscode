// Commit/file history queries (no vscode imports, so they can be used in plain-node tests).
import { ChangedFile, parseNameStatusZ } from './changedFiles';
import { Repo } from './repo';

export interface CommitSummary {
  sha: string;
  short: string;
  subject: string;
  author: string;
  relDate: string;
}

const LOG_FORMAT = '%H%x00%h%x00%s%x00%an%x00%ar';

export async function listCommits(repo: Repo, range: string[], max = 500): Promise<CommitSummary[]> {
  const out = await repo.out(['log', `--format=${LOG_FORMAT}`, `-n${max}`, ...range, '--']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, short, subject, author, relDate] = line.split('\0');
      return { sha, short, subject, author, relDate };
    });
}

/** The empty tree object, used as the "parent" of root commits. */
export async function emptyTree(repo: Repo): Promise<string> {
  return (await repo.out(['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/** First parent of `sha`, or the empty tree for root commits. */
export async function parentOf(repo: Repo, sha: string): Promise<string> {
  const res = await repo.exec(['rev-parse', '--verify', '-q', `${sha}^1`], { allowFailure: true });
  if (res.exitCode === 0) {
    return res.stdout.trim();
  }
  return emptyTree(repo);
}

export async function filesBetween(repo: Repo, from: string, to?: string): Promise<ChangedFile[]> {
  const args = ['diff', '--name-status', '-z', '-M', from];
  if (to) {
    args.push(to);
  }
  return parseNameStatusZ(await repo.out([...args, '--']));
}

