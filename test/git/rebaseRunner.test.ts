import * as assert from 'assert';
import { loadRebaseCommits, runInteractiveRebase } from '../../src/rebase/rebaseRunner';
import { RebaseAction, RebaseEntry } from '../../src/rebase/rebaseModel';
import { cleanup, git, makeRepo, write } from './helpers';

describe('rebaseRunner (real git)', function () {
  this.timeout(20000);
  let root = '';
  afterEach(() => root && cleanup(root));

  /** base + commits one..four, each touching its own file. */
  function fourCommits() {
    const t = makeRepo({ 'base.txt': 'base\n' });
    root = t.root;
    for (const name of ['one', 'two', 'three', 'four']) {
      write(root, `${name}.txt`, `${name}\n`);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', name);
    }
    return { repo: t.repo, base: git(root, 'rev-parse', 'HEAD~4').trim() };
  }

  const subjects = () => git(root, 'log', '--format=%s').trim().split('\n');
  const plan = (commits: { sha: string }[], ...actions: RebaseAction[]): RebaseEntry[] => commits.map((c, i) => ({ sha: c.sha, action: actions[i] }));

  it('loads commits oldest first with full messages', async () => {
    const { repo, base } = fourCommits();
    const commits = await loadRebaseCommits(repo, base);
    assert.deepStrictEqual(commits.map((c) => c.subject), ['one', 'two', 'three', 'four']);
  });

  it('reorders and drops commits', async () => {
    const { repo, base } = fourCommits();
    const [one, two, three, four] = await loadRebaseCommits(repo, base);
    const res = await runInteractiveRebase(repo, base, [
      { sha: two.sha, action: 'pick' },
      { sha: one.sha, action: 'pick' },
      { sha: four.sha, action: 'pick' },
      { sha: three.sha, action: 'drop' },
    ]);
    assert.strictEqual(res.exitCode, 0, res.stderr);
    assert.deepStrictEqual(subjects(), ['four', 'one', 'two', 'init']);
    assert.strictEqual(await repo.operationState(), 'none');
  });

  it('squashes (combining messages) and fixes up (discarding the message)', async () => {
    const { repo, base } = fourCommits();
    const commits = await loadRebaseCommits(repo, base);
    const res = await runInteractiveRebase(repo, base, plan(commits, 'pick', 'squash', 'fixup', 'pick'));
    assert.strictEqual(res.exitCode, 0, res.stderr);
    assert.strictEqual(git(root, 'rev-list', '--count', 'HEAD').trim(), '3');
    const combined = git(root, 'log', '-1', '--format=%B', 'HEAD~1');
    assert.match(combined, /one/);
    assert.match(combined, /two/);
    assert.doesNotMatch(combined, /three/);
    assert.doesNotMatch(combined, /^#/m, 'no comment lines left in the squash message');
    assert.strictEqual(git(root, 'show', 'HEAD~1:three.txt'), 'three\n', 'fixup keeps the changes');
  });

  it('rewords without an editor, including quotes in the message', async () => {
    const { repo, base } = fourCommits();
    const commits = await loadRebaseCommits(repo, base);
    const entries = plan(commits, 'pick', 'reword', 'pick', 'pick');
    entries[1].message = "two: it's reworded\n\nWith a body";
    const res = await runInteractiveRebase(repo, base, entries);
    assert.strictEqual(res.exitCode, 0, res.stderr);
    assert.strictEqual(git(root, 'log', '-1', '--format=%B', 'HEAD~2').trim(), "two: it's reworded\n\nWith a body");
    assert.deepStrictEqual(subjects(), ['four', 'three', "two: it's reworded", 'one', 'init']);
  });

  it('stops for edit and can be continued', async () => {
    const { repo, base } = fourCommits();
    const commits = await loadRebaseCommits(repo, base);
    const res = await runInteractiveRebase(repo, base, plan(commits, 'pick', 'edit', 'pick', 'pick'));
    assert.strictEqual(await repo.operationState(), 'rebasing');
    assert.strictEqual(git(root, 'log', '-1', '--format=%s').trim(), 'two', `stopped at 'two' (exit ${res.exitCode})`);
    await repo.exec(['rebase', '--continue'], { env: { GIT_EDITOR: 'true' } });
    assert.strictEqual(await repo.operationState(), 'none');
    assert.strictEqual(subjects().length, 5);
  });

  it('rebases from the root commit and stashes local changes', async () => {
    const { repo } = fourCommits();
    write(root, 'base.txt', 'local edit\n');
    const commits = await loadRebaseCommits(repo, null);
    assert.strictEqual(commits[0].subject, 'init');
    const res = await runInteractiveRebase(repo, null, plan(commits, 'pick', 'fixup', 'pick', 'pick', 'pick'));
    assert.strictEqual(res.exitCode, 0, res.stderr);
    assert.deepStrictEqual(subjects(), ['four', 'three', 'two', 'init']);
    assert.strictEqual(git(root, 'diff', '--name-only').trim(), 'base.txt', 'local change restored');
  });
});
