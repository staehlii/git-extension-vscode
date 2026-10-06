import * as path from 'path';
import * as vscode from 'vscode';
import { ChangesNode } from '../commit/changesTree';
import { CommitWindow } from '../commit/commitWindow';
import { FileChange, parseStatusV2 } from '../commit/statusParser';
import { OPERATION_NOUN, Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { confirm, runWithProgress, showGitError } from '../util/ui';
import { acceptSide, hasConflictMarkers, markResolved, Side, sideLabels } from './conflictService';

const CONFLICT_KIND: Record<string, string> = {
  UU: 'both modified',
  AA: 'both added',
  DD: 'both deleted',
  AU: 'added by us',
  UA: 'added by them',
  DU: 'deleted by us',
  UD: 'deleted by them',
};

async function conflictsOf(repo: Repo): Promise<FileChange[]> {
  const changes = parseStatusV2(await repo.out(['status', '--porcelain=v2', '-z', '--untracked-files=no']));
  return changes.filter((c) => c.kind === 'conflict');
}

/** Opens VS Code's 3-way merge editor through the built-in Git extension (its "Complete Merge" stages the file). */
export async function openMergeEditor(repo: Repo, file: string): Promise<void> {
  await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(path.join(repo.root, file)));
}

const MERGE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-merge'), tooltip: 'Merge…' };
const YOURS_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-left'), tooltip: 'Accept Yours' };
const THEIRS_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-right'), tooltip: 'Accept Theirs' };

type ConflictItem = vscode.QuickPickItem & { file?: string; all?: Side };

/**
 * JetBrains "Conflicts" dialog: every conflicted file with Accept Yours / Accept Theirs / Merge…;
 * stays open until all conflicts are resolved, then offers to continue the operation.
 */
