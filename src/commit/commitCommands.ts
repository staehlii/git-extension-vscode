import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as branchOps from '../branches/branchService';
import { OPERATION_NOUN } from '../git/repo';
import { EMPTY_REF, revisionUri } from '../git/revisionContent';
import { confirm, runWithProgress, showGitError } from '../util/ui';
import { ChangesNode, ChangesTreeProvider } from './changesTree';
import { CommitPanel } from './commitPanel';
import { commitFiles, remoteBranchesContainingHead, rollbackFiles } from './commitService';
import { CommitWindow } from './commitWindow';
import { MessageStore } from './messageStore';
import { FileChange } from './statusParser';

const plural = (n: number, word = 'file') => `${n} ${word}${n === 1 ? '' : 's'}`;

export type CommitFn = (message: string, amend: boolean, push: boolean) => Promise<boolean>;

/** Registers the Commit tool window (tree + message panel) and its commands. Returns the commit action. */
export function registerCommitWindow(context: vscode.ExtensionContext, cw: CommitWindow): CommitFn {
  const messages = new MessageStore(context.workspaceState);
  const tree = new ChangesTreeProvider(cw);
  const view = vscode.window.createTreeView<ChangesNode>('jbgit.changes', {
    treeDataProvider: tree,
    canSelectMany: true,
    manageCheckboxStateManually: true,
  });
  const commit: CommitFn = (message, amend, push) => runCommit(cw, messages, message, amend, push);
  const panel = new CommitPanel(cw, messages, commit);

  const updateViewInfo = () => {
    const total = cw.changes.filter((c) => c.kind !== 'conflict').length;
    view.description = cw.repo ? `${cw.includedChanges().length} of ${total} selected` : undefined;
    view.message = !cw.repo ? 'No Git repository is open.' : cw.changes.length === 0 ? 'No changes.' : undefined;
  };

  /** Files targeted by a command: the clicked/selected nodes, else the tree selection, else the ticked files. */
  const targetFiles = (node?: ChangesNode, nodes?: readonly ChangesNode[]): FileChange[] => {
    const source = nodes?.length ? nodes : node ? [node] : view.selection.length ? view.selection : undefined;
    const files = source ? source.flatMap((n) => tree.filesOf(n)) : cw.includedChanges();
    return [...new Map(files.map((f) => [f.path, f])).values()];
  };

  const listNode = (node?: ChangesNode) => (node?.type === 'list' ? node.list : undefined);

  const guarded =
    <A extends unknown[]>(title: string, fn: (...args: A) => unknown) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (e) {
        await showGitError(title, e);
      }
    };

  context.subscriptions.push(
    view,
    panel,
    cw.onDidChange(updateViewInfo),
    vscode.window.registerWebviewViewProvider(CommitPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),

    view.onDidChangeCheckboxState((e) => {
      const on: string[] = [];
      const off: string[] = [];
      for (const [node, state] of e.items) {
        const paths = tree.filesOf(node).map((f) => f.path);
        (state === vscode.TreeItemCheckboxState.Checked ? on : off).push(...paths);
      }
      if (on.length) {
        cw.setIncluded(on, true);
      }
      if (off.length) {
        cw.setIncluded(off, false);
      }
    }),

    vscode.commands.registerCommand('jbgit.commit', () => panel.focus()),
    vscode.commands.registerCommand('jbgit.commit.refresh', () => cw.refresh()),

    vscode.commands.registerCommand('jbgit.commit.openChange', guarded('Show Diff', (node?: ChangesNode) => {
      const file = node?.type === 'file' ? node.change : targetFiles()[0];
      return file && openChange(cw, file);
    })),

    vscode.commands.registerCommand('jbgit.commit.openFile', guarded('Open File', async (node?: ChangesNode, nodes?: ChangesNode[]) => {
      for (const f of targetFiles(node, nodes).filter((f) => f.kind !== 'deleted')) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(cw.repo!.root, f.path)), { preview: false });
      }
    })),

    vscode.commands.registerCommand('jbgit.commit.rollback', guarded('Rollback', async (node?: ChangesNode, nodes?: ChangesNode[]) => {
      const repo = cw.repo;
      const files = targetFiles(node, nodes).filter((f) => f.kind !== 'untracked' && f.kind !== 'conflict');
      if (!repo || files.length === 0) {
        vscode.window.showInformationMessage('Select modified files to roll back.');
        return;
      }
      const added = files.filter((f) => f.kind === 'added').length;
      const detail =
        files.slice(0, 15).map((f) => `${f.kind.padEnd(9)} ${f.path}`).join('\n') +
        (files.length > 15 ? `\n… and ${files.length - 15} more` : '') +
        (added ? `\n\n${plural(added, 'added file')} will become unversioned (kept on disk).` : '');
      if (await confirm(`Roll back ${plural(files.length)}? Local changes will be lost.`, 'Rollback', detail)) {
        await runWithProgress('Rollback', () => rollbackFiles(repo, files));
        await cw.refresh();
      }
    })),

    vscode.commands.registerCommand('jbgit.commit.newChangelist', guarded('New Changelist', async () => {
      const name = await askChangelistName(cw, 'New Changelist');
      if (name) {
        const list = cw.createChangelist(name);
        const choice = await vscode.window.showInformationMessage(`Changelist '${list.name}' created.`, 'Set Active');
        if (choice === 'Set Active') {
          cw.setActiveChangelist(list.id);
        }
      }
    })),

    vscode.commands.registerCommand('jbgit.commit.moveToChangelist', guarded('Move to Changelist', async (node?: ChangesNode, nodes?: ChangesNode[]) => {
      const files = targetFiles(node, nodes).filter((f) => f.kind !== 'untracked' && f.kind !== 'conflict');
      if (files.length === 0) {
        return;
      }
      const currentIds = new Set(files.map((f) => cw.listOf(f.path)));
      const items: (vscode.QuickPickItem & { id?: string })[] = [
        ...cw.changelists
          .filter((l) => !(currentIds.size === 1 && currentIds.has(l.id)))
          .map((l) => ({ label: l.name, id: l.id, description: l.id === cw.activeChangelist?.id ? 'active' : undefined })),
        { label: '$(add) New Changelist…' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: `Move ${plural(files.length)} to Another Changelist` });
      if (!pick) {
        return;
      }
      let id = pick.id;
      if (!id) {
        const name = await askChangelistName(cw, 'New Changelist');
        if (!name) {
          return;
        }
        id = cw.createChangelist(name).id;
      }
      cw.moveToChangelist(files.map((f) => f.path), id);
    })),

    vscode.commands.registerCommand('jbgit.commit.setActiveChangelist', guarded('Set Active Changelist', (node?: ChangesNode) => {
      const list = listNode(node);
      if (list) {
        cw.setActiveChangelist(list.id);
      }
    })),

    vscode.commands.registerCommand('jbgit.commit.renameChangelist', guarded('Rename Changelist', async (node?: ChangesNode) => {
      const list = listNode(node);
      if (!list) {
        return;
      }
      const name = await askChangelistName(cw, `Rename '${list.name}'`, list.name, list.id);
      if (name) {
        cw.renameChangelist(list.id, name);
      }
    })),

    vscode.commands.registerCommand('jbgit.commit.deleteChangelist', guarded('Delete Changelist', async (node?: ChangesNode) => {
      const list = listNode(node);
      if (!list) {
        return;
      }
      const files = cw.changesIn(list.id).length;
      const detail = files ? `Its ${plural(files)} will move to the active changelist. No file content changes.` : undefined;
      if (await confirm(`Delete changelist '${list.name}'?`, 'Delete', detail)) {
        cw.deleteChangelist(list.id);
      }
    })),

    vscode.commands.registerCommand('jbgit.commit.deleteUnversioned', guarded('Delete', async (node?: ChangesNode, nodes?: ChangesNode[]) => {
      const files = targetFiles(node, nodes).filter((f) => f.kind === 'untracked');
      if (files.length && (await confirm(`Move ${plural(files.length)} to the trash?`, 'Delete', files.map((f) => f.path).join('\n')))) {
        for (const f of files) {
          await vscode.workspace.fs.delete(vscode.Uri.file(path.join(cw.repo!.root, f.path)), { useTrash: true });
        }
        await cw.refresh();
      }
    })),

    vscode.commands.registerCommand('jbgit.commit.addToGitignore', guarded('Add to .gitignore', async (node?: ChangesNode, nodes?: ChangesNode[]) => {
      const files = targetFiles(node, nodes).filter((f) => f.kind === 'untracked');
      if (!files.length || !cw.repo) {
        return;
      }
      const file = path.join(cw.repo.root, '.gitignore');
      const existing = await fs.readFile(file, 'utf8').catch(() => '');
      const lines = files.map((f) => '/' + f.path).join('\n') + '\n';
      await fs.writeFile(file, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + lines, 'utf8');
      await cw.refresh();
    })),
  );

  updateViewInfo();
  void cw.refresh();
  return commit;
}

