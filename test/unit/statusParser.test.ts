import * as assert from 'assert';
import { parseStatusV2 } from '../../src/commit/statusParser';

// Captured from git 2.53 (`git status --porcelain=v2 -z --untracked-files=all`).
const REAL = [
  '1 AD N... 000000 100644 000000 0000000000000000000000000000000000000000 718f4d2ff533cf8ead8d3556cf43912bd245fbc4 added-then-deleted.txt',
  '1 MM N... 100644 100644 100644 4bcfe98e640c8284511312660fb8709b0afa888e 23781aaed6690891e24a6b0b95ff3cf270e8d781 both.txt',
  '1 .D N... 100644 100644 000000 61780798228d17af2d34fce4cfbdf35556832472 61780798228d17af2d34fce4cfbdf35556832472 del.txt',
  '1 .M N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 mod.txt',
  '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 8ba3a16384aacc37d01564b28401755ce8053f51 new.txt',
  '2 R. N... 100644 100644 100644 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 R100 renamed file.txt',
  'ren.txt',
  '1 D. N... 100644 000000 000000 d905d9da82c97264ab6f4920e20242e088850ce9 0000000000000000000000000000000000000000 staged-del.txt',
  '? dir/inner.txt',
  '? untracked.txt',
  '',
].join('\0');

const CONFLICT =
  'u UU N... 100644 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 30305bbaebba8e349ab281b7391c946c005fcdd7 e45c9c2666d44e0327c1f9c239a74c508336053e mod.txt\0';

describe('parseStatusV2', () => {
  it('classifies every change kind relative to HEAD', () => {
    const byPath = Object.fromEntries(parseStatusV2(REAL).map((c) => [c.path, c]));
    assert.strictEqual(byPath['added-then-deleted.txt'], undefined);
    assert.strictEqual(byPath['both.txt'].kind, 'modified');
    assert.strictEqual(byPath['del.txt'].kind, 'deleted');
    assert.strictEqual(byPath['mod.txt'].kind, 'modified');
    assert.strictEqual(byPath['new.txt'].kind, 'added');
    assert.strictEqual(byPath['renamed file.txt'].kind, 'renamed');
    assert.strictEqual(byPath['renamed file.txt'].origPath, 'ren.txt');
    assert.strictEqual(byPath['staged-del.txt'].kind, 'deleted');
    assert.strictEqual(byPath['dir/inner.txt'].kind, 'untracked');
    assert.strictEqual(byPath['untracked.txt'].kind, 'untracked');
    assert.strictEqual(Object.keys(byPath).length, 8);
  });

  it('parses conflicts', () => {
    assert.deepStrictEqual(parseStatusV2(CONFLICT), [{ path: 'mod.txt', kind: 'conflict', xy: 'UU' }]);
  });

  it('merges a staged deletion and a re-created file into a modification', () => {
    const out = '1 D. N... 100644 000000 000000 aaaa 0000 f.txt\0? f.txt\0';
    assert.deepStrictEqual(parseStatusV2(out).map((c) => c.kind), ['modified']);
  });

  it('ignores headers and ignored files', () => {
    assert.deepStrictEqual(parseStatusV2('# branch.oid abc\0! ignored.log\0'), []);
  });
});
