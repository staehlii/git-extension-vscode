import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { commitFiles, rollbackFiles } from '../../src/commit/commitService';
import { FileChange, parseStatusV2 } from '../../src/commit/statusParser';
import { Repo } from '../../src/git/repo';
import { cleanup, git, makeRepo, read, write } from './helpers';

async function status(repo: Repo): Promise<FileChange[]> {
  return parseStatusV2(await repo.out(['status', '--porcelain=v2', '-z', '--untracked-files=all']));
}

function pick(changes: FileChange[], ...paths: string[]): FileChange[] {
  return paths.map((p) => {
    const c = changes.find((x) => x.path === p);
    assert.ok(c, `no change for ${p}`);
    return c;
  });
}

function committedFiles(root: string): string[] {
  return git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
}

describe('commitService (real git)', function () {
  this.timeout(20000);
  let root = '';
  afterEach(() => root && cleanup(root));

  it('commits only the selected files and leaves other staged changes alone', async () => {
    const t = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'staged.txt': 's\n' });
    root = t.root;
    write(root, 'a.txt', 'a2\n');
    write(root, 'b.txt', 'b2\n');
    write(root, 'c.txt', 'c2\n');
    write(root, 'staged.txt', 's2\n');
    git(root, 'add', 'staged.txt');

    await commitFiles(t.repo, { changes: pick(await status(t.repo), 'a.txt', 'b.txt'), message: 'two files', amend: false, commitAll: false });

    assert.deepStrictEqual(committedFiles(root), ['a.txt', 'b.txt']);
    const after = await status(t.repo);
    assert.deepStrictEqual(after.map((c) => c.path), ['c.txt', 'staged.txt']);
    assert.strictEqual(after.find((c) => c.path === 'c.txt')!.xy, '.M', 'c.txt stays unstaged');
    assert.strictEqual(after.find((c) => c.path === 'staged.txt')!.xy, 'M.', 'staged.txt stays staged');
  });

  it('commits the working-tree version of a partially staged file and syncs the index', async () => {
    const t = makeRepo({ 'p.txt': '1\n' });
    root = t.root;
    write(root, 'p.txt', '2\n');
    git(root, 'add', 'p.txt');
    write(root, 'p.txt', '3\n');
    await commitFiles(t.repo, { changes: pick(await status(t.repo), 'p.txt'), message: 'p', amend: false, commitAll: false });
    assert.strictEqual(git(root, 'show', 'HEAD:p.txt'), '3\n');
    assert.deepStrictEqual(await status(t.repo), []);
  });

  it('handles untracked, deleted, renamed and special-character paths', async () => {
    const t = makeRepo({ 'gone.txt': 'g\n', 'old name.txt': 'o\n', 'keep.txt': 'k\n' });
    root = t.root;
    fs.rmSync(path.join(root, 'gone.txt'));
    git(root, 'mv', 'old name.txt', 'new name.txt');
    write(root, 'dir/[weird]*.txt', 'w\n');
    write(root, 'untracked-unselected.txt', 'u\n');

    const changes = await status(t.repo);
    await commitFiles(t.repo, {
      changes: pick(changes, 'gone.txt', 'new name.txt', 'dir/[weird]*.txt'),
      message: 'mixed',
      amend: false,
      commitAll: false,
    });

    const tree = git(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean).sort();
    assert.deepStrictEqual(tree, ['dir/[weird]*.txt', 'keep.txt', 'new name.txt']);
    const after = await status(t.repo);
    assert.deepStrictEqual(after.map((c) => [c.path, c.kind]), [['untracked-unselected.txt', 'untracked']]);
  });

  it('keeps message lines starting with #', async () => {
    const t = makeRepo({ 'a.txt': 'a\n' });
    root = t.root;
    write(root, 'a.txt', 'b\n');
    await commitFiles(t.repo, { changes: await status(t.repo), message: '#123 Fix bug\n\nDetails', amend: false, commitAll: false });
    assert.strictEqual(git(root, 'log', '-1', '--format=%B').trim(), '#123 Fix bug\n\nDetails');
  });

  it('amends: message only, or with extra files', async () => {
    const t = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    root = t.root;
    const before = git(root, 'rev-parse', 'HEAD').trim();
    write(root, 'b.txt', 'b2\n');

    await commitFiles(t.repo, { changes: [], message: 'reworded', amend: true, commitAll: false });
    assert.notStrictEqual(git(root, 'rev-parse', 'HEAD').trim(), before);
    assert.strictEqual(git(root, 'log', '-1', '--format=%s'), 'reworded\n');
    assert.strictEqual(git(root, 'rev-list', '--count', 'HEAD'), '1\n');
    assert.strictEqual(git(root, 'show', 'HEAD:b.txt'), 'b\n', 'message-only amend must not take b.txt');

    await commitFiles(t.repo, { changes: await status(t.repo), message: 'with b', amend: true, commitAll: false });
    assert.strictEqual(git(root, 'show', 'HEAD:b.txt'), 'b2\n');
    assert.strictEqual(git(root, 'rev-list', '--count', 'HEAD'), '1\n');
  });

  it('rejects an empty selection without amend', async () => {
    const t = makeRepo({ 'a.txt': 'a\n' });
    root = t.root;
    await assert.rejects(commitFiles(t.repo, { changes: [], message: 'x', amend: false, commitAll: false }), /No files selected/);
  });

  it('creates a merge commit with commitAll after resolving a conflict', async () => {
    const t = makeRepo({ 'f.txt': 'base\n' });
    root = t.root;
    git(root, 'checkout', '-q', '-b', 'other');
    write(root, 'f.txt', 'other\n');
    git(root, 'commit', '-q', '-am', 'other');
    git(root, 'checkout', '-q', 'main');
    write(root, 'f.txt', 'main\n');
    git(root, 'commit', '-q', '-am', 'main');
    assert.throws(() => git(root, 'merge', 'other'));
    assert.strictEqual(await t.repo.operationState(), 'merging');
    write(root, 'f.txt', 'resolved\n');
    git(root, 'add', 'f.txt');

    await commitFiles(t.repo, { changes: await status(t.repo), message: 'Merge other', amend: false, commitAll: true });
    assert.strictEqual(git(root, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
    assert.strictEqual(await t.repo.operationState(), 'none');
  });

  it('rolls back modified, deleted, renamed and added files', async () => {
    const t = makeRepo({ 'm.txt': 'm\n', 'd.txt': 'd\n', 'r.txt': 'r\n' });
    root = t.root;
    write(root, 'm.txt', 'changed\n');
    fs.rmSync(path.join(root, 'd.txt'));
    git(root, 'mv', 'r.txt', 'r2.txt');
    write(root, 'added.txt', 'new\n');
    git(root, 'add', 'added.txt');
    write(root, 'untracked.txt', 'u\n');

    await rollbackFiles(t.repo, await status(t.repo));

    assert.strictEqual(read(root, 'm.txt'), 'm\n');
    assert.strictEqual(read(root, 'd.txt'), 'd\n');
    assert.strictEqual(read(root, 'r.txt'), 'r\n');
    assert.ok(!fs.existsSync(path.join(root, 'r2.txt')));
    assert.strictEqual(read(root, 'added.txt'), 'new\n', 'added file stays on disk');
    const after = await status(t.repo);
    assert.deepStrictEqual(after.map((c) => [c.path, c.kind]), [
      ['added.txt', 'untracked'],
      ['untracked.txt', 'untracked'],
    ]);
  });
});
