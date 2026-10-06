import * as vscode from 'vscode';
import { OperationState, Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';

const STATE_LABEL: Record<Exclude<OperationState, 'none'>, string> = {
  merging: 'Merging',
  rebasing: 'Rebasing',
  'cherry-picking': 'Cherry-picking',
  reverting: 'Reverting',
};

/** Current branch (or merge/rebase state) in the status bar; click opens the Branches popup. */
export class BranchStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('jbgit.branch', vscode.StatusBarAlignment.Left, 1000);
  private readonly subscription: vscode.Disposable;

  constructor(private readonly repos: RepoManager) {
    this.item.name = 'Git (JB) Branch';
    this.subscription = repos.onDidChange(() => this.refresh());
    this.refresh();
  }

  async refresh(): Promise<void> {
    const repo = this.repos.current;
    if (!repo) {
      this.item.hide();
      return;
    }
    try {
      await this.render(repo);
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  private async render(repo: Repo): Promise<void> {
    const [branch, state] = await Promise.all([repo.currentBranch(), repo.operationState()]);
    const head = branch ?? (await repo.headShort());
    const multi = this.repos.all.length > 1 ? `${repo.name}: ` : '';
    if (state !== 'none') {
      this.item.text = `$(git-merge) ${STATE_LABEL[state]} ${multi}${head}`;
      this.item.tooltip = `${STATE_LABEL[state]} in progress. Click to continue or abort.`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.command = 'jbgit.operationActions';
    } else {
      this.item.text = `${branch ? '$(git-branch)' : '$(git-commit)'} ${multi}${head}`;
      this.item.tooltip = branch ? `Git branch: ${branch}. Click for Branches popup.` : 'Detached HEAD. Click for Branches popup.';
      this.item.backgroundColor = undefined;
      this.item.command = 'jbgit.showBranches';
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