export async function showConflictsDialog(repo: Repo): Promise<void> {
  const labels = await sideLabels(repo);
  const qp = vscode.window.createQuickPick<ConflictItem>();
  qp.title = `Conflicts · Yours: ${labels.ours} · Theirs: ${labels.theirs}`;
  qp.placeholder = 'Enter on a file opens the merge editor; use the row buttons to accept one side';
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;

  const load = async (): Promise<boolean> => {
    const conflicts = await conflictsOf(repo);
    if (conflicts.length === 0) {
      return false;
    }
    qp.items = [
      { label: '$(arrow-left) Accept Yours for All', all: 'ours' },
      { label: '$(arrow-right) Accept Theirs for All', all: 'theirs' },
      { label: 'Files', kind: vscode.QuickPickItemKind.Separator },
      ...conflicts.map((c) => ({
        label: path.posix.basename(c.path),
        description: [path.posix.dirname(c.path) === '.' ? '' : path.posix.dirname(c.path), CONFLICT_KIND[c.xy] ?? c.xy]
          .filter(Boolean)
          .join(' · '),
        file: c.path,
        buttons: [MERGE_BUTTON, YOURS_BUTTON, THEIRS_BUTTON],
      })),
    ];
    return true;
  };

  const accept = async (files: string[], side: Side) => {
    qp.busy = true;
    try {
      await acceptSide(repo, files, side);
    } catch (e) {
      await showGitError(side === 'ours' ? 'Accept Yours' : 'Accept Theirs', e);
    }
    qp.busy = false;
    if (!(await load())) {
      qp.hide();
      await allResolved(repo);
    }
  };

  if (!(await load())) {
    vscode.window.showInformationMessage('There are no merge conflicts.');
    return;
  }
  qp.onDidTriggerItemButton(async (e) => {
    const file = e.item.file!;
    if (e.button === MERGE_BUTTON) {
      qp.hide();
      await openMergeEditor(repo, file);
    } else {
      await accept([file], e.button === YOURS_BUTTON ? 'ours' : 'theirs');
    }
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (item?.all) {
      const files = (await conflictsOf(repo)).map((c) => c.path);
      const side = item.all === 'ours' ? labels.ours : labels.theirs;
      if (await confirm(`Resolve all ${files.length} conflicts with "${side}"?`, 'Accept')) {
        await accept(files, item.all);
      }
    } else if (item?.file) {
      qp.hide();
      await openMergeEditor(repo, item.file);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** Offers to continue the stopped operation. Not awaited by callers' commands: it waits for the user. */
async function allResolved(repo: Repo): Promise<void> {
  const state = await repo.operationState();
  if (state === 'none') {
    vscode.window.showInformationMessage('All conflicts are resolved.');
    return;
  }
  void vscode.window
    .showInformationMessage(`All conflicts are resolved. Continue the ${OPERATION_NOUN[state]}?`, 'Continue…')
    .then((choice) => choice && vscode.commands.executeCommand('jbgit.operationActions'));
}

/** Commands on conflicted files in the Changes tree, the Conflicts dialog, and "mark resolved on save". */
export function registerConflictCommands(context: vscode.ExtensionContext, repos: RepoManager, cw: CommitWindow): void {
  const conflictFiles = (node?: ChangesNode, nodes?: readonly ChangesNode[]): string[] => {
    const source = nodes?.length ? nodes : node ? [node] : [];
    const files = source.flatMap((n) => (n.type === 'file' ? [n.change] : n.type === 'conflicts' ? cw.conflicts : []));
    return [...new Set(files.filter((f) => f.kind === 'conflict').map((f) => f.path))];
  };

  const onFiles = (title: string, fn: (repo: Repo, files: string[]) => Promise<unknown>) =>
    async (node?: ChangesNode, nodes?: ChangesNode[]) => {
      const repo = cw.repo;
      const files = conflictFiles(node, nodes);
      if (!repo || files.length === 0) {
        return;
      }
      try {
        await fn(repo, files);
        await cw.refresh();
        if (cw.conflicts.length === 0) {
          await allResolved(repo);
        }
      } catch (e) {
        await showGitError(title, e);
      }
    };

  const offered = new Set<string>();

  context.subscriptions.push(
    vscode.commands.registerCommand('jbgit.resolveConflicts', async () => {
      const repo = await repos.pick();
      if (repo) {
        await showConflictsDialog(repo);
      }
    }),
    vscode.commands.registerCommand('jbgit.conflicts.merge', onFiles('Merge', (repo, files) => openMergeEditor(repo, files[0]))),
    vscode.commands.registerCommand('jbgit.conflicts.acceptYours', onFiles('Accept Yours', (repo, files) =>
      runWithProgress('Accept Yours', () => acceptSide(repo, files, 'ours')),
    )),
    vscode.commands.registerCommand('jbgit.conflicts.acceptTheirs', onFiles('Accept Theirs', (repo, files) =>
      runWithProgress('Accept Theirs', () => acceptSide(repo, files, 'theirs')),
    )),
    vscode.commands.registerCommand('jbgit.conflicts.markResolved', onFiles('Mark as Resolved', async (repo, files) => {
      const withMarkers: string[] = [];
      for (const f of files) {
        if (await hasConflictMarkers(path.join(repo.root, f))) {
          withMarkers.push(f);
        }
      }
      if (
        withMarkers.length &&
        !(await confirm('Some files still contain conflict markers.', 'Mark as Resolved', withMarkers.join('\n')))
      ) {
        return;
      }
      await markResolved(repo, files);
    })),

    // When a conflicted file is saved without markers, offer to mark it resolved (JetBrains does this automatically).
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const repo = cw.repo;
      if (!repo || doc.uri.scheme !== 'file') {
        return;
      }
      const rel = path.relative(repo.root, doc.uri.fsPath).split(path.sep).join('/');
      if (!cw.conflicts.some((c) => c.path === rel) || offered.has(rel) || (await hasConflictMarkers(doc.uri.fsPath))) {
        return;
      }
      offered.add(rel);
      void vscode.window.showInformationMessage(`No conflict markers left in ${rel}.`, 'Mark as Resolved').then(async (choice) => {
        offered.delete(rel);
        if (choice) {
          await markResolved(repo, [rel]);
          await cw.refresh();
          if (cw.conflicts.length === 0) {
            await allResolved(repo);
          }
        }
      });
    }),
  );
}
