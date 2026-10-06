// Launches the installed VS Code headlessly (run via xvfb-run) with the extension and a fixture repo.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function makeFixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbgit-e2e-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: { ...process.env, ...GIT_ENV } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a2\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b2\n');
  fs.writeFileSync(path.join(root, 'c.txt'), 'c\n');
  return root;
}

async function main(): Promise<void> {
  const repo = makeFixtureRepo();
  try {
    const code = await runTests({
      vscodeExecutablePath: process.env.VSCODE_PATH ?? '/usr/share/code/code',
      extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite/index'),
      launchArgs: [repo, '--disable-workspace-trust', '--disable-extensions', '--ozone-platform=x11'],
      extensionTestsEnv: { ...GIT_ENV, JBGIT_TEST_REPO: repo },
    });
    process.exitCode = code;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
