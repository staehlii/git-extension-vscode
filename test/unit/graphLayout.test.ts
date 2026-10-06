import * as assert from 'assert';
import { GraphCommit, GraphRow, layoutGraph } from '../../src/log/graphLayout';

const c = (sha: string, ...parents: string[]): GraphCommit => ({ sha, parents });
const lines = (row: GraphRow, kind: string) =>
  row.lines.filter((l) => l.kind === kind).map((l) => `${l.from}>${l.to}`).sort();

/** Every lane drawn at the bottom of a row must be drawn at the top of the next row (continuity). */
function assertContinuous(rows: GraphRow[]): void {
  for (let i = 0; i + 1 < rows.length; i++) {
    const out = new Set(rows[i].lines.filter((l) => l.kind !== 'top').map((l) => l.to));
    const into = new Set(rows[i + 1].lines.filter((l) => l.kind !== 'bottom').map((l) => l.from));
    assert.deepStrictEqual([...into].sort(), [...out].sort(), `rows ${i} -> ${i + 1}`);
  }
}

describe('layoutGraph', () => {
  it('keeps a linear history in one column', () => {
    const { rows, maxWidth } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    assert.deepStrictEqual(rows.map((r) => r.col), [0, 0, 0]);
    assert.strictEqual(maxWidth, 1);
    assert.deepStrictEqual(lines(rows[0], 'bottom'), ['0>0']);
    assert.deepStrictEqual(lines(rows[2], 'bottom'), [], 'root has no parent line');
    assert.strictEqual(new Set(rows.map((r) => r.color)).size, 1);
    assertContinuous(rows);
  });

  it('lays out a branch and its merge', () => {
    //  M      merge of B2 into A2
    //  |\
    //  | B2
    //  A2 |
    //  |/
    //  A1
    const { rows, maxWidth } = layoutGraph([c('M', 'A2', 'B2'), c('B2', 'A1'), c('A2', 'A1'), c('A1')]);
    assert.deepStrictEqual(rows.map((r) => r.col), [0, 1, 0, 0]);
    assert.strictEqual(maxWidth, 2);
    assert.deepStrictEqual(lines(rows[0], 'bottom'), ['0>0', '0>1']);
    assert.deepStrictEqual(lines(rows[1], 'through'), ['0>0']);
    assert.deepStrictEqual(lines(rows[3], 'top'), ['0>0', '1>0'], 'both lanes converge on A1');
    assert.notStrictEqual(rows[1].color, rows[0].color);
    assertContinuous(rows);
  });

  it('handles octopus merges', () => {
    const { rows, maxWidth } = layoutGraph([c('O', 'A', 'B', 'C'), c('C', 'R'), c('B', 'R'), c('A', 'R'), c('R')]);
    assert.strictEqual(maxWidth, 3);
    assert.deepStrictEqual(lines(rows[0], 'bottom'), ['0>0', '0>1', '0>2']);
    assert.deepStrictEqual(lines(rows[4], 'top'), ['0>0', '1>0', '2>0']);
    assertContinuous(rows);
  });

  it('starts new lanes for independent branch tips and compacts when they end', () => {
    // Two tips (X and Y) on the same base; X's lane ends at base, Y passes through.
    const { rows } = layoutGraph([c('X', 'B'), c('Y', 'B'), c('B', 'A'), c('A')]);
    assert.deepStrictEqual(rows.map((r) => r.col), [0, 1, 0, 0]);
    assert.deepStrictEqual(lines(rows[2], 'top'), ['0>0', '1>0']);
    assert.strictEqual(rows[3].width, 1);
    assertContinuous(rows);
  });

  it('handles criss-cross merges and unrelated roots', () => {
    const commits = [
      c('M2', 'A2', 'B2'),
      c('M1', 'B2', 'A2'),
      c('B2', 'B1'),
      c('A2', 'A1'),
      c('B1', 'R'),
      c('A1', 'R'),
      c('R'),
      c('Other'), // unrelated root (e.g. gh-pages)
    ];
    const { rows } = layoutGraph(commits);
    assertContinuous(rows);
    assert.strictEqual(rows[7].lines.length, 0, 'an unrelated root has no lines');
  });

  it('keeps lanes open for parents beyond the loaded page', () => {
    const { rows } = layoutGraph([c('c', 'b'), c('b', 'a')]);
    assert.deepStrictEqual(lines(rows[1], 'bottom'), ['0>0']);
  });
});
