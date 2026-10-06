// Parser for `git status --porcelain=v2 -z --untracked-files=all` (no vscode imports, unit-tested).
// Record formats (verified against git 2.53 output):
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
//   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
//   ? <path>

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface FileChange {
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Original path for renames. */
  origPath?: string;
  /** Change relative to HEAD, combining index and working tree like JetBrains does. */
  kind: ChangeKind;
  /** Raw XY status from git ("??" for untracked). */
  xy: string;
}

/** Splits off `count` space-separated fields; the remainder (which may contain spaces) is the path. */
function fieldsAndPath(record: string, count: number): { fields: string[]; path: string } {
  const fields: string[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const next = record.indexOf(' ', pos);
    fields.push(record.slice(pos, next));
    pos = next + 1;
  }
  return { fields, path: record.slice(pos) };
}

function kindFor(xy: string): ChangeKind | undefined {
  const [x, y] = xy;
  if (x === 'A' && y === 'D') {
    return undefined; // added to the index, then deleted: no change relative to HEAD
  }
  if (x === 'A') {
    return 'added';
  }
  if (x === 'D' || y === 'D') {
    return 'deleted';
  }
  return 'modified';
}

export function parseStatusV2(output: string): FileChange[] {
  const tokens = output.split('\0');
  const byPath = new Map<string, FileChange>();
  const add = (c: FileChange) => {
    const existing = byPath.get(c.path);
    // Staged deletion + new untracked file at the same path is a modification relative to HEAD.
    if (existing && existing.kind === 'deleted' && c.kind === 'untracked') {
      existing.kind = 'modified';
      return;
    }
    byPath.set(c.path, c);
  };

  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (!record) {
      continue;
    }
    switch (record[0]) {
      case '1': {
        const { fields, path } = fieldsAndPath(record, 8);
        const kind = kindFor(fields[1]);
        if (kind) {
          add({ path, kind, xy: fields[1] });
        }
        break;
      }
      case '2': {
        const { fields, path } = fieldsAndPath(record, 9);
        const origPath = tokens[++i];
        const xy = fields[1];
        if (xy[1] === 'D') {
          add({ path: origPath, kind: 'deleted', xy });
        } else if (xy[0] === 'C') {
          add({ path, kind: 'added', xy });
        } else {
          add({ path, origPath, kind: 'renamed', xy });
        }
        break;
      }
      case 'u': {
        const { fields, path } = fieldsAndPath(record, 10);
        add({ path, kind: 'conflict', xy: fields[1] });
        break;
      }
      case '?':
        add({ path: record.slice(2), kind: 'untracked', xy: '??' });
        break;
      default:
        break; // '#' headers and '!' ignored entries
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Paths git needs to see for this change (both sides of a rename). */
export function pathsOf(change: FileChange): string[] {
  return change.origPath ? [change.origPath, change.path] : [change.path];
}
