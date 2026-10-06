import * as fs from 'fs';
import * as path from 'path';
import type { Repository } from './gitApi';
import { ExecOptions, GitCli, GitResult } from './gitCli';

export type OperationState = 'none' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

/** "merge", "rebase", … for messages like "A merge is in progress". */
export const OPERATION_NOUN: Record<Exclude<OperationState, 'none'>, string> = {
  merging: 'merge',
  rebasing: 'rebase',
  'cherry-picking': 'cherry-pick',
  reverting: 'revert',
};

export class Repo {
  private gitDirPromise: Promise<string> | undefined;

  constructor(readonly root: string, readonly api: Repository, private readonly cli: GitCli) {}

  get name(): string {
    return path.basename(this.root);
  }

  exec(args: string[], options?: ExecOptions): Promise<GitResult> {
    return this.cli.exec(this.root, args, options);
  }

  out(args: string[], options?: ExecOptions): Promise<string> {
    return this.cli.out(this.root, args, options);
  }

  /** Absolute .git directory (handles worktrees, where .git is a file). */
  gitDir(): Promise<string> {
    this.gitDirPromise ??= this.out(['rev-parse', '--absolute-git-dir']).then((s) => s.trim());
    return this.gitDirPromise;
  }

  /** Current branch name, or undefined when HEAD is detached. */
  async currentBranch(): Promise<string | undefined> {
    const res = await this.exec(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true });
    return res.exitCode === 0 ? res.stdout.trim() : undefined;
  }

  async headShort(): Promise<string> {
    return (await this.out(['rev-parse', '--short', 'HEAD'])).trim();
  }

  async operationState(): Promise<OperationState> {
    const dir = await this.gitDir();
    const has = (p: string) => fs.existsSync(path.join(dir, p));
    if (has('rebase-merge') || has('rebase-apply')) {
      return 'rebasing';
    }
    if (has('MERGE_HEAD')) {
      return 'merging';
    }
    if (has('CHERRY_PICK_HEAD')) {
      return 'cherry-picking';
    }
    if (has('REVERT_HEAD')) {
      return 'reverting';
    }
    return 'none';
  }

  async hasLocalChanges(): Promise<boolean> {
    const status = await this.out(['status', '--porcelain', '--untracked-files=no']);
    return status.trim().length > 0;
  }
}
