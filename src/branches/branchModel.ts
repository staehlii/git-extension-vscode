// Pure parsing helpers for branch data (no vscode imports, unit-tested).

export interface BranchInfo {
  kind: 'local' | 'remote';
  /** Short name: "main" for local, "origin/main" for remote. */
  name: string;
  fullRef: string;
  sha: string;
  /** Committer date, unix seconds. */
  date: number;
  isCurrent: boolean;
  /** Local only: short upstream name, e.g. "origin/main". */
  upstream?: string;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  /** Remote only: remote name and branch name on that remote. */
  remote?: string;
  remoteBranch?: string;
}

export const FOR_EACH_REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(committerdate:unix)',
  '%(symref)',
].join('%00');

export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.trim() === 'gone',
  };
}

/** Splits "origin/feature/x" into remote + branch, preferring the longest known remote name. */
export function splitRemoteBranch(shortName: string, remotes: string[]): { remote: string; branch: string } {
  const match = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((r) => shortName.startsWith(r + '/'));
  if (match) {
    return { remote: match, branch: shortName.slice(match.length + 1) };
  }
  const slash = shortName.indexOf('/');
  return { remote: shortName.slice(0, slash), branch: shortName.slice(slash + 1) };
}

/** Parses `git for-each-ref --format=FOR_EACH_REF_FORMAT refs/heads refs/remotes`. */
export function parseBranches(output: string, remotes: string[]): BranchInfo[] {
  const result: BranchInfo[] = [];
  for (const line of output.split('\n')) {
    if (!line) {
      continue;
    }
    const [fullRef, sha, upstream, track, head, date, symref] = line.split('\0');
    if (symref) {
      continue; // e.g. refs/remotes/origin/HEAD -> origin/main
    }
    if (fullRef.startsWith('refs/heads/')) {
      const t = parseTrack(track ?? '');
      result.push({
        kind: 'local',
        name: fullRef.slice('refs/heads/'.length),
        fullRef,
        sha,
        date: Number(date) || 0,
        isCurrent: head === '*',
        upstream: upstream || undefined,
        upstreamGone: t.gone,
        ahead: t.ahead,
        behind: t.behind,
      });
    } else if (fullRef.startsWith('refs/remotes/')) {
      const name = fullRef.slice('refs/remotes/'.length);
      const { remote, branch } = splitRemoteBranch(name, remotes);
      result.push({
        kind: 'remote',
        name,
        fullRef,
        sha,
        date: Number(date) || 0,
        isCurrent: false,
        upstreamGone: false,
        ahead: 0,
        behind: 0,
        remote,
        remoteBranch: branch,
      });
    }
  }
  return result;
}

/** Branch names from `git reflog --format=%gs`, most recent checkout first, unique. */
export function parseRecentCheckouts(reflog: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of reflog.split('\n')) {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    for (const name of [m[2], m[1]]) {
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }
  return result;
}

/** Local branch name to create when checking out a remote branch ("origin/feature/x" -> "feature/x"). */
export function localNameForRemote(branch: BranchInfo): string {
  return branch.remoteBranch ?? branch.name;
}
