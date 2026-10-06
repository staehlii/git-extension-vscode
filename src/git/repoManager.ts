import * as vscode from 'vscode';
import type { API, Repository } from './gitApi';
import { GitCli } from './gitCli';
import { Repo } from './repo';

export class RepoManager implements vscode.Disposable {
  private readonly repos = new Map<string, Repo>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<string, vscode.Disposable>();
  private readonly changeEmitter = new vscode.EventEmitter<Repo>();
  private lastUsed: Repo | undefined;
  private debounce: NodeJS.Timeout | undefined;

  /** Fires (debounced) when any repository's state changes or repos are added/removed. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly api: API, readonly cli: GitCli) {
    api.repositories.forEach((r) => this.add(r));
    this.disposables.push(
      api.onDidOpenRepository((r) => this.add(r)),
      api.onDidCloseRepository((r) => this.remove(r)),
      vscode.window.onDidChangeActiveTextEditor(() => this.fireSoon()),
    );
  }

  get all(): Repo[] {
    return [...this.repos.values()];
  }

  /** Repo of the active editor, else the last used one, else the only/first one. */
  get current(): Repo | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      const apiRepo = this.api.getRepository(uri);
      const repo = apiRepo && this.repos.get(apiRepo.rootUri.fsPath);
      if (repo) {
        return repo;
      }
    }
    if (this.lastUsed && this.repos.has(this.lastUsed.root)) {
      return this.lastUsed;
    }
    return this.all[0];
  }

  /** Like `current`, but asks the user when several repos exist and none is clearly active. */
  async pick(): Promise<Repo | undefined> {
    const repos = this.all;
    if (repos.length === 0) {
      vscode.window.showWarningMessage('No Git repository is open.');
      return undefined;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    const active = uri && this.api.getRepository(uri);
    if (repos.length === 1 || active) {
      return this.use(this.current!);
    }
    const choice = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: r.name, description: r.root, repo: r })),
      { placeHolder: 'Select repository' },
    );
    return choice && this.use(choice.repo);
  }

  private use(repo: Repo): Repo {
    this.lastUsed = repo;
    return repo;
  }

  private add(apiRepo: Repository): void {
    const root = apiRepo.rootUri.fsPath;
    if (this.repos.has(root)) {
      return;
    }
    const repo = new Repo(root, apiRepo, this.cli);
    this.repos.set(root, repo);
    this.repoListeners.set(root, apiRepo.state.onDidChange(() => this.fireSoon(repo)));
    this.fireSoon(repo);
  }

  private remove(apiRepo: Repository): void {
    const root = apiRepo.rootUri.fsPath;
    this.repoListeners.get(root)?.dispose();
    this.repoListeners.delete(root);
    this.repos.delete(root);
    this.fireSoon();
  }

  private fireSoon(repo?: Repo): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      const target = repo ?? this.current;
      if (target) {
        this.changeEmitter.fire(target);
      }
    }, 150);
  }

  dispose(): void {
    clearTimeout(this.debounce);
    this.repoListeners.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
  }
}
