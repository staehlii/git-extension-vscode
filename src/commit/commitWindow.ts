import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { gitConsole } from '../util/ui';
import { Changelist, ChangelistData, ChangelistModel } from './changelistModel';
import { FileChange, parseStatusV2 } from './statusParser';

const isTracked = (c: FileChange) => c.kind !== 'untracked' && c.kind !== 'conflict';

/**
 * State behind the Commit tool window for the current repository: changed files, changelists
 * (persisted per repo in workspace state) and which files are ticked for the next commit.
 */
export class CommitWindow implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private currentRepo: Repo | undefined;
  private currentChanges: FileChange[] = [];
  private readonly models = new Map<string, ChangelistModel>();
  private readonly savedJson = new Map<string, string>();
  /** Ticked paths per repo root. In memory only, like JetBrains. */
  private readonly included = new Map<string, Set<string>>();
  private running: Promise<void> | undefined;
  private rerun = false;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly repos: RepoManager, private readonly state: vscode.Memento) {
    this.subscription = repos.onDidChange(() => void this.refresh());
  }

  get repo(): Repo | undefined {
    return this.currentRepo;
  }

  get changes(): readonly FileChange[] {
    return this.currentChanges;
  }

  get changelists(): readonly Changelist[] {
    return this.currentRepo ? this.model(this.currentRepo).all : [];
  }

  get activeChangelist(): Changelist | undefined {
    return this.currentRepo && this.model(this.currentRepo).active;
  }

  changesIn(listId: string): FileChange[] {
    const model = this.currentRepo && this.model(this.currentRepo);
    return model ? this.currentChanges.filter((c) => isTracked(c) && model.listOf(c.path) === listId) : [];
  }

  listOf(path: string): string | undefined {
    return this.currentRepo && this.model(this.currentRepo).listOf(path);
  }

  get unversioned(): FileChange[] {
    return this.currentChanges.filter((c) => c.kind === 'untracked');
  }

  get conflicts(): FileChange[] {
    return this.currentChanges.filter((c) => c.kind === 'conflict');
  }

  isIncluded(path: string): boolean {
    return !!this.currentRepo && !!this.included.get(this.currentRepo.root)?.has(path);
  }

  setIncluded(paths: string[], include: boolean): void {
    const set = this.currentRepo && this.included.get(this.currentRepo.root);
    if (!set) {
      return;
    }
    paths.forEach((p) => (include ? set.add(p) : set.delete(p)));
    this.emitter.fire();
  }

  includedChanges(): FileChange[] {
    return this.currentChanges.filter((c) => c.kind !== 'conflict' && this.isIncluded(c.path));
  }

  /** Re-reads `git status`. Concurrent calls are coalesced into one extra run. */
  refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.load()
      .catch((e) => gitConsole().appendLine(`Commit window refresh failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        this.running = undefined;
        if (this.rerun) {
          this.rerun = false;
          void this.refresh();
        }
      });
    return this.running;
  }

  private async load(): Promise<void> {
    const repo = this.repos.current;
    this.currentRepo = repo;
    if (!repo) {
      this.currentChanges = [];
      this.emitter.fire();
      return;
    }
    const changes = parseStatusV2(await repo.out(['status', '--porcelain=v2', '-z', '--untracked-files=all']));
    if (this.repos.current !== repo) {
      this.rerun = true; // switched repos while loading; load the new one next
      return;
    }
    const model = this.model(repo);
    const tracked = changes.filter(isTracked).map((c) => c.path);
    const firstLoad = !this.included.has(repo.root);
    const newlyAssigned = model.reconcile(tracked);

    const set = this.included.get(repo.root) ?? new Set<string>();
    const present = new Set(changes.filter((c) => c.kind !== 'conflict').map((c) => c.path));
    for (const p of set) {
      if (!present.has(p)) {
        set.delete(p);
      }
    }
    // JetBrains ticks the active changelist's files; new files are ticked when they land in it.
    for (const p of firstLoad ? tracked : newlyAssigned) {
      if (model.listOf(p) === model.active.id) {
        set.add(p);
      }
    }
    this.included.set(repo.root, set);
    this.currentChanges = changes;
    this.save(repo);
    this.emitter.fire();
  }

  // ---- changelist operations (current repo) ----

  createChangelist(name: string): Changelist {
    return this.mutate((m) => m.create(name));
  }

  renameChangelist(id: string, name: string): void {
    this.mutate((m) => m.rename(id, name));
  }

  deleteChangelist(id: string): void {
    this.mutate((m) => m.remove(id));
  }

  setActiveChangelist(id: string): void {
    this.mutate((m) => m.setActive(id));
  }

  moveToChangelist(paths: string[], id: string): void {
    this.mutate((m) => m.move(paths, id));
  }

  private mutate<T>(fn: (m: ChangelistModel) => T): T {
    const repo = this.currentRepo;
    if (!repo) {
      throw new Error('No Git repository is open.');
    }
    const result = fn(this.model(repo));
    this.save(repo);
    this.emitter.fire();
    return result;
  }

  private key(repo: Repo): string {
    return `jbgit.changelists:${repo.root}`;
  }

  private model(repo: Repo): ChangelistModel {
    let m = this.models.get(repo.root);
    if (!m) {
      m = new ChangelistModel(this.state.get<ChangelistData>(this.key(repo)));
      this.models.set(repo.root, m);
    }
    return m;
  }

  private save(repo: Repo): void {
    const json = JSON.stringify(this.model(repo).toJSON());
    if (this.savedJson.get(repo.root) !== json) {
      this.savedJson.set(repo.root, json);
      void this.state.update(this.key(repo), JSON.parse(json));
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
