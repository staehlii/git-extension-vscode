// Commit graph lane layout (no vscode/DOM imports, unit-tested).
//
// Commits arrive newest first in topological order. Each "lane" is a vertical line expecting a
// specific commit further down. For every row we record the node column and the line segments
// inside that row, using columns as x and three y positions: top edge, node centre, bottom edge.

export interface GraphLine {
  /** 'top': lane `from` (top edge) into the node. 'bottom': node to lane `to` (bottom edge). 'through': lane passes the row. */
  kind: 'top' | 'bottom' | 'through';
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  col: number;
  color: number;
  lines: GraphLine[];
  /** Number of columns this row needs (max of lanes above, below and the node). */
  width: number;
}

export interface GraphCommit {
  sha: string;
  parents: string[];
}

interface Lane {
  sha: string;
  color: number;
}

export function layoutGraph(commits: GraphCommit[]): { rows: GraphRow[]; maxWidth: number } {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let maxWidth = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes;
    let col = before.findIndex((l) => l.sha === commit.sha);
    const work: (Lane | null)[] = before.map((l) => ({ ...l }));
    let nodeColor: number;
    if (col === -1) {
      // Branch tip (nothing above expects this commit): start a new lane in the first free slot.
      col = work.length;
      nodeColor = nextColor++;
      work.push({ sha: commit.sha, color: nodeColor });
    } else {
      nodeColor = before[col].color;
    }

    const lines: GraphLine[] = [];
    before.forEach((l, j) => {
      if (l.sha === commit.sha) {
        lines.push({ kind: 'top', from: j, to: col, color: l.color });
        if (j !== col) {
          work[j] = null; // this lane merges into the node
        }
      }
    });

    // Lanes leaving the node towards its parents (by index in `work`, before compaction).
    const outgoing: { index: number; color: number }[] = [];
    if (commit.parents.length === 0) {
      work[col] = null;
    } else {
      work[col] = { sha: commit.parents[0], color: nodeColor };
      outgoing.push({ index: col, color: nodeColor });
      for (const parent of commit.parents.slice(1)) {
        let k = work.findIndex((l) => l !== null && l.sha === parent);
        if (k === -1) {
          k = work.findIndex((l, idx) => l === null && idx !== col);
          const lane = { sha: parent, color: nextColor++ };
          if (k === -1) {
            k = work.length;
            work.push(lane);
          } else {
            work[k] = lane;
          }
        }
        outgoing.push({ index: k, color: work[k]!.color });
      }
    }

    // Compact: drop finished lanes so the graph stays narrow; remember where each index moves.
    const newIndex: number[] = [];
    const after: Lane[] = [];
    work.forEach((l, i) => {
      newIndex[i] = after.length;
      if (l) {
        after.push(l);
      }
    });

    before.forEach((l, j) => {
      if (l.sha !== commit.sha && work[j]) {
        lines.push({ kind: 'through', from: j, to: newIndex[j], color: l.color });
      }
    });
    for (const o of outgoing) {
      lines.push({ kind: 'bottom', from: col, to: newIndex[o.index], color: o.color });
    }

    const width = Math.max(before.length, after.length, col + 1);
    maxWidth = Math.max(maxWidth, width);
    rows.push({ col, color: nodeColor, lines, width });
    lanes = after;
  }
  return { rows, maxWidth };
}
