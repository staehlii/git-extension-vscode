import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../../src/git/gitCli';
import { Repo } from '../../src/git/repo';

// Isolate tests from the user's git config (signing, hooks, default branch …).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

export function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

/** New repo on branch main with the given files committed. */
export function makeRepo(files: Record<string, string>): { root: string; repo: Repo } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbgit-test-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) {
    write(root, f, c);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  // The vscode.git Repository handle is not used by the code under test.
  const repo = new Repo(root, {} as never, new GitCli('git'));
  return { root, repo };
}

export function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
