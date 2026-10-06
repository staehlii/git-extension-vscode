import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { acceptSide, hasConflictMarkers, markResolved, sideLabels, unmergedStages } from '../../src/conflicts/conflictService';
import { cleanup, git, makeRepo, read, write } from './helpers';

describe('conflictService (real git)', function () {
  this.timeout(20000);
  let root = '';
  afterEach(() => root && cleanup(root));

  /** main and other both change f.txt; other deletes gone.txt which main modifies; both add new.txt. */
  function conflictingMerge() {
    const t = makeRepo({ 'f.txt': 'base\n', 'gone.txt': 'g\n' });
    root = t.root;
    git(root, 'checkout', '-q', '-b', 'other');
    write(root, 'f.txt', 'theirs\n');
    write(root, 'new.txt', 'theirs new\n');
    fs.rmSync(path.join(root, 'gone.txt'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'other side');
    git(root, 'checkout', '-q', 'main');
    write(root, 'f.txt', 'ours\n');
    write(root, 'new.txt', 'ours new\n');
    write(root, 'gone.txt', 'g changed\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'main side');
    assert.throws(() => git(root, 'merge', 'other'));
    return t.repo;
  }

  it('lists the stages of each conflict', async () => {
    const repo = conflictingMerge();
    const stages = await unmergedStages(repo);
    assert.deepStrictEqual([...stages.get('f.txt')!].sort(), [1, 2, 3]);
    assert.deepStrictEqual([...stages.get('new.txt')!].sort(), [2, 3], 'add/add has no base');
    assert.deepStrictEqual([...stages.get('gone.txt')!].sort(), [1, 2], 'deleted by them');
  });

  it('accepts yours, keeping a file the other side deleted', async () => {
    const repo = conflictingMerge();
    await acceptSide(repo, ['f.txt', 'new.txt', 'gone.txt'], 'ours');
    assert.strictEqual(read(root, 'f.txt'), 'ours\n');
    assert.strictEqual(read(root, 'new.txt'), 'ours new\n');
    assert.strictEqual(read(root, 'gone.txt'), 'g changed\n');
    assert.strictEqual((await unmergedStages(repo)).size, 0);
  });

  it('accepts theirs, removing a file they deleted', async () => {
    const repo = conflictingMerge();
    await acceptSide(repo, ['f.txt', 'gone.txt'], 'theirs');
    assert.strictEqual(read(root, 'f.txt'), 'theirs\n');
    assert.ok(!fs.existsSync(path.join(root, 'gone.txt')));
    assert.deepStrictEqual([...(await unmergedStages(repo)).keys()], ['new.txt']);
  });

  it('marks manually edited files as resolved and detects leftover markers', async () => {
    const repo = conflictingMerge();
    assert.strictEqual(await hasConflictMarkers(path.join(root, 'f.txt')), true);
    write(root, 'f.txt', 'merged by hand\n');
    assert.strictEqual(await hasConflictMarkers(path.join(root, 'f.txt')), false);
    await markResolved(repo, ['f.txt']);
    assert.ok(!(await unmergedStages(repo)).has('f.txt'));
  });

  it('labels both sides of a merge', async () => {
    const repo = conflictingMerge();
    assert.deepStrictEqual(await sideLabels(repo), { ours: 'main', theirs: "branch 'other'" });
  });
});
