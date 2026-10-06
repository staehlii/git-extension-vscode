import * as path from 'path';
import * as vscode from 'vscode';
import { Changelist } from './changelistModel';
import { CommitWindow } from './commitWindow';
import { FileChange } from './statusParser';

export type ChangesNode =
  | { type: 'list'; list: Changelist }
  | { type: 'unversioned' }
  | { type: 'conflicts' }
  | { type: 'file'; change: FileChange };

const KIND_LABEL: Record<FileChange['kind'], string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Unversioned',
  conflict: 'Merge conflict',
};

const checkbox = (on: boolean) => (on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked);
const plural = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** The Changes tree of the Commit tool window: changelists, unversioned files and merge conflicts. */
export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangesNode> {
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(private readonly cw: CommitWindow) {
    this.onDidChangeTreeData = cw.onDidChange;
  }

  /** Files behind a node (a list node stands for all of its files). */
  filesOf(node: ChangesNode): FileChange[] {
    switch (node.type) {
      case 'file':
        return [node.change];
      case 'list':
        return this.cw.changesIn(node.list.id);
      case 'unversioned':
        return this.cw.unversioned;
      case 'conflicts':
        return this.cw.conflicts;
    }
  }

  getChildren(node?: ChangesNode): ChangesNode[] {
    if (!this.cw.repo) {
      return [];
    }
    if (!node) {
      const roots: ChangesNode[] = [];
      if (this.cw.conflicts.length) {
        roots.push({ type: 'conflicts' });
      }
      roots.push(...this.cw.changelists.map((list): ChangesNode => ({ type: 'list', list })));
      if (this.cw.unversioned.length) {
        roots.push({ type: 'unversioned' });
      }
      return roots;
    }
    return node.type === 'file' ? [] : this.filesOf(node).map((change): ChangesNode => ({ type: 'file', change }));
  }

  getTreeItem(node: ChangesNode): vscode.TreeItem {
    if (node.type === 'file') {
      return this.fileItem(node.change);
    }
    const files = this.filesOf(node);
    const expanded = files.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded;
    let item: vscode.TreeItem;
    if (node.type === 'list') {
      const active = this.cw.activeChangelist?.id === node.list.id;
      item = new vscode.TreeItem(node.list.name, expanded);
      item.id = `list:${node.list.id}`;
      item.description = plural(files.length) + (active ? ' · active' : '');
      item.contextValue = active ? 'changelist.active' : 'changelist';
      item.iconPath = new vscode.ThemeIcon(active ? 'circle-large-filled' : 'circle-large-outline');
      item.tooltip = `Changelist '${node.list.name}'${active ? ' (active: new changes go here)' : ''}`;
    } else if (node.type === 'unversioned') {
      item = new vscode.TreeItem(
        'Unversioned Files',
        files.length > 30 ? vscode.TreeItemCollapsibleState.Collapsed : expanded,
      );
      item.id = 'unversioned';
      item.description = plural(files.length);
      item.contextValue = 'unversionedGroup';
    } else {
      item = new vscode.TreeItem('Merge Conflicts', expanded);
      item.id = 'conflicts';
      item.description = plural(files.length);
      item.contextValue = 'conflictsGroup';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      return item; // conflicts cannot be ticked
    }
    if (files.length) {
      item.checkboxState = checkbox(files.every((f) => this.cw.isIncluded(f.path)));
    }
    return item;
  }

  private fileItem(change: FileChange): vscode.TreeItem {
    const root = this.cw.repo!.root;
    const uri = vscode.Uri.file(path.join(root, change.path));
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${change.path}`;
    item.label = path.posix.basename(change.path);
    const dir = path.posix.dirname(change.path);
    item.description = [dir === '.' ? '' : dir, change.origPath ? `← ${change.origPath}` : ''].filter(Boolean).join('  ');
    item.tooltip = `${change.path}\n${KIND_LABEL[change.kind]}${change.origPath ? ` from ${change.origPath}` : ''}`;
    item.contextValue = `file.${change.kind}`;
    if (change.kind !== 'conflict') {
      item.checkboxState = checkbox(this.cw.isIncluded(change.path));
    }
    item.command = { command: 'jbgit.commit.openChange', title: 'Show Diff', arguments: [{ type: 'file', change }] };
    return item;
  }
}
