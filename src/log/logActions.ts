import * as vscode from 'vscode';
import * as branchOps from '../branches/branchService';
import { commitFiles, headMessage, remoteBranchesContainingHead } from '../commit/commitService';
import { pickAndDiffFiles } from '../git/commitPicker';
import { filesBetween } from '../git/history';
import { Repo } from '../git/repo';
import { confirm, runWithProgress } from '../util/ui';
import type { LogCommit } from './protocol';

const short = (sha: string) => sha.slice(0, 8);

function rejectMerges(commits: LogCommit[], action: string): boolean {
  const merges = commits.filter((c) => c.parents.length > 1);
  if (merges.length) {
    vscode.window.showWarningMessage(`${action} of merge commits is not supported (${merges.map((c) => short(c.sha)).join(', ')}).`);
    return true;
  }
  return false;
}

export async function copyRevision(commits: LogCommit[]): Promise<void> {
  await vscode.env.clipboard.writeText(commits.map((c) => c.sha).join(' '));
  vscode.window.setStatusBarMessage(`Copied ${commits.length === 1 ? short(commits[0].sha) : `${commits.length} hashes`}`, 3000);
}

export async function checkoutRevision(repo: Repo, c: LogCommit): Promise<void> {
  await branchOps.checkoutRef(repo, ['checkout', '--detach', c.sha], short(c.sha));
}

export async function newBranch(repo: Repo, c: LogCommit): Promise<void> {
  await branchOps.newBranch(repo, c.sha);
}

export async function newTag(repo: Repo, c: LogCommit): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: `New Tag on ${short(c.sha)}`,
    prompt: 'Tag name',
    validateInput: async (v) => {
      if (!v.trim()) {
        return 'Enter a tag name';
      }
      const res = await repo.exec(['check-ref-format', `refs/tags/${v.trim()}`], { allowFailure: true });
      return res.exitCode === 0 ? undefined : 'Not a valid tag name';
    },
  });
  if (name) {
    await runWithProgress(`Create tag '${name.trim()}'`, () => repo.exec(['tag', name.trim(), c.sha]));
  }
}

/** Cherry-picks the commits in the given order (callers pass oldest first). */
export async function cherryPick(repo: Repo, commits: LogCommit[]): Promise<void> {
  if (rejectMerges(commits, 'Cherry-pick')) {
    return;
  }
  const label = commits.length === 1 ? `'${commits[0].subject}'` : `${commits.length} commits`;
  await branchOps.runConflictAware(repo, `Cherry-pick ${label}`, ['cherry-pick', ...commits.map((c) => c.sha)]);
}

/** Reverts the commits in the given order (callers pass newest first). */
export async function revert(repo: Repo, commits: LogCommit[]): Promise<void> {
  if (rejectMerges(commits, 'Revert')) {
    return;
  }
  const label = commits.length === 1 ? `'${commits[0].subject}'` : `${commits.length} commits`;
  await branchOps.runConflictAware(repo, `Revert ${label}`, ['revert', '--no-edit', ...commits.map((c) => c.sha)]);
}

export async function resetToHere(repo: Repo, c: LogCommit): Promise<void> {
  const branch = (await repo.currentBranch()) ?? 'HEAD';
  const modes = [
    { label: 'Soft', mode: '--soft', detail: 'Keep all changes; the undone commits become staged changes.' },
    { label: 'Mixed', mode: '--mixed', detail: 'Keep all changes as unstaged changes.' },
    { label: 'Hard', mode: '--hard', detail: 'Discard the undone commits AND all local changes.' },
    { label: 'Keep', mode: '--keep', detail: 'Discard the undone commits, keep local changes (fails if they conflict).' },
  ];
  const pick = await vscode.window.showQuickPick(modes, { title: `Reset '${branch}' to ${short(c.sha)} ${c.subject}` });
  if (!pick) {
    return;
  }
  if (pick.mode === '--hard' && !(await confirm(`Hard reset '${branch}' to ${short(c.sha)}?`, 'Reset', 'All local changes will be lost.'))) {
    return;
  }
  await runWithProgress(`Reset to ${short(c.sha)}`, () => repo.exec(['reset', pick.mode, c.sha]));
}

async function confirmRewriteIfPushed(repo: Repo, action: string): Promise<boolean> {
  const pushedTo = await remoteBranchesContainingHead(repo);
  return (
    pushedTo.length === 0 ||
    confirm(`The commit has already been pushed.`, action, `It is on ${pushedTo.join(', ')}. This rewrites it, so you will need to force-push.`)
  );
}

/** JetBrains "Undo Commit": drops the HEAD commit and keeps its changes in the working tree. */
export async function undoCommit(repo: Repo, c: LogCommit, head: string | undefined): Promise<void> {
  if (c.sha !== head) {
    vscode.window.showWarningMessage('Only the latest commit (HEAD) can be undone.');
    return;
  }
  if (c.parents.length !== 1) {
    vscode.window.showWarningMessage(c.parents.length ? 'Merge commits cannot be undone this way.' : 'The first commit cannot be undone.');
    return;
  }
  if (await confirmRewriteIfPushed(repo, 'Undo Anyway')) {
    await runWithProgress('Undo commit', () => repo.exec(['reset', '--soft', 'HEAD~1']));
  }
}

/** Edit the HEAD commit's message (older commits need interactive rebase). */
export async function rewordHead(repo: Repo, c: LogCommit, head: string | undefined): Promise<void> {
  if (c.sha !== head) {
    vscode.window.showWarningMessage('Only the latest commit (HEAD) can be reworded here; use interactive rebase for older ones.');
    return;
  }
  const full = await headMessage(repo);
  const [subject, ...body] = full.split('\n');
  const newSubject = await vscode.window.showInputBox({
    title: 'Edit Commit Message',
    prompt: body.join('').trim() ? 'Subject line (the message body is kept)' : 'Commit message',
    value: subject,
    validateInput: (v) => (v.trim() ? undefined : 'The message must not be empty'),
  });
  if (!newSubject || newSubject === subject || !(await confirmRewriteIfPushed(repo, 'Edit Anyway'))) {
    return;
  }
  const message = [newSubject, ...body].join('\n');
  await runWithProgress('Edit commit message', () => commitFiles(repo, { changes: [], message, amend: true, commitAll: false }));
}

export async function compareWithLocal(repo: Repo, c: LogCommit): Promise<void> {
  const files = await filesBetween(repo, c.sha);
  await pickAndDiffFiles(repo, files, c.sha, 'working-tree', `${short(c.sha)} ↔ Local`);
}

/** Saves the commits (oldest first) as one patch file. */
export async function createPatch(repo: Repo, commits: LogCommit[]): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${repo.root}/${short(commits[commits.length - 1].sha)}.patch`),
    filters: { Patch: ['patch', 'diff'] },
  });
  if (!target) {
    return;
  }
  const parts: string[] = [];
  for (const c of commits) {
    parts.push(await repo.out(['format-patch', '-1', '--stdout', c.sha]));
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(parts.join(''), 'utf8'));
  vscode.window.showInformationMessage(`Saved patch to ${target.fsPath}`);
}
