import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';

const root = process.env.JBGIT_TEST_REPO!;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);

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

/** Commits different a.txt contents on `branch` and main, then merges `branch` (which conflicts). */
function makeConflict(branch: string): void {
  git('checkout', '-q', '-b', branch);
  write('a.txt', `${branch} side\n`);
  git('commit', '-q', '-m', `${branch}: change a`, 'a.txt');
  git('checkout', '-q', 'main');
  write('a.txt', `main side for ${branch}\n`);
  git('commit', '-q', '-m', `main: change a for ${branch}`, 'a.txt');
  assert.throws(() => git('merge', branch), 'merge should conflict');
}

describe('Conflicts (extension host)', () => {
  let api: ExtensionApi;

  before(async () => {
    api = (await vscode.extensions.getExtension<ExtensionApi>('scewo-internal.jb-git')!.activate())!;
  });

  it('shows conflicts in the commit window and resolves them with Accept Theirs', async () => {
    makeConflict('side-1');
    const cw = api.commitWindow;
    await waitFor(async () => {
      await cw.refresh();
      return cw.conflicts.length === 1;
    }, 'conflict in the commit window');
    assert.strictEqual(cw.conflicts[0].path, 'a.txt');

    await vscode.commands.executeCommand('jbgit.conflicts.acceptTheirs', { type: 'file', change: cw.conflicts[0] });

    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'side-1 side\n');
    assert.strictEqual(git('diff', '--name-only', '--diff-filter=U').trim(), '');
    git('commit', '-q', '--no-edit'); // finish the merge (b.txt stays an unstaged local change)
    assert.strictEqual(git('rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
  });

  it('opens the 3-way merge editor for a conflicted file', async () => {
    makeConflict('side-2');
    const cw = api.commitWindow;
    await waitFor(async () => {
      await cw.refresh();
      return cw.conflicts.length === 1;
    }, 'second conflict');
    await vscode.commands.executeCommand('jbgit.conflicts.merge', { type: 'file', change: cw.conflicts[0] });

    const MergeInput = (vscode as unknown as { TabInputTextMerge?: new (...args: never[]) => unknown }).TabInputTextMerge;
    assert.ok(MergeInput, 'TabInputTextMerge is available at runtime');
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof MergeInput, 'merge editor tab');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    git('merge', '--abort');
    assert.strictEqual(git('diff', '--name-only', '--diff-filter=U').trim(), '', 'no conflicts left');
    assert.throws(() => git('rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'merge aborted');
  });
});
