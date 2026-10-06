import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile } from './changedFiles';
import { CommitSummary, filesBetween, parentOf } from './history';
import { Repo } from './repo';
import { revisionUri } from './revisionContent';

export function commitItem(c: CommitSummary): vscode.QuickPickItem & { commit: CommitSummary } {
  return { label: c.subject, description: `${c.short} · ${c.author} · ${c.relDate}`, commit: c };
}

export function openFileDiff(repo: Repo, file: ChangedFile, left: string, right: string | 'working-tree', title: string): Thenable<unknown> {
  const leftUri = revisionUri(repo.root, path.join(repo.root, file.oldPath), left);
  const abs = path.join(repo.root, file.path);
  const rightUri = right === 'working-tree' ? vscode.Uri.file(abs) : revisionUri(repo.root, abs, right);
  return vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(file.path)} (${title})`);
}

/** Lets the user pick from `files` repeatedly and opens a diff for each pick. */
export async function pickAndDiffFiles(
  repo: Repo,
  files: ChangedFile[],
  left: string,
  right: string | 'working-tree',
  title: string,
): Promise<void> {
  if (files.length === 0) {
    vscode.window.showInformationMessage(`No differences (${title}).`);
    return;
  }
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { file: ChangedFile }>();
  qp.title = title;
  qp.placeholder = 'Select a file to show its diff (Esc to close)';
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;
  qp.items = files.map((f) => ({
    label: `${f.status}  ${path.basename(f.path)}`,
    description: f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : path.dirname(f.path),
    file: f,
  }));
  qp.onDidAccept(() => {
    const sel = qp.selectedItems[0];
    if (sel) {
      openFileDiff(repo, sel.file, left, right, title);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** Shows the files changed by one commit and diffs them against its first parent. */
export async function showCommitChanges(repo: Repo, commit: CommitSummary): Promise<void> {
  const parent = await parentOf(repo, commit.sha);
  const files = await filesBetween(repo, parent, commit.sha);
  await pickAndDiffFiles(repo, files, parent, commit.sha, `${commit.short} ${commit.subject}`);
}
