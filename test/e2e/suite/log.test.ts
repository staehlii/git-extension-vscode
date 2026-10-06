import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';

const root = process.env.JBGIT_TEST_REPO!;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('Git Log (extension host)', () => {
  let api: ExtensionApi;
  const subjects = () => api.log.loadedCommits.map((c) => c.subject);
  const head = () => git('rev-parse', 'HEAD').trim();

  before(async () => {
    api = (await vscode.extensions.getExtension<ExtensionApi>('scewo-internal.jb-git')!.activate())!;
    // A commit on another branch to cherry-pick (the working tree still has local changes in b.txt).
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(root, 'd.txt'), 'd\n');
    git('add', 'd.txt');
    git('commit', '-q', '-m', 'Add d on feature');
    git('checkout', '-q', 'main');
  });

  it('loads commits through the webview (script runs, posts ready, receives data)', async () => {
    await vscode.commands.executeCommand('jbgit.log.show');
    await waitFor(() => subjects().includes('Add d on feature'), 'log data in the webview round trip');
    assert.deepStrictEqual(subjects(), ['Add d on feature', 'Reworded', 'init']);
  });

  it('cherry-picks from the context menu and reloads when refs move', async () => {
    const feature = api.log.loadedCommits.find((c) => c.subject === 'Add d on feature')!;
    const previous = head();
    await vscode.commands.executeCommand('jbgit.log.cherryPick', { webviewSection: 'commit', sha: feature.sha });
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'Add d on feature');
    // (May be byte-identical to the feature commit, since its parent is the old HEAD.)
    assert.strictEqual(git('rev-parse', 'HEAD^').trim(), previous);
    await waitFor(() => api.log.loadedCommits.some((c) => c.sha === head()), 'log reload after cherry-pick');
  });

  it('reverts a commit', async () => {
    const sha = head();
    await vscode.commands.executeCommand('jbgit.log.revert', { sha });
    assert.match(git('log', '-1', '--format=%s').trim(), /^Revert "Add d on feature"/);
    assert.ok(!fs.existsSync(path.join(root, 'd.txt')));
  });

  it('undoes the HEAD commit, keeping its changes', async () => {
    const before = git('rev-parse', 'HEAD~1').trim();
    await waitFor(() => api.log.loadedCommits[0]?.sha === head(), 'log to show the revert commit');
    await vscode.commands.executeCommand('jbgit.log.undoCommit', { sha: head() });
    assert.strictEqual(head(), before);
    assert.match(git('status', '--porcelain', 'd.txt'), /^D /, 'the revert is kept as a staged deletion');
    git('reset', '-q', '--hard', 'HEAD'); // restore d.txt for the next tests
  });

  it('copies the revision number', async () => {
    const sha = head();
    await waitFor(() => api.log.loadedCommits.some((c) => c.sha === sha), 'log to contain HEAD');
    await vscode.commands.executeCommand('jbgit.log.copyRevision', { sha });
    assert.strictEqual(await vscode.env.clipboard.readText(), sha);
  });

  it('shows the history of a single file', async () => {
    await vscode.commands.executeCommand('jbgit.log.showFileHistory', vscode.Uri.file(path.join(root, 'd.txt')));
    // The feature commit and its cherry-pick (one commit if the cherry-pick was byte-identical).
    await waitFor(() => !subjects().includes('init'), 'file history');
    const expected = git('log', '--format=%s', '--branches', '--', 'd.txt').trim().split('\n');
    assert.deepStrictEqual(subjects(), expected);
    assert.ok(subjects().every((s) => s === 'Add d on feature'));
  });
});
