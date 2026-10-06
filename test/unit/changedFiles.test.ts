import * as assert from 'assert';
import { parseNameStatusZ } from '../../src/git/changedFiles';

describe('parseNameStatusZ', () => {
  it('parses plain, renamed and deleted entries', () => {
    const out = 'M\0src/a.ts\0R087\0old.txt\0new.txt\0D\0gone.md\0';
    assert.deepStrictEqual(parseNameStatusZ(out), [
      { status: 'M', oldPath: 'src/a.ts', path: 'src/a.ts' },
      { status: 'R', oldPath: 'old.txt', path: 'new.txt' },
      { status: 'D', oldPath: 'gone.md', path: 'gone.md' },
    ]);
  });

  it('returns nothing for empty output', () => {
    assert.deepStrictEqual(parseNameStatusZ(''), []);
  });
});
