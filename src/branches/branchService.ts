import * as vscode from 'vscode';
import { commitItem, pickAndDiffFiles, showCommitChanges } from '../git/commitPicker';
import { filesBetween, listCommits } from '../git/history';
import { GitError } from '../git/gitCli';
import { Repo } from '../git/repo';
import { confirm, runWithProgress, showGitError } from '../util/ui';
import { BranchInfo, FOR_EACH_REF_FORMAT, localNameForRemote, parseBranches, parseRecentCheckouts } from './branchModel';

export async function listRemotes(repo: Repo): Promise<string[]> {
  return (await repo.out(['remote'])).split('\n').filter(Boolean);
}

export async function listBranches(repo: Repo): Promise<BranchInfo[]> {
  const [remotes, refs] = await Promise.all([
    listRemotes(repo),
    repo.out(['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes']),
  ]);
  return parseBranches(refs, remotes);
}

export async function recentBranchNames(repo: Repo): Promise<string[]> {
  const res = await repo.exec(['reflog', '--format=%gs', '-n', '500'], { allowFailure: true });
  return res.exitCode === 0 ? parseRecentCheckouts(res.stdout) : [];
}

/** If an operation stopped with conflicts, tell the user instead of showing a raw error. Returns true if handled. */
export async function reportStoppedOperation(repo: Repo, title: string): Promise<boolean> {
  const state = await repo.operationState();
  if (state === 'none') {
    return false;
  }
  // Not awaited: the command finishes while the notification waits for the user.
  void vscode.window
    .showWarningMessage(`${title}: stopped (${state}). Resolve the conflicts, then continue or abort.`, 'Resolve Conflicts', 'Continue / Abort…')
    .then((choice) => {
      if (choice === 'Resolve Conflicts') {
        return vscode.commands.executeCommand('jbgit.resolveConflicts');
      }
      if (choice === 'Continue / Abort…') {
        return vscode.commands.executeCommand('jbgit.operationActions');
      }
      return undefined;
    });
  return true;
}

/** Runs a git operation that may stop with conflicts (merge, rebase, pull, cherry-pick). */
export async function runConflictAware(repo: Repo, title: string, args: string[]): Promise<boolean> {
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => repo.exec(args));
    return true;
  } catch (e) {
    if (!(await reportStoppedOperation(repo, title))) {
      await showGitError(title, e);
    }
    return false;
  }
}

function isOverwriteError(e: unknown): boolean {
  return e instanceof GitError && /would be overwritten by checkout/.test(e.result.stderr);
}

/** Checkout with JetBrains-style "Smart Checkout" (stash, checkout, unstash) when local changes block it. */
export async function checkoutRef(repo: Repo, args: string[], label: string): Promise<boolean> {
  const title = `Checkout ${label}`;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => repo.exec(args));
    return true;
  } catch (e) {
    if (!isOverwriteError(e)) {
      await showGitError(title, e);
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `Your local changes would be overwritten by checking out ${label}.`,
      { modal: true, detail: (e as GitError).result.stderr.trim() },
      'Smart Checkout',
      'Force Checkout',
    );
    if (choice === 'Smart Checkout') {
      const done = await runWithProgress(`Smart checkout ${label}`, async () => {
        await repo.exec(['stash', 'push', '--include-untracked', '-m', `jbgit smart checkout of ${label}`]);
        await repo.exec(args);
        return true;
      });
      if (!done) {
        return false;
      }
      const pop = await repo.exec(['stash', 'pop'], { allowFailure: true });
      if (pop.exitCode !== 0) {
        vscode.window.showWarningMessage(
          `Checked out ${label}, but re-applying your changes produced conflicts. They are still kept in the stash.`,
        );
      }
      return true;
    }
    if (choice === 'Force Checkout') {
      return (await runWithProgress(title, () => repo.exec([...args.slice(0, 1), '--force', ...args.slice(1)]))) !== undefined;
    }
    return false;
  }
}

