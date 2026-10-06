// git log argument building and output parsing (no vscode imports, unit-tested).
import type { LogCommit, RefLabel } from './protocol';

export interface LogFilters {
  text?: string;
  /** Revisions to show; undefined means all branches, remotes, tags and HEAD. */
  branches?: string[];
  authors?: string[];
  since?: string;
  until?: string;
  /** Human label for the date filter, e.g. "Last 7 days". */
  dateLabel?: string;
  paths?: string[];
}

export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e';

/** True when filters hide commits in a way that breaks the graph (only the branch filter keeps it intact). */
export function hidesCommits(f: LogFilters): boolean {
  return !!(f.text || f.authors?.length || f.since || f.until || f.paths?.length);
}

export function buildLogArgs(f: LogFilters, limit: number, hasHead: boolean): string[] {
  const args = ['log', `--format=${LOG_FORMAT}`, `-n${limit}`, '--topo-order'];
  if (f.text || f.authors?.length) {
    args.push('--regexp-ignore-case', '--fixed-strings');
  }
  if (f.text) {
    args.push(`--grep=${f.text}`);
  }
  for (const a of f.authors ?? []) {
    args.push(`--author=${a}`);
  }
  if (f.since) {
    args.push(`--since=${f.since}`);
  }
  if (f.until) {
    args.push(`--until=${f.until}`);
  }
  if (f.branches?.length) {
    args.push(...f.branches);
  } else {
    args.push('--branches', '--remotes', '--tags');
    if (hasHead) {
      args.push('HEAD');
    }
  }
  args.push('--', ...(f.paths ?? []));
  return args;
}

export function parseLog(output: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const record of output.split('\x1e')) {
    const line = record.replace(/^\n/, '');
    if (!line) {
      continue;
    }
    const [sha, parents, author, email, date, subject] = line.split('\x1f');
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date) || 0,
      subject: subject ?? '',
    });
  }
  return commits;
}

export const REFS_FORMAT = '%(objectname)%00%(*objectname)%00%(refname)%00%(symref)';

const KIND_ORDER: Record<RefLabel['kind'], number> = { head: 0, local: 1, remote: 2, tag: 3 };

/**
 * Maps commit sha -> ref labels from `git for-each-ref --format=REFS_FORMAT refs/heads refs/remotes refs/tags`.
 * `currentRef` is the checked-out branch (e.g. "refs/heads/main"), or undefined when HEAD is detached.
 */
export function parseRefs(output: string, headSha: string | undefined, currentRef: string | undefined): Record<string, RefLabel[]> {
  const map: Record<string, RefLabel[]> = {};
  const add = (sha: string, label: RefLabel) => (map[sha] ??= []).push(label);
  for (const line of output.split('\n')) {
    if (!line) {
      continue;
    }
    const [object, peeled, ref, symref] = line.split('\0');
    if (symref) {
      continue; // origin/HEAD
    }
    const sha = peeled || object; // annotated tags point at a tag object; use the commit
    if (ref.startsWith('refs/heads/')) {
      add(sha, { name: ref.slice(11), kind: 'local', current: ref === currentRef || undefined });
    } else if (ref.startsWith('refs/remotes/')) {
      add(sha, { name: ref.slice(13), kind: 'remote' });
    } else if (ref.startsWith('refs/tags/')) {
      add(sha, { name: ref.slice(10), kind: 'tag' });
    }
  }
  if (headSha && !currentRef) {
    add(headSha, { name: 'HEAD', kind: 'head' });
  }
  for (const labels of Object.values(map)) {
    labels.sort((a, b) => Number(!!b.current) - Number(!!a.current) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  }
  return map;
}

export const DETAILS_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B';

export function parseDetailsHeader(output: string) {
  const parts = output.split('\0');
  const [sha, parents, author, email, authorDate, committer, committerEmail, commitDate] = parts;
  return {
    sha,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    authorDate: Number(authorDate) || 0,
    committer,
    committerEmail,
    commitDate: Number(commitDate) || 0,
    message: parts.slice(8).join('\0').trimEnd(),
  };
}
