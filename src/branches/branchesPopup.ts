import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { BranchInfo } from './branchModel';
import * as ops from './branchService';
import { Favorites } from './favorites';

type ActionItem = vscode.QuickPickItem & { run: () => Promise<unknown> | Thenable<unknown> };
type BranchItem = vscode.QuickPickItem & { branch: BranchInfo };
type PopupItem = ActionItem | BranchItem | vscode.QuickPickItem;

const STAR_ON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-full'), tooltip: 'Remove from Favorites' };
const STAR_OFF: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-empty'), tooltip: 'Add to Favorites' };

function separator(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function trackingText(b: BranchInfo): string {
  const parts: string[] = [];
  if (b.ahead) {
    parts.push(`↑${b.ahead}`);
  }
  if (b.behind) {
    parts.push(`↓${b.behind}`);
  }
  if (b.upstream) {
    parts.push(b.upstreamGone ? `${b.upstream} (gone)` : `→ ${b.upstream}`);
  }
  return parts.join('  ');
}

export class BranchesPopup {
  constructor(private readonly favorites: Favorites) {}

  async show(repo: Repo): Promise<void> {
    // Loop so "Back" in the branch submenu returns here.
    for (;;) {
      const picked = await this.pickBranchOrAction(repo);
      if (!picked) {
        return;
      }
      if ('run' in picked) {
        await picked.run();
        return;
      }
      const result = await this.showBranchActions(repo, picked.branch, picked.all);
      if (result !== 'back') {
        return;
      }
    }
  }

  private async pickBranchOrAction(
    repo: Repo,
  ): Promise<ActionItem | { branch: BranchInfo; all: BranchInfo[] } | undefined> {
    const qp = vscode.window.createQuickPick<PopupItem>();
    qp.title = `Branches: ${repo.name}`;
    qp.placeholder = 'Search branches and actions';
    qp.matchOnDescription = true;
    qp.busy = true;
    qp.show();

    let all: BranchInfo[] = [];
    let recent: string[] = [];
    const render = () => {
      const favs = this.favorites.get(repo.root);
      const current = all.find((b) => b.isCurrent);
      const sort = (a: BranchInfo, b: BranchInfo) =>
        Number(favs.has(b.fullRef)) - Number(favs.has(a.fullRef)) || a.name.localeCompare(b.name);
      const item = (b: BranchInfo): BranchItem => ({
        label: b.name,
        description: trackingText(b),
        iconPath: new vscode.ThemeIcon(b.isCurrent ? 'check' : b.kind === 'remote' ? 'cloud' : 'git-branch'),
        buttons: [favs.has(b.fullRef) ? STAR_ON : STAR_OFF],
        branch: b,
      });
      const limit = vscode.workspace.getConfiguration('jbGit').get<number>('recentBranchesLimit', 5);
      const locals = all.filter((b) => b.kind === 'local');
      const recentBranches = recent
        .filter((n) => n !== current?.name)
        .map((n) => locals.find((b) => b.name === n))
        .filter((b): b is BranchInfo => !!b)
        .slice(0, limit);

      const actions: ActionItem[] = [
        { label: '$(arrow-down) Update Project…', run: () => ops.updateProject(repo) },
        { label: '$(arrow-up) Push…', run: () => ops.push(repo) },
        { label: '$(add) New Branch…', run: () => ops.newBranch(repo) },
        { label: '$(tag) Checkout Tag or Revision…', run: () => ops.checkoutRevision(repo) },
      ];
      const items: PopupItem[] = [...actions];
      if (recentBranches.length) {
        items.push(separator('Recent'), ...recentBranches.map(item));
      }
      items.push(separator('Local'), ...locals.sort(sort).map(item));
      const remotes = all.filter((b) => b.kind === 'remote');
      if (remotes.length) {
        items.push(separator('Remote'), ...remotes.sort(sort).map(item));
      }
      qp.items = items;
    };

    try {
      [all, recent] = await Promise.all([ops.listBranches(repo), ops.recentBranchNames(repo)]);
    } catch (e) {
      qp.dispose();
      throw e;
    }
    render();
    qp.busy = false;

    return new Promise((resolve) => {
      qp.onDidTriggerItemButton(async (e) => {
        const b = (e.item as BranchItem).branch;
        await this.favorites.toggle(repo.root, b.fullRef);
        render();
      });
      qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        resolve(sel && ('run' in sel ? sel : 'branch' in sel ? { branch: sel.branch, all } : undefined));
        qp.hide();
      });
      qp.onDidHide(() => {
        resolve(undefined);
        qp.dispose();
      });
    });
  }

  private async showBranchActions(repo: Repo, b: BranchInfo, all: BranchInfo[]): Promise<'back' | 'done'> {
    const current = all.find((x) => x.isCurrent)?.name;
    const cur = current ? `'${current}'` : 'HEAD';
    const actions: ActionItem[] = [];

    if (!b.isCurrent) {
      actions.push({ label: '$(git-branch) Checkout', run: () => ops.checkout(repo, b, all) });
    }
    actions.push({ label: `$(add) New Branch from '${b.name}'…`, run: () => ops.newBranch(repo, b.name) });
    if (!b.isCurrent && current) {
      if (b.kind === 'local') {
        actions.push({ label: `Checkout and Rebase onto ${cur}`, run: () => ops.checkoutAndRebaseOnto(repo, b, current) });
      }
      actions.push(
        { label: `$(git-compare) Compare with ${cur}`, run: () => ops.compareWithCurrent(repo, b, current) },
        { label: '$(diff) Show Diff with Working Tree', run: () => ops.diffWithWorkingTree(repo, b) },
        { label: `Rebase ${cur} onto '${b.name}'`, run: () => ops.rebaseCurrentOnto(repo, b, current) },
        { label: `$(git-merge) Merge '${b.name}' into ${cur}`, run: () => ops.merge(repo, b, current) },
      );
    }
    if (b.kind === 'local') {
      if (b.upstream) {
        actions.push({ label: '$(arrow-down) Update', run: () => ops.updateBranch(repo, b) });
      }
      actions.push(
        { label: '$(arrow-up) Push…', run: () => ops.push(repo, b) },
        { label: '$(edit) Rename…', run: () => ops.renameBranch(repo, b) },
      );
    }
    if (!b.isCurrent) {
      actions.push({ label: '$(trash) Delete', run: () => ops.deleteBranch(repo, b) });
    }

    const qp = vscode.window.createQuickPick<ActionItem>();
    qp.title = `${b.kind === 'remote' ? 'Remote branch' : 'Branch'} '${b.name}'`;
    qp.items = actions;
    qp.buttons = [vscode.QuickInputButtons.Back];
    qp.show();
    const result = await new Promise<ActionItem | 'back' | undefined>((resolve) => {
      qp.onDidTriggerButton(() => resolve('back'));
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidHide(() => resolve(undefined));
    });
    qp.dispose();
    if (result === 'back') {
      return 'back';
    }
    if (result) {
      await result.run();
    }
    return 'done';
  }
}
