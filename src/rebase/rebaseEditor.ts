import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { reportStoppedOperation } from '../branches/branchService';
import { OPERATION_NOUN, Repo } from '../git/repo';
import { runWithProgress } from '../util/ui';
import { RebaseEntry } from './rebaseModel';
import { loadRebaseCommits, RebaseCommit, runInteractiveRebase } from './rebaseRunner';

export type RebaseToWebview = {
  type: 'init';
  commits: RebaseCommit[];
  branch: string;
  base: string;
  warning?: string;
};

export type RebaseFromWebview = { type: 'ready' } | { type: 'start'; entries: RebaseEntry[] } | { type: 'cancel' };

const short = (sha: string) => sha.slice(0, 8);

const readyEmitter = new vscode.EventEmitter<string>();
/** Fires with the panel title when a rebase editor's webview has loaded (used by end-to-end tests). */
export const onDidRebaseEditorLoad = readyEmitter.event;

/**
 * JetBrains "Interactively Rebase from Here": edits the commits from `fromSha` (inclusive) up to HEAD.
 */
export async function openInteractiveRebase(extensionUri: vscode.Uri, repo: Repo, fromSha: string): Promise<void> {
  const state = await repo.operationState();
  if (state !== 'none') {
    vscode.window.showWarningMessage(`Finish the current ${OPERATION_NOUN[state]} first.`);
    return;
  }
  if ((await repo.exec(['merge-base', '--is-ancestor', fromSha, 'HEAD'], { allowFailure: true })).exitCode !== 0) {
    vscode.window.showWarningMessage(`${short(fromSha)} is not part of the current branch, so it cannot be rebased here.`);
    return;
  }
  const parent = await repo.exec(['rev-parse', '--verify', '-q', `${fromSha}^`], { allowFailure: true });
  const base = parent.exitCode === 0 ? parent.stdout.trim() : null;
  const commits = await loadRebaseCommits(repo, base);
  const merges = commits.filter((c) => c.parents.length > 1);
  if (merges.length) {
    vscode.window.showWarningMessage(
      `The range contains merge commits (${merges.map((c) => short(c.sha)).join(', ')}); interactive rebase would flatten them. Start from a later commit.`,
    );
    return;
  }
  const pushed = (await repo.out(['branch', '-r', '--contains', fromSha, '--format=%(refname:short)'])).split('\n').filter(Boolean);
  const branch = (await repo.currentBranch()) ?? 'HEAD';
  const baseLabel = base
    ? (await repo.out(['log', '-1', '--format=%h %s', base])).trim()
    : 'the beginning of history (root)';

  const panel = vscode.window.createWebviewPanel('jbgit.rebase', `Rebase '${branch}'`, vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
  });
  panel.webview.html = html(panel.webview, extensionUri);
  panel.webview.onDidReceiveMessage(async (m: RebaseFromWebview) => {
    switch (m.type) {
      case 'ready': {
        const init: RebaseToWebview = {
          type: 'init',
          commits,
          branch,
          base: baseLabel,
          warning: pushed.length
            ? `These commits are already pushed (${pushed.slice(0, 3).join(', ')}${pushed.length > 3 ? ', …' : ''}). Rebasing rewrites them, so you will need to force-push.`
            : undefined,
        };
        void panel.webview.postMessage(init);
        readyEmitter.fire(panel.title);
        break;
      }
      case 'cancel':
        panel.dispose();
        break;
      case 'start':
        panel.dispose();
        await execute(repo, base, m.entries);
        break;
    }
  });
}

async function execute(repo: Repo, base: string | null, entries: RebaseEntry[]): Promise<void> {
  const result = await runWithProgress('Rebasing', () => runInteractiveRebase(repo, base, entries));
  if (!result) {
    return; // error already shown
  }
  if (result.exitCode === 0) {
    const kept = entries.filter((e) => e.action !== 'drop').length;
    vscode.window.showInformationMessage(`Rebase finished (${entries.length} commits → ${kept} rewritten).`);
    return;
  }
  if ((await repo.operationState()) !== 'rebasing') {
    vscode.window.showErrorMessage(`Rebase failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return;
  }
  const unmerged = (await repo.out(['diff', '--name-only', '--diff-filter=U'])).trim();
  if (unmerged) {
    await reportStoppedOperation(repo, 'Rebase');
    return;
  }
  const stoppedAt = (await repo.out(['log', '-1', '--format=%h %s'])).trim();
  void vscode.window
    .showInformationMessage(`Rebase stopped for editing at ${stoppedAt}. Change files or amend the commit, then continue.`, 'Continue / Abort…')
    .then((choice) => choice && vscode.commands.executeCommand('jbgit.operationActions'));
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'rebase.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'rebase.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
  <header>
    <h1 id="title">Interactive Rebase</h1>
    <p id="subtitle"></p>
    <p id="warning" class="warning" hidden></p>
  </header>
  <div id="toolbar" role="toolbar">
    <button data-action="pick" title="Pick (P): keep the commit">Pick</button>
    <button data-action="edit" title="Edit (E): stop after this commit to change it">Edit</button>
    <button data-action="reword" title="Reword (R): change the message">Reword</button>
    <button data-action="squash" title="Squash (S): meld into the previous commit, combining messages">Squash</button>
    <button data-action="fixup" title="Fixup (F): meld into the previous commit, discarding this message">Fixup</button>
    <button data-action="drop" title="Drop (D): remove the commit">Drop</button>
    <span class="sep"></span>
    <button id="up" title="Move Up (Alt+↑)">↑ Up</button>
    <button id="down" title="Move Down (Alt+↓)">↓ Down</button>
    <span class="sep"></span>
    <button id="reset" title="Undo all changes to the plan">Reset</button>
  </div>
  <div id="list" tabindex="0" role="listbox" aria-label="Commits, applied from top to bottom"></div>
  <footer>
    <span id="error" class="error"></span>
    <span class="spacer"></span>
    <button id="cancel" class="secondary">Cancel</button>
    <button id="start">Start Rebasing</button>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
