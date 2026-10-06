import * as vscode from 'vscode';
import { OperationState, Repo } from '../git/repo';
import { runWithProgress } from '../util/ui';

const NO_EDITOR = { GIT_EDITOR: 'true' };

const COMMANDS: Record<Exclude<OperationState, 'none'>, { name: string; cmd: string; canSkip: boolean }> = {
  merging: { name: 'Merge', cmd: 'merge', canSkip: false },
  rebasing: { name: 'Rebase', cmd: 'rebase', canSkip: true },
  'cherry-picking': { name: 'Cherry-pick', cmd: 'cherry-pick', canSkip: true },
  reverting: { name: 'Revert', cmd: 'revert', canSkip: true },
};

export async function unmergedFiles(repo: Repo): Promise<string[]> {
  return (await repo.out(['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
}

/** Continue / Skip / Abort for a merge, rebase, cherry-pick or revert that stopped. */
export async function showOperationActions(repo: Repo): Promise<void> {
  const state = await repo.operationState();
  if (state === 'none') {
    vscode.window.showInformationMessage('No merge, rebase, cherry-pick or revert is in progress.');
    return;
  }
  const op = COMMANDS[state];
  const unmerged = await unmergedFiles(repo);
  const items: (vscode.QuickPickItem & { id: string })[] = [];
  if (unmerged.length) {
    items.push({ id: 'resolve', label: '$(warning) Resolve Conflicts…', description: `${unmerged.length} unresolved file(s)` });
  }
  items.push({ id: 'continue', label: `$(debug-continue) Continue ${op.name}` });
  if (op.canSkip) {
    items.push({ id: 'skip', label: `$(debug-step-over) Skip Commit` });
  }
  items.push({ id: 'abort', label: `$(close) Abort ${op.name}` });

  const pick = await vscode.window.showQuickPick(items, { title: `${op.name} in progress` });
  switch (pick?.id) {
    case 'resolve':
      await vscode.commands.executeCommand('jbgit.resolveConflicts');
      break;
    case 'continue':
      if (unmerged.length) {
        vscode.window.showWarningMessage(`Resolve and stage these files first: ${unmerged.join(', ')}`);
        return;
      }
      await runWithProgress(`Continue ${op.name}`, () =>
        state === 'merging'
          ? repo.exec(['commit', '--no-edit'])
          : repo.exec([op.cmd, '--continue'], { env: NO_EDITOR }),
      );
      break;
    case 'skip':
      await runWithProgress(`Skip commit`, () => repo.exec([op.cmd, '--skip'], { env: NO_EDITOR }));
      break;
    case 'abort':
      await runWithProgress(`Abort ${op.name}`, () => repo.exec([op.cmd, '--abort']));
      break;
  }
}
