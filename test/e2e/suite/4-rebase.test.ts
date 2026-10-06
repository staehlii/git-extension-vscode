import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';

const root = process.env.JBGIT_TEST_REPO!;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

describe('Interactive rebase (extension host)', () => {
  let api: ExtensionApi;

  before(async () => {
    api = (await vscode.extensions.getExtension<ExtensionApi>('scewo-internal.jb-git')!.activate())!;
    for (const name of ['e', 'f']) {
      fs.writeFileSync(path.join(root, `${name}.txt`), `${name}\n`);
      git('add', `${name}.txt`);
      git('commit', '-q', '-m', `Add ${name}`, `${name}.txt`);
    }
  });

  it('opens the rebase editor from the log context menu and its webview loads', async () => {
    const from = git('rev-parse', 'HEAD~1').trim(); // "Add e"
    const loaded = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('rebase editor did not load')), 20000);
      api.onDidRebaseEditorLoad((title) => {
        clearTimeout(timer);
        resolve(title);
      });
    });
    await vscode.commands.executeCommand('jbgit.log.interactiveRebase', { webviewSection: 'commit', sha: from });
    assert.strictEqual(await loaded, "Rebase 'main'");
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('refuses a range that contains merge commits', async () => {
    let opened = false;
    const sub = api.onDidRebaseEditorLoad(() => (opened = true));
    const beforeMerge = git('rev-parse', 'HEAD~3').trim(); // the range now includes the merge from the conflict tests
    await vscode.commands.executeCommand('jbgit.log.interactiveRebase', { sha: beforeMerge });
    await new Promise((r) => setTimeout(r, 1000));
    sub.dispose();
    assert.strictEqual(opened, false);
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label.startsWith('Rebase')), false);
  });
});
