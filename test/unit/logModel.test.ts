import * as assert from 'assert';
import { buildLogArgs, hidesCommits, parseDetailsHeader, parseLog, parseRefs } from '../../src/log/logModel';

describe('logModel', () => {
  it('builds args for all refs by default', () => {
    const args = buildLogArgs({}, 100, true);
    assert.deepStrictEqual(args.slice(2), ['-n100', '--topo-order', '--branches', '--remotes', '--tags', 'HEAD', '--']);
    assert.ok(!buildLogArgs({}, 1, false).includes('HEAD'), 'no HEAD in an empty repo');
  });

  it('builds args for filters', () => {
    const args = buildLogArgs({ text: 'fix', authors: ['Ian', 'Bob'], since: '2026-01-01', branches: ['main'], paths: ['src/a.ts'] }, 50, true);
    assert.ok(args.includes('--fixed-strings') && args.includes('--regexp-ignore-case'));
    assert.ok(args.includes('--grep=fix'));
    assert.ok(args.includes('--author=Ian') && args.includes('--author=Bob'));
    assert.ok(args.includes('--since=2026-01-01'));
    assert.deepStrictEqual(args.slice(-3), ['main', '--', 'src/a.ts']);
    assert.ok(!args.includes('--branches'));
  });

  it('knows which filters break the graph', () => {
    assert.strictEqual(hidesCommits({ branches: ['main'] }), false);
    assert.strictEqual(hidesCommits({ text: 'x' }), true);
    assert.strictEqual(hidesCommits({ paths: ['a'] }), true);
  });

  it('parses log records', () => {
    const out = 'aaa\x1fbbb ccc\x1fIan\x1fi@x\x1f1700000000\x1fMerge it\x1e\nbbb\x1f\x1fIan\x1fi@x\x1f1600000000\x1fRoot: a\x1fb?\x1e\n';
    const commits = parseLog(out);
    assert.strictEqual(commits.length, 2);
    assert.deepStrictEqual(commits[0].parents, ['bbb', 'ccc']);
    assert.strictEqual(commits[0].date, 1700000000);
    assert.deepStrictEqual(commits[1].parents, []);
  });

  it('maps refs to commits, peels tags, skips symrefs and marks the current branch', () => {
    const out = [
      'c1\0\0refs/heads/main\0',
      'c1\0\0refs/remotes/origin/main\0',
      'c1\0\0refs/remotes/origin/HEAD\0refs/remotes/origin/main',
      'tagobj\0c2\0refs/tags/v1.0\0',
      'c2\0\0refs/tags/light\0',
      'c3\0\0refs/heads/feature\0',
      '',
    ].join('\n');
    const refs = parseRefs(out, 'c1', 'refs/heads/main');
    assert.deepStrictEqual(refs['c1'], [
      { name: 'main', kind: 'local', current: true },
      { name: 'origin/main', kind: 'remote' },
    ]);
    assert.deepStrictEqual(refs['c2'].map((r) => r.name), ['light', 'v1.0']);
    assert.strictEqual(refs['tagobj'], undefined);
    const detached = parseRefs(out, 'c3', undefined);
    assert.deepStrictEqual(detached['c3'][0], { name: 'HEAD', kind: 'head' });
  });

  it('parses commit details with a multi-line message', () => {
    const d = parseDetailsHeader('s\x00p1 p2\x00A\x00a@x\x00100\x00C\x00c@x\x00200\x00Subject\n\nBody line\n\n');
    assert.deepStrictEqual(d.parents, ['p1', 'p2']);
    assert.strictEqual(d.message, 'Subject\n\nBody line');
    assert.strictEqual(d.commitDate, 200);
  });
});
