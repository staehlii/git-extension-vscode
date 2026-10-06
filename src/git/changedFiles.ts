// Parsing of `git diff --name-status -z` output (no vscode imports, unit-tested).

export interface ChangedFile {
  /** A, M, D, R, C, T, U … (first letter of git's status). */
  status: string;
  /** Repo-relative path before the change (differs from `path` for renames/copies). */
  oldPath: string;
  path: string;
}

export function parseNameStatusZ(output: string): ChangedFile[] {
  const parts = output.split('\0');
  const result: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length && parts[i]) {
    const status = parts[i++][0];
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      result.push({ status, oldPath, path });
    } else {
      const path = parts[i++];
      result.push({ status, oldPath: path, path });
    }
  }
  return result;
}
