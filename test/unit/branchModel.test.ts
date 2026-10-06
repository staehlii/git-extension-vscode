import * as assert from 'assert';
import { parseBranches, parseRecentCheckouts, parseTrack, splitRemoteBranch } from '../../src/branches/branchModel';

describe('branchModel', () => {
  it('parses track info', () => {
    assert.deepStrictEqual(parseTrack('ahead 2, behind 1'), { ahead: 2, behind: 1, gone: false });
    assert.deepStrictEqual(parseTrack('behind 3'), { ahead: 0, behind: 3, gone: false });
    assert.deepStrictEqual(parseTrack('gone'), { ahead: 0, behind: 0, gone: true });
    assert.deepStrictEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
  });

  it('splits remote branches using the longest remote name', () => {
    assert.deepStrictEqual(splitRemoteBranch('origin/feature/x', ['origin']), { remote: 'origin', branch: 'feature/x' });
    assert.deepStrictEqual(splitRemoteBranch('team/a/main', ['team', 'team/a']), { remote: 'team/a', branch: 'main' });
  });

  it('parses for-each-ref output and skips symrefs', () => {
    const out = [
      ['refs/heads/main', 'aaa', 'origin/main', 'ahead 1', '*', '100', ''].join('\0'),
      ['refs/heads/feat', 'bbb', '', '', ' ', '200', ''].join('\0'),
      ['refs/remotes/origin/HEAD', 'aaa', '', '', ' ', '100', 'refs/remotes/origin/main'].join('\0'),
      ['refs/remotes/origin/main', 'ccc', '', '', ' ', '50', ''].join('\0'),
      '',
    ].join('\n');
    const branches = parseBranches(out, ['origin']);
    assert.strictEqual(branches.length, 3);
    assert.strictEqual(branches[0].name, 'main');
    assert.strictEqual(branches[0].isCurrent, true);
    assert.strictEqual(branches[0].ahead, 1);
    assert.strictEqual(branches[0].upstream, 'origin/main');
    assert.strictEqual(branches[1].upstream, undefined);
    assert.strictEqual(branches[2].kind, 'remote');
    assert.strictEqual(branches[2].remote, 'origin');
    assert.strictEqual(branches[2].remoteBranch, 'main');
  });

  it('lists recent checkouts newest first without duplicates', () => {
    const reflog = [
      'checkout: moving from feat to main',
      'commit: something',
      'checkout: moving from main to feat',
      'checkout: moving from dev to main',
    ].join('\n');
    assert.deepStrictEqual(parseRecentCheckouts(reflog), ['main', 'feat', 'dev']);
  });
});
