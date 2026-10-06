import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { headMessage } from './commitService';
import { CommitWindow } from './commitWindow';
import { MessageStore } from './messageStore';

export type CommitHandler = (message: string, amend: boolean, push: boolean) => Promise<boolean>;

type FromWebview =
  | { type: 'ready' }
  | { type: 'draft'; message: string }
  | { type: 'amend'; amend: boolean }
  | { type: 'commit'; message: string; amend: boolean; push: boolean }
  | { type: 'history' };

/** Commit message box with Amend, Commit and Commit and Push (webview below the Changes tree). */
export class CommitPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'jbgit.commitMessage';

  private view: vscode.WebviewView | undefined;
  private shownRoot: string | undefined;
  private busy = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly cw: CommitWindow,
    private readonly messages: MessageStore,
    private readonly onCommit: CommitHandler,
  ) {
    this.subscription = cw.onDidChange(() => this.sync());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.shownRoot = undefined;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((m: FromWebview) => this.receive(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Reveals the panel and focuses the message box (JetBrains Ctrl+K). */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${CommitPanel.viewId}.focus`);
    void this.view?.webview.postMessage({ type: 'focus' });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** Pushes selection counts, and swaps in the draft when the current repository changed. */
  private sync(): void {
    const root = this.cw.repo?.root;
    if (root !== this.shownRoot) {
      this.shownRoot = root;
      this.post({ type: 'setMessage', message: root ? this.messages.draft(root) : '', amend: false });
    }
    this.post({
      type: 'state',
      selected: this.cw.includedChanges().length,
      total: this.cw.changes.filter((c) => c.kind !== 'conflict').length,
      busy: this.busy,
      hasRepo: !!root,
    });
  }

  private async receive(m: FromWebview): Promise<void> {
    const repo = this.cw.repo;
    switch (m.type) {
      case 'ready':
        this.shownRoot = undefined;
        this.sync();
        break;
      case 'draft':
        if (repo) {
          await this.messages.setDraft(repo.root, m.message);
        }
        break;
      case 'amend':
        if (m.amend && repo) {
          this.post({ type: 'headMessage', message: await headMessage(repo) });
        }
        break;
      case 'commit': {
        if (this.busy) {
          return;
        }
        this.busy = true;
        this.sync();
        let ok = false;
        try {
          ok = await this.onCommit(m.message, m.amend, m.push);
        } finally {
          this.busy = false;
          if (ok && repo) {
            await this.messages.setDraft(repo.root, '');
            this.post({ type: 'committed' });
          }
          this.sync();
        }
        break;
      }
      case 'history': {
        if (!repo) {
          return;
        }
        const history = this.messages.history(repo.root);
        if (history.length === 0) {
          vscode.window.showInformationMessage('No commit messages in history yet.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          history.map((msg) => {
            const [first, ...rest] = msg.split('\n');
            return { label: first, detail: rest.join(' ').trim() || undefined, msg };
          }),
          { title: 'Commit Message History', matchOnDetail: true },
        );
        if (pick) {
          await this.messages.setDraft(repo.root, pick.msg);
          this.post({ type: 'setMessage', message: pick.msg });
        }
        break;
      }
    }
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  html, body { height: 100%; }
  body {
    margin: 0; padding: 6px 8px 8px; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 6px;
    color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  }
  textarea {
    flex: 1; min-height: 60px; resize: none; box-sizing: border-box; width: 100%; padding: 4px 6px;
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  label { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
  button {
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 4px 10px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 2px 4px; }
  button.link:hover:not(:disabled) { background: none; text-decoration: underline; }
  button:disabled { opacity: 0.5; cursor: default; }
  .info { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <textarea id="msg" placeholder="Commit Message (Ctrl+Enter to commit)" spellcheck="true" aria-label="Commit message"></textarea>
  <div class="row">
    <label title="Add the selected files to the last commit and/or reword it"><input type="checkbox" id="amend"> Amend</label>
    <span class="spacer"></span>
    <button id="history" class="link" title="Pick a previous commit message">History…</button>
  </div>
  <div class="row">
    <button id="commit">Commit</button>
    <button id="commitPush" class="secondary">Commit and Push…</button>
  </div>
  <div class="info" id="info"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const msg = $('msg'), amend = $('amend'), commitBtn = $('commit'), pushBtn = $('commitPush'), info = $('info');
  let state = { selected: 0, total: 0, busy: false, hasRepo: false };
  let headMessage = null;
  let timer;

  function saveDraft() {
    clearTimeout(timer);
    vscode.postMessage({ type: 'draft', message: msg.value });
  }
  function render() {
    commitBtn.textContent = amend.checked ? 'Amend Commit' : 'Commit';
    pushBtn.textContent = amend.checked ? 'Amend Commit and Push…' : 'Commit and Push…';
    commitBtn.disabled = pushBtn.disabled = state.busy || !state.hasRepo;
    if (!state.hasRepo) {
      info.textContent = 'No Git repository';
    } else if (state.busy) {
      info.textContent = 'Committing…';
    } else {
      info.textContent = state.selected + ' of ' + state.total + ' file' + (state.total === 1 ? '' : 's') + ' selected';
    }
  }
  function commit(push) {
    if (state.busy) return;
    saveDraft();
    vscode.postMessage({ type: 'commit', message: msg.value, amend: amend.checked, push });
  }

  msg.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(saveDraft, 300);
  });
  msg.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      commit(false);
    }
  });
  amend.addEventListener('change', () => {
    if (amend.checked) {
      vscode.postMessage({ type: 'amend', amend: true });
    } else if (headMessage !== null && msg.value === headMessage) {
      msg.value = '';
      saveDraft();
    }
    render();
  });
  commitBtn.addEventListener('click', () => commit(false));
  pushBtn.addEventListener('click', () => commit(true));
  $('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'state':
        state = m;
        render();
        break;
      case 'setMessage':
        msg.value = m.message;
        if (typeof m.amend === 'boolean') amend.checked = m.amend;
        render();
        break;
      case 'headMessage':
        headMessage = m.message;
        if (amend.checked && msg.value.trim() === '') {
          msg.value = m.message;
          saveDraft();
        }
        break;
      case 'committed':
        msg.value = '';
        amend.checked = false;
        headMessage = null;
        render();
        break;
      case 'focus':
        msg.focus();
        break;
    }
  });
  render();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
