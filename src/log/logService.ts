// Loads log pages, refs and commit details (no vscode imports, integration-tested).
import { emptyTree, filesBetween } from '../git/history';
import { Repo } from '../git/repo';
import { layoutGraph, GraphRow } from './graphLayout';
import {
  buildLogArgs,
  DETAILS_FORMAT,
  hidesCommits,
  LOG_FORMAT,
  LogFilters,
  parseDetailsHeader,
  parseLog,
  parseRefs,
  REFS_FORMAT,
} from './logModel';
import type { CommitDetailsData, LogCommit, RefLabel } from './protocol';

export interface RefsSnapshot {
  refs: Record<string, RefLabel[]>;
  head: string | undefined;
  /** Changes whenever any ref or HEAD moves; used to decide whether to reload the log. */
  fingerprint: string;
}

export interface LogPage {
  commits: LogCommit[];
  graph: GraphRow[] | null;
  maxLanes: number;
  hasMore: boolean;
}

export async function loadRefs(repo: Repo): Promise<RefsSnapshot> {
  const [refsOut, headRes, symRes] = await Promise.all([
    repo.out(['for-each-ref', `--format=${REFS_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    repo.exec(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true }),
    repo.exec(['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }),
  ]);
  const head = headRes.exitCode === 0 ? headRes.stdout.trim() : undefined;
  const currentRef = symRes.exitCode === 0 ? symRes.stdout.trim() : undefined;
  return {
    refs: parseRefs(refsOut, head, currentRef),
    head,
    fingerprint: `${head}|${currentRef}|${refsOut}`,
  };
}

const HASH_LIKE = /^[0-9a-f]{4,40}$/i;

export async function loadLog(repo: Repo, filters: LogFilters, limit: number, hasHead: boolean): Promise<LogPage> {
  // Ask for one extra commit to know whether there are more.
  let commits = parseLog(await repo.out(buildLogArgs(filters, limit + 1, hasHead)));
  const hasMore = commits.length > limit;
  commits = commits.slice(0, limit);

  // JetBrains' text filter also matches hashes.
  if (filters.text && HASH_LIKE.test(filters.text.trim())) {
    const res = await repo.exec(['rev-parse', '--verify', '-q', `${filters.text.trim()}^{commit}`], { allowFailure: true });
    const sha = res.exitCode === 0 ? res.stdout.trim() : undefined;
    if (sha && !commits.some((c) => c.sha === sha)) {
      commits.unshift(...parseLog(await repo.out(['log', `--format=${LOG_FORMAT}`, '-n1', sha, '--'])));
    }
  }

  if (hidesCommits(filters)) {
    return { commits, graph: null, maxLanes: 0, hasMore };
  }
  const { rows, maxWidth } = layoutGraph(commits);
  return { commits, graph: rows, maxLanes: maxWidth, hasMore };
}

export async function loadDetails(repo: Repo, sha: string): Promise<CommitDetailsData> {
  const header = parseDetailsHeader(await repo.out(['show', '-s', `--format=${DETAILS_FORMAT}`, sha, '--']));
  // Merge commits are shown against their first parent, like JetBrains does by default.
  const parent = header.parents[0] ?? (await emptyTree(repo));
  const files = await filesBetween(repo, parent, header.sha);
  return { ...header, files };
}

export async function branchesContaining(repo: Repo, sha: string): Promise<string[]> {
  const res = await repo.exec(
    ['branch', '--all', '--contains', sha, '--format=%(refname:short)%00%(symref)'],
    { allowFailure: true },
  );
  if (res.exitCode !== 0) {
    return [];
  }
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\0'))
    .filter(([, symref]) => !symref)
    .map(([name]) => name);
}
