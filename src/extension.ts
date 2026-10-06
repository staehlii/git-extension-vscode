import * as vscode from 'vscode';
import { BranchesPopup } from './branches/branchesPopup';
import * as ops from './branches/branchService';
import { Favorites } from './branches/favorites';
import { showOperationActions } from './branches/operationActions';
import { BranchStatusBar } from './branches/statusBar';
import { CommitFn, registerCommitWindow } from './commit/commitCommands';
import { CommitWindow } from './commit/commitWindow';
import { registerConflictCommands } from './conflicts/conflictCommands';
import { commitItem } from './git/commitPicker';
import type { GitExtension } from './git/gitApi';
import { GitCli } from './git/gitCli';
import { Repo } from './git/repo';
import { RepoManager } from './git/repoManager';
import { listCommits } from './git/history';
import { RevisionContentProvider, SCHEME } from './git/revisionContent';
import { LogView, registerLogView } from './log/logView';
import { onDidRebaseEditorLoad, openInteractiveRebase } from './rebase/rebaseEditor';
import { gitConsole, showGitError } from './util/ui';

/** Returned from activate(); used by the end-to-end tests. */
export interface ExtensionApi {
  commitWindow: CommitWindow;
  commit: CommitFn;
  log: LogView;
  onDidRebaseEditorLoad: vscode.Event<string>;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi | undefined> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) {
    vscode.window.showErrorMessage('Git (JB): the built-in Git extension is not available.');
    return undefined;
  }
  const api = (gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()).getAPI(1);
  const cli = new GitCli(api.git.path, (line) => gitConsole().appendLine(line));
  const repos = new RepoManager(api, cli);
  const popup = new BranchesPopup(new Favorites(context.globalState));

  /** Wraps a command so it runs against the picked repo and reports unexpected errors. */
  const withRepo = (title: string, fn: (repo: Repo) => Promise<unknown>) => async () => {
    const repo = await repos.pick();
    if (!repo) {
      return;
    }
    try {
      await fn(repo);
    } catch (e) {
      await showGitError(title, e);
    }
  };

  context.subscriptions.push(
    repos,
    new BranchStatusBar(repos),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(cli)),
    vscode.commands.registerCommand('jbgit.showBranches', withRepo('Branches', (r) => popup.show(r))),
    vscode.commands.registerCommand('jbgit.updateProject', withRepo('Update Project', ops.updateProject)),
    vscode.commands.registerCommand('jbgit.push', withRepo('Push', (r) => ops.push(r))),
    vscode.commands.registerCommand('jbgit.newBranch', withRepo('New Branch', (r) => ops.newBranch(r))),
    vscode.commands.registerCommand('jbgit.checkoutRevision', withRepo('Checkout', ops.checkoutRevision)),
    vscode.commands.registerCommand('jbgit.fetch', withRepo('Fetch', ops.fetchAll)),
    vscode.commands.registerCommand('jbgit.operationActions', withRepo('Continue/Abort', showOperationActions)),
    vscode.commands.registerCommand('jbgit.showConsole', () => gitConsole().show()),
  );

  const commitWindow = new CommitWindow(repos, context.workspaceState);
  context.subscriptions.push(commitWindow);
  const commit = registerCommitWindow(context, commitWindow);
  const log = registerLogView(context, repos);
  registerConflictCommands(context, repos, commitWindow);
  context.subscriptions.push(
    vscode.commands.registerCommand('jbgit.interactiveRebase', withRepo('Interactive Rebase', async (repo) => {
      const commits = await listCommits(repo, ['HEAD'], 100);
      const pick = await vscode.window.showQuickPick(commits.map(commitItem), {
        title: 'Interactive Rebase: pick the oldest commit to change',
        matchOnDescription: true,
      });
      if (pick) {
        await openInteractiveRebase(context.extensionUri, repo, pick.commit.sha);
      }
    })),
  );
  return { commitWindow, commit, log, onDidRebaseEditorLoad };
}

export function deactivate(): void {}