export async function checkout(repo: Repo, branch: BranchInfo, all: BranchInfo[]): Promise<void> {
  if (branch.kind === 'local') {
    await checkoutRef(repo, ['checkout', branch.name], branch.name);
    return;
  }
  const local = localNameForRemote(branch);
  const existing = all.find((b) => b.kind === 'local' && b.name === local);
  if (!existing) {
    await checkoutRef(repo, ['checkout', '-b', local, '--track', branch.name], branch.name);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Local branch '${local}' already exists.`,
    { modal: true },
    `Checkout '${local}'`,
    `Reset '${local}' to '${branch.name}'`,
  );
  if (choice === `Checkout '${local}'`) {
    await checkoutRef(repo, ['checkout', local], local);
  } else if (choice?.startsWith('Reset')) {
    await checkoutRef(repo, ['checkout', '-B', local, '--track', branch.name], branch.name);
  }
}

export async function checkoutRevision(repo: Repo): Promise<void> {
  const tags = (await repo.out(['tag', '--sort=-creatordate'])).split('\n').filter(Boolean);
  const qp = vscode.window.createQuickPick();
  qp.title = 'Checkout Tag or Revision';
  qp.placeholder = 'Type a tag, branch, or commit hash';
  qp.items = tags.map((t) => ({ label: t, iconPath: new vscode.ThemeIcon('tag') }));
  const ref = await new Promise<string | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]?.label ?? (qp.value.trim() || undefined)));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (ref) {
    await checkoutRef(repo, ['checkout', ref], ref);
  }
}

export async function newBranch(repo: Repo, startPoint?: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: startPoint ? `New Branch from '${startPoint}'` : 'New Branch',
    prompt: 'Branch name',
    validateInput: async (value) => {
      if (!value.trim()) {
        return 'Enter a branch name';
      }
      const res = await repo.exec(['check-ref-format', '--branch', value.trim()], { allowFailure: true });
      return res.exitCode === 0 ? undefined : 'Not a valid branch name';
    },
  });
  if (!name) {
    return;
  }
  const args = ['checkout', '-b', name.trim()];
  if (startPoint) {
    args.push(startPoint);
  }
  await checkoutRef(repo, args, name.trim());
}

export async function merge(repo: Repo, branch: BranchInfo, current: string): Promise<void> {
  await runConflictAware(repo, `Merge '${branch.name}' into '${current}'`, ['merge', '--autostash', branch.name]);
}

export async function rebaseCurrentOnto(repo: Repo, onto: BranchInfo, current: string): Promise<void> {
  await runConflictAware(repo, `Rebase '${current}' onto '${onto.name}'`, ['rebase', '--autostash', onto.name]);
}

export async function checkoutAndRebaseOnto(repo: Repo, branch: BranchInfo, onto: string): Promise<void> {
  await runConflictAware(repo, `Checkout '${branch.name}' and rebase onto '${onto}'`, [
    'rebase',
    '--autostash',
    onto,
    branch.name,
  ]);
}

/** Commits in either direction between `branch` and the current branch, JetBrains "Compare with Current". */
export async function compareWithCurrent(repo: Repo, branch: BranchInfo, current: string): Promise<void> {
  const [onlyOther, onlyCurrent] = await Promise.all([
    listCommits(repo, [`${current}..${branch.name}`]),
    listCommits(repo, [`${branch.name}..${current}`]),
  ]);
  const items: vscode.QuickPickItem[] = [
    { label: `In '${branch.name}' but not in '${current}' (${onlyOther.length})`, kind: vscode.QuickPickItemKind.Separator },
    ...onlyOther.map(commitItem),
    { label: `In '${current}' but not in '${branch.name}' (${onlyCurrent.length})`, kind: vscode.QuickPickItemKind.Separator },
    ...onlyCurrent.map(commitItem),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Compare '${branch.name}' with '${current}'`,
    placeHolder: 'Select a commit to see its changes',
    matchOnDescription: true,
  });
  if (pick && 'commit' in pick) {
    await showCommitChanges(repo, (pick as ReturnType<typeof commitItem>).commit);
  }
}

export async function diffWithWorkingTree(repo: Repo, branch: BranchInfo): Promise<void> {
  const files = await filesBetween(repo, branch.name);
  await pickAndDiffFiles(repo, files, branch.name, 'working-tree', `${branch.name} ↔ Working Tree`);
}

export async function renameBranch(repo: Repo, branch: BranchInfo): Promise<void> {
  const name = await vscode.window.showInputBox({ title: `Rename '${branch.name}'`, value: branch.name });
  if (name && name !== branch.name) {
    await runWithProgress(`Rename '${branch.name}'`, () => repo.exec(['branch', '-m', branch.name, name]));
  }
}

export async function deleteBranch(repo: Repo, branch: BranchInfo): Promise<void> {
  if (branch.kind === 'remote') {
    if (await confirm(`Delete remote branch '${branch.name}'?`, 'Delete', 'This pushes the deletion to the remote.')) {
      await runWithProgress(`Delete '${branch.name}'`, () =>
        repo.exec(['push', branch.remote!, '--delete', branch.remoteBranch!]),
      );
    }
    return;
  }
  const res = await repo.exec(['branch', '-d', branch.name], { allowFailure: true });
  if (res.exitCode === 0) {
    vscode.window.showInformationMessage(`Deleted branch '${branch.name}'.`);
    return;
  }
  if (/not fully merged/.test(res.stderr)) {
    if (await confirm(`Branch '${branch.name}' is not fully merged.`, 'Delete Anyway', 'Its unmerged commits may be lost.')) {
      await runWithProgress(`Delete '${branch.name}'`, () => repo.exec(['branch', '-D', branch.name]));
    }
    return;
  }
  await showGitError(`Delete '${branch.name}'`, new GitError(['branch', '-d'], res));
}

