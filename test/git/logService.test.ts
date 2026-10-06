import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../../src/git/gitCli';
import { Repo } from '../../src/git/repo';
import { branchesContaining, loadDetails, loadLog, loadRefs } from '../../src/log/logService';
import { cleanup, git, makeRepo, write } from './helpers';

describe('logService (real git)', function () {
  this.timeout(20000);
  let root = '';
  afterEach(() => root && cleanup(root));

  function setup() {
    const t = makeRepo({ 'a.txt': 'a\n' });
    root = t.root;
    git(root, 'tag', '-a', 'v1.0', '-m', 'release'); // annotated tag on the root commit
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'b.txt', 'b\n');
    git(root, 'add', 'b.txt');
    git(root, 'commit', '-q', '-m', 'Add b (fix #12)');
    git(root, 'checkout', '-q', 'main');
    write(root, 'a.txt', 'a2\n');
    git(root, 'commit', '-q', '-am', 'Change a');
    git(root, 'merge', '-q', '--no-ff', 'feature', '-m', 'Merge feature');
    return t.repo;
  }

  it('loads all commits with a graph and labels, peeling annotated tags', async () => {
    const repo = setup();
    const refs = await loadRefs(repo);
    const page = await loadLog(repo, {}, 100, true);
    assert.deepStrictEqual(page.commits.map((c) => c.subject), ['Merge feature', 'Add b (fix #12)', 'Change a', 'init']);
    assert.strictEqual(page.hasMore, false);
    assert.ok(page.graph && page.graph.length === 4);
    assert.strictEqual(page.maxLanes, 2);
    const root = page.commits[3].sha;
    assert.deepStrictEqual(refs.refs[root].map((r) => r.name), ['v1.0']);
    assert.deepStrictEqual(refs.refs[refs.head!].map((r) => [r.name, !!r.current]), [['main', true]]);
  });

  it('pages with hasMore', async () => {
    const repo = setup();
    const page = await loadLog(repo, {}, 2, true);
    assert.strictEqual(page.commits.length, 2);
    assert.strictEqual(page.hasMore, true);
  });

  it('filters by text (case-insensitive, literal), hash, author, branch and path', async () => {
    const repo = setup();
    const byText = await loadLog(repo, { text: 'FIX #12' }, 100, true);
    assert.deepStrictEqual(byText.commits.map((c) => c.subject), ['Add b (fix #12)']);
    assert.strictEqual(byText.graph, null, 'no graph when commits are hidden');

    const changeA = (await loadLog(repo, {}, 100, true)).commits[2];
    const byHash = await loadLog(repo, { text: changeA.sha.slice(0, 8) }, 100, true);
    assert.strictEqual(byHash.commits[0].sha, changeA.sha);

    assert.strictEqual((await loadLog(repo, { authors: ['nobody'] }, 100, true)).commits.length, 0);
    assert.strictEqual((await loadLog(repo, { authors: ['test'] }, 100, true)).commits.length, 4);

    const feature = await loadLog(repo, { branches: ['feature'] }, 100, true);
    assert.deepStrictEqual(feature.commits.map((c) => c.subject), ['Add b (fix #12)', 'init']);
    assert.ok(feature.graph, 'branch filter keeps the graph');

    const byPath = await loadLog(repo, { paths: ['b.txt'] }, 100, true);
    assert.deepStrictEqual(byPath.commits.map((c) => c.subject), ['Add b (fix #12)']);
  });

  it('loads details: merge commits against the first parent, root commits against the empty tree', async () => {
    const repo = setup();
    const merge = await loadDetails(repo, 'HEAD');
    assert.strictEqual(merge.parents.length, 2);
    assert.deepStrictEqual(merge.files.map((f) => `${f.status} ${f.path}`), ['A b.txt']);
    assert.strictEqual(merge.message, 'Merge feature');

    const root = await loadDetails(repo, 'v1.0^{commit}');
    assert.deepStrictEqual(root.files.map((f) => `${f.status} ${f.path}`), ['A a.txt']);
  });

  it('lists branches containing a commit', async () => {
    const repo = setup();
    const featureTip = git(root, 'rev-parse', 'feature').trim();
    assert.deepStrictEqual((await branchesContaining(repo, featureTip)).sort(), ['feature', 'main']);
  });

  it('handles an empty repository', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbgit-test-'));
    git(root, 'init', '-q', '-b', 'main');
    const repo = new Repo(root, {} as never, new GitCli('git'));
    const refs = await loadRefs(repo);
    assert.strictEqual(refs.head, undefined);
    const page = await loadLog(repo, {}, 100, false);
    assert.deepStrictEqual(page.commits, []);
  });
});
