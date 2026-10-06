import * as vscode from 'vscode';

const HISTORY_LIMIT = 20;

/** Draft commit message and message history per repository (workspace state). */
export class MessageStore {
  constructor(private readonly state: vscode.Memento) {}

  draft(root: string): string {
    return this.state.get<string>(`jbgit.draft:${root}`, '');
  }

  setDraft(root: string, message: string): Thenable<void> {
    return this.state.update(`jbgit.draft:${root}`, message);
  }

  history(root: string): string[] {
    return this.state.get<string[]>(`jbgit.history:${root}`, []);
  }

  addToHistory(root: string, message: string): Thenable<void> {
    const trimmed = message.trim();
    const list = [trimmed, ...this.history(root).filter((m) => m !== trimmed)].slice(0, HISTORY_LIMIT);
    return this.state.update(`jbgit.history:${root}`, list);
  }
}