/** Fast-forwards a non-current local branch from its upstream, or updates the current branch. */
export async function updateBranch(repo: Repo, branch: BranchInfo): Promise<void> {
  if (!branch.upstream) {
    vscode.window.showWarningMessage(`'${branch.name}' has no upstream branch.`);
    return;
  }
  if (branch.isCurrent) {
    await updateProject(repo);
    return;
  }
  await runWithProgress(`Update '${branch.name}'`, async () => {
    const remote = branch.upstream!.split('/')[0];
    await repo.exec(['fetch', remote]);
    await repo.exec(['fetch', '.', `refs/remotes/${branch.upstream}:refs/heads/${branch.name}`]);
  });
}

export async function fetchAll(repo: Repo): Promise<void> {
  await runWithProgress('Fetch', () => repo.exec(['fetch', '--all', '--prune']));
}

/** JetBrains "Update Project": fetch, integrate upstream into the current branch, fast-forward other tracked branches. */
export async function updateProject(repo: Repo): Promise<void> {
  const method = vscode.workspace.getConfiguration('jbGit').get<'merge' | 'rebase'>('updateMethod', 'merge');
  const fetched = await runWithProgress('Update Project: fetching', () => repo.exec(['fetch', '--all', '--prune']));
  if (!fetched) {
    return;
  }
  const branches = await listBranches(repo);
  const current = branches.find((b) => b.isCurrent);
  const updated: string[] = [];

  for (const b of branches) {
    if (b.kind === 'local' && !b.isCurrent && b.upstream && !b.upstreamGone && b.behind > 0 && b.ahead === 0) {
      const res = await repo.exec(['fetch', '.', `refs/remotes/${b.upstream}:refs/heads/${b.name}`], { allowFailure: true });
      if (res.exitCode === 0) {
        updated.push(`${b.name} (+${b.behind})`);
      }
    }
  }

  if (!current) {
    vscode.window.showWarningMessage('HEAD is detached; only other tracked branches were updated.');
    return;
  }
  if (!current.upstream || current.upstreamGone) {
    vscode.window.showInformationMessage(
      `Fetched. '${current.name}' has no upstream to update from.${updated.length ? ` Updated: ${updated.join(', ')}` : ''}`,
    );
    return;
  }
  if (current.behind > 0) {
    const args = method === 'rebase' ? ['rebase', '--autostash', '@{u}'] : ['merge', '--autostash', '@{u}'];
    const ok = await runConflictAware(repo, `Update '${current.name}' (${method})`, args);
    if (!ok) {
      return;
    }
    updated.unshift(`${current.name} (+${current.behind})`);
  }
  vscode.window.showInformationMessage(
    updated.length ? `Project updated: ${updated.join(', ')}` : 'All files are up to date.',
  );
}

/** JetBrains-style push: shows outgoing commits, then pushes (sets upstream for new branches). */
export async function push(repo: Repo, branch?: BranchInfo): Promise<void> {
  const branches = await listBranches(repo);
  const target = branch ?? branches.find((b) => b.isCurrent);
  if (!target || target.kind !== 'local') {
    vscode.window.showWarningMessage('Nothing to push: HEAD is detached.');
    return;
  }
  let remote: string;
  let remoteBranch: string;
  let setUpstream = false;
  if (target.upstream && !target.upstreamGone) {
    const up = branches.find((b) => b.kind === 'remote' && b.name === target.upstream);
    remote = up?.remote ?? target.upstream.split('/')[0];
    remoteBranch = up?.remoteBranch ?? target.upstream.split('/').slice(1).join('/');
  } else {
    const remotes = await listRemotes(repo);
    if (remotes.length === 0) {
      vscode.window.showWarningMessage('No remote is configured.');
      return;
    }
    const picked = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(remotes, { placeHolder: 'Push to remote' });
    if (!picked) {
      return;
    }
    remote = picked;
    remoteBranch = target.name;
    setUpstream = true;
  }
  const range = setUpstream ? [target.name, '--not', '--remotes'] : [`${target.upstream}..${target.name}`];
  const commits = await listCommits(repo, range, 50);
  if (commits.length === 0 && !setUpstream) {
    vscode.window.showInformationMessage(`Nothing to push: '${target.name}' is up to date with '${target.upstream}'.`);
    return;
  }
  const detail =
    commits.map((c) => `${c.short}  ${c.subject}`).join('\n') + (commits.length === 50 ? '\n…' : '') || 'No new commits';
  const destination = `${remote}/${remoteBranch}${setUpstream ? ' (new)' : ''}`;
  const choice = await vscode.window.showInformationMessage(
    `Push ${commits.length} commit(s) from '${target.name}' to '${destination}'?`,
    { modal: true, detail },
    'Push',
    'Force Push (with lease)',
  );
  if (!choice) {
    return;
  }
  const args = ['push'];
  if (setUpstream) {
    args.push('--set-upstream');
  }
  if (choice !== 'Push') {
    args.push('--force-with-lease');
  }
  args.push(remote, `refs/heads/${target.name}:refs/heads/${remoteBranch}`);
  const ok = await runWithProgress(`Push to ${destination}`, () => repo.exec(args));
  if (ok) {
    vscode.window.showInformationMessage(`Pushed ${commits.length} commit(s) to ${destination}.`);
  }
}