async function askChangelistName(cw: CommitWindow, title: string, value = '', ownId?: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title,
    value,
    prompt: 'Changelist name',
    validateInput: (v) => {
      if (!v.trim()) {
        return 'Enter a name';
      }
      const clash = cw.changelists.find((l) => l.id !== ownId && l.name.toLowerCase() === v.trim().toLowerCase());
      return clash ? `A changelist named '${clash.name}' already exists` : undefined;
    },
  });
  return name?.trim() || undefined;
}

/** Diff of a changed file against HEAD, like double-clicking a change in JetBrains. */
async function openChange(cw: CommitWindow, f: FileChange): Promise<void> {
  const root = cw.repo!.root;
  const abs = path.join(root, f.path);
  const fileUri = vscode.Uri.file(abs);
  const name = path.basename(f.path);
  const diff = (left: vscode.Uri, right: vscode.Uri, title: string) =>
    vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${title})`, { preview: true });
  switch (f.kind) {
    case 'untracked':
      await vscode.commands.executeCommand('vscode.open', fileUri);
      return;
    case 'conflict':
      await vscode.commands.executeCommand('git.openMergeEditor', fileUri);
      return;
    case 'deleted':
      await diff(revisionUri(root, abs, 'HEAD'), revisionUri(root, abs, EMPTY_REF), 'Deleted');
      return;
    case 'added':
      await diff(revisionUri(root, abs, EMPTY_REF), fileUri, 'Added');
      return;
    case 'renamed':
      await diff(revisionUri(root, path.join(root, f.origPath!), 'HEAD'), fileUri, `Renamed from ${f.origPath}`);
      return;
    case 'modified':
      await diff(revisionUri(root, abs, 'HEAD'), fileUri, 'HEAD ↔ Working Tree');
      return;
  }
}

/** JetBrains commit flow: validate, handle merge/amend specifics, commit, optionally push. */
async function runCommit(cw: CommitWindow, messages: MessageStore, message: string, amend: boolean, push: boolean): Promise<boolean> {
  const repo = cw.repo;
  if (!repo) {
    vscode.window.showWarningMessage('No Git repository is open.');
    return false;
  }
  await cw.refresh();
  if (cw.conflicts.length) {
    vscode.window.showWarningMessage(`Resolve the merge conflicts first: ${cw.conflicts.map((c) => c.path).join(', ')}`);
    return false;
  }
  if (!message.trim()) {
    vscode.window.showWarningMessage('Enter a commit message.');
    return false;
  }

  let changes = cw.includedChanges();
  let commitAll = false;
  const state = await repo.operationState();
  if (state === 'merging' || state === 'cherry-picking' || state === 'reverting') {
    const tracked = cw.changes.filter((c) => c.kind !== 'untracked' && c.kind !== 'conflict');
    const unticked = tracked.filter((c) => !cw.isIncluded(c.path));
    if (
      unticked.length &&
      !(await confirm(
        `A ${OPERATION_NOUN[state]} is in progress, so all changes must be committed together.`,
        'Commit All',
        `${plural(unticked.length)} you did not tick will be included as well.`,
      ))
    ) {
      return false;
    }
    changes = [...tracked, ...changes.filter((c) => c.kind === 'untracked')];
    commitAll = true;
  }
  if (!amend && changes.length === 0) {
    vscode.window.showWarningMessage('No files selected. Tick the files to commit in the Changes view.');
    return false;
  }
  if (amend) {
    const pushedTo = await remoteBranchesContainingHead(repo);
    if (
      pushedTo.length &&
      !(await confirm(
        'The last commit has already been pushed.',
        'Amend Anyway',
        `It is on ${pushedTo.join(', ')}. Amending rewrites it, so you will need to force-push.`,
      ))
    ) {
      return false;
    }
  }

  const sha = await runWithProgress(amend ? 'Amending commit' : 'Committing', () =>
    commitFiles(repo, { changes, message, amend, commitAll }),
  );
  if (!sha) {
    return false;
  }
  await messages.addToHistory(repo.root, message);
  await cw.refresh();
  const subject = message.trim().split('\n')[0];
  if (push) {
    await branchOps.push(repo);
  } else {
    const what = changes.length ? plural(changes.length) : 'message';
    vscode.window.showInformationMessage(`${amend ? 'Amended' : 'Committed'} ${what}: ${subject} (${sha.slice(0, 7)})`);
  }
  return true;
}
