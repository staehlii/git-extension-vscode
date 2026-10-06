import * as assert from 'assert';
import { execFileSync } from 'child_process';
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

describe('Commit window (extension host)', () => {
  const ext = vscode.extensions.getExtension<ExtensionApi | undefined>('scewo-internal.jb-git')!;
  let api: ExtensionApi;

  before(async () => {
    const exported = await ext.activate();
    assert.ok(exported, 'activate() returned no API (is vscode.git available?)');
    api = exported;
    await waitFor(async () => {
      await api.commitWindow.refresh();
      return api.commitWindow.changes.length === 3;
    }, 'the fixture repo to be discovered');
  });

  it('registers every contributed command', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = (ext.packageJSON.contributes.commands as { command: string }[])
      .map((c) => c.command)
      .filter((c) => !all.has(c));
    assert.deepStrictEqual(missing, []);
  });

  it('opens both views', async () => {
    await vscode.commands.executeCommand('jbgit.changes.focus');
    await vscode.commands.executeCommand('jbgit.commitMessage.focus');
  });

  it('ticks the active changelist and lists unversioned files separately', () => {
    const cw = api.commitWindow;
    assert.deepStrictEqual(cw.includedChanges().map((c) => c.path).sort(), ['a.txt', 'b.txt']);
    assert.deepStrictEqual(cw.unversioned.map((c) => c.path), ['c.txt']);
    assert.strictEqual(cw.changelists.length, 1);
  });

  it('shows a diff against HEAD through the jbgit: scheme', async () => {
    const change = api.commitWindow.changes.find((c) => c.path === 'a.txt')!;
    await vscode.commands.executeCommand('jbgit.commit.openChange', { type: 'file', change });
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, 'diff tab');
    const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
    assert.strictEqual(input.original.scheme, 'jbgit');
    const original = await vscode.workspace.openTextDocument(input.original);
    assert.strictEqual(original.getText(), 'a\n');
  });

  it('commits only ticked files and keeps changelist assignments', async () => {
    const cw = api.commitWindow;
    const feature = cw.createChangelist('Feature');
    cw.moveToChangelist(['b.txt'], feature.id);
    cw.setIncluded(['b.txt'], false);
    cw.setIncluded(['c.txt'], true);

    assert.strictEqual(await api.commit('Commit a and c', false, false), true);

    assert.deepStrictEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['a.txt', 'c.txt']);
    await waitFor(() => cw.changes.length === 1, 'status to refresh');
    assert.strictEqual(cw.changes[0].path, 'b.txt');
    assert.strictEqual(cw.listOf('b.txt'), feature.id);
    assert.strictEqual(cw.isIncluded('b.txt'), false);
  });

  it('refuses to commit with nothing ticked', async () => {
    assert.strictEqual(await api.commit('Nothing', false, false), false);
    assert.strictEqual(git('rev-list', '--count', 'HEAD').trim(), '2');
  });

  it('amends the last commit message', async () => {
    assert.strictEqual(await api.commit('Reworded', true, false), true);
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'Reworded');
    assert.strictEqual(git('rev-list', '--count', 'HEAD').trim(), '2');
  });
});
