import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { openFileDiff } from '../git/commitPicker';
import { emptyTree } from '../git/history';
import { openInteractiveRebase } from '../rebase/rebaseEditor';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { gitConsole, showGitError } from '../util/ui';
import * as actions from './logActions';
import { LOG_FORMAT, LogFilters, parseLog } from './logModel';
import { branchesContaining, loadDetails, loadLog, loadRefs } from './logService';
import type { CommitDetailsData, FilterKind, FilterSummary, FromWebview, LogCommit, ToWebview } from './protocol';

const PAGE_SIZE = 2000;

/** Argument VS Code passes to webview/context menu commands: the row's data-vscode-context. */
interface RowContext {
  sha?: string;
}

/** The JetBrains-style Git Log in the bottom panel. */
export class LogView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'jbgit.log';

  private view: vscode.WebviewView | undefined;
  private repo: Repo | undefined;
  private filters: LogFilters = {};
  private limit = PAGE_SIZE;
  private fingerprint: string | undefined;
  private head: string | undefined;
  private commits: LogCommit[] = [];
  private selection: string[] = [];
  private contextSha: string | undefined;
  private details: CommitDetailsData | undefined;
  private loadSeq = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly repos: RepoManager) {
    this.disposables.push(repos.onDidChange(() => void this.reloadIfChanged()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.fingerprint = undefined;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.receive(m).catch((e) => showGitError('Git Log', e)));
    view.onDidChangeVisibility(() => view.visible && void this.reloadIfChanged());
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Commits currently shown (for tests). */
  get loadedCommits(): readonly LogCommit[] {
    return this.commits;
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${LogView.viewId}.focus`);
  }

  /** JetBrains "Show History" for a file: the log filtered to that path. */
  async showFileHistory(uri: vscode.Uri): Promise<void> {
    const repo = this.repos.all.find((r) => uri.fsPath === r.root || uri.fsPath.startsWith(r.root + path.sep));
    if (!repo) {
      vscode.window.showWarningMessage('This file is not inside an open Git repository.');
      return;
    }
    this.repo = repo;
    this.filters = { paths: [path.relative(repo.root, uri.fsPath).split(path.sep).join('/')] };
    this.limit = PAGE_SIZE;
    await this.show();
    await this.reload(false);
  }

  // ---- webview messages ----

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private async receive(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.reload(false);
        break;
      case 'refresh':
        await this.reload(true);
        break;
      case 'loadMore':
        this.limit += PAGE_SIZE;
        await this.reload(true);
        break;
      case 'select':
        this.selection = m.shas;
        await this.showDetails();
        break;
      case 'contextTarget':
        this.contextSha = m.sha;
        break;
      case 'text':
        this.filters.text = m.value.trim() || undefined;
        this.limit = PAGE_SIZE;
        await this.reload(false);
        break;
      case 'pickFilter':
        if (await this.pickFilter(m.kind)) {
          this.limit = PAGE_SIZE;
          await this.reload(false);
        }
        break;
      case 'clearFilters':
        this.filters = {};
        this.limit = PAGE_SIZE;
        await this.reload(false);
        break;
      case 'openDiff': {
        const file = this.details?.sha === m.sha ? this.details.files.find((f) => f.path === m.path) : undefined;
        if (this.repo && this.details && file) {
          const parent = this.details.parents[0];
          const left = parent ?? (await emptyTree(this.repo));
          await openFileDiff(this.repo, file, left, m.sha, `${m.sha.slice(0, 8)} ${file.status}`);
        }
        break;
      }
    }
  }

  // ---- loading ----

  private async reloadIfChanged(): Promise<void> {
    if (!this.view?.visible) {
      return;
    }
    const repo = this.repos.current;
    if (repo && repo !== this.repo) {
      this.repo = repo;
      this.filters = {}; // paths/branches are per repository
      this.limit = PAGE_SIZE;
      await this.reload(false);
      return;
    }
    if (this.repo && (await loadRefs(this.repo)).fingerprint !== this.fingerprint) {
      await this.reload(true);
    }
  }

  private async reload(keepView: boolean): Promise<void> {
    this.repo ??= this.repos.current;
    const repo = this.repo;
    if (!this.view || !repo) {
      if (!repo) {
        this.post({ type: 'error', message: 'No Git repository is open.' });
      }
      return;
    }
    const seq = ++this.loadSeq;
    if (!keepView) {
      this.post({ type: 'loading' });
    }
    try {
      const refs = await loadRefs(repo);
      const page = await loadLog(repo, this.filters, this.limit, !!refs.head);
      if (seq !== this.loadSeq) {
        return; // a newer load started meanwhile
      }
      this.fingerprint = refs.fingerprint;
      this.head = refs.head;
      this.commits = page.commits;
      this.post({
        type: 'data',
        commits: page.commits,
        graph: page.graph,
        maxLanes: page.maxLanes,
        refs: refs.refs,
        head: refs.head ?? null,
        hasMore: page.hasMore,
        filters: this.summary(),
        repoName: repo.name,
        keepView,
      });
    } catch (e) {
      gitConsole().appendLine(`Git Log failed: ${e instanceof Error ? e.message : e}`);
      if (seq === this.loadSeq) {
        this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private async showDetails(): Promise<void> {
    const repo = this.repo;
    if (!repo || this.selection.length === 0) {
      return;
    }
    if (this.selection.length > 1) {
      this.details = undefined;
      this.post({ type: 'multiSelection', count: this.selection.length });
      return;
    }
    const sha = this.selection[0];
    const details = await loadDetails(repo, sha);
    if (this.selection[0] !== sha) {
      return;
    }
    this.details = details;
    this.post({ type: 'details', sha, details });
    const branches = await branchesContaining(repo, sha);
    if (this.selection[0] === sha) {
      this.post({ type: 'branches', sha, branches });
    }
  }

  // ---- filters ----

  private summary(): FilterSummary {
    const f = this.filters;
    const list = (items: string[] | undefined) => (items?.length ? items.join(', ') : 'All');
    return {
      text: f.text ?? '',
      branch: list(f.branches),
      user: list(f.authors),
      date: f.dateLabel ?? 'All',
      path: list(f.paths),
      active: !!(f.text || f.branches?.length || f.authors?.length || f.since || f.until || f.paths?.length),
    };
  }

  /** Native pickers for the toolbar filters. Returns true when the filter changed. */
  private async pickFilter(kind: FilterKind): Promise<boolean> {
    const repo = this.repo;
    if (!repo) {
      return false;
    }
    switch (kind) {
      case 'branch': {
        const out = await repo.out(['for-each-ref', '--format=%(refname:short)%00%(refname)%00%(symref)', 'refs/heads', 'refs/remotes']);
        const branches = out
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\0'))
          .filter(([, , symref]) => !symref)
          .map(([name, full]) => ({ label: name, description: full.startsWith('refs/remotes/') ? 'remote' : undefined }));
        const current = new Set(this.filters.branches ?? []);
        const items = [{ label: 'HEAD', description: 'current' }, ...branches].map((b) => ({ ...b, picked: current.has(b.label) }));
        const picks = await vscode.window.showQuickPick(items, {
          title: 'Branch Filter (none selected = all branches)',
          canPickMany: true,
          matchOnDescription: true,
        });
        if (!picks) {
          return false;
        }
        this.filters.branches = picks.length ? picks.map((p) => p.label) : undefined;
        return true;
      }
      case 'user': {
        const counts = new Map<string, number>();
        this.commits.forEach((c) => counts.set(c.author, (counts.get(c.author) ?? 0) + 1));
        const me = (await repo.exec(['config', 'user.name'], { allowFailure: true })).stdout.trim();
        const current = new Set(this.filters.authors ?? []);
        const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
        if (me && !names.includes(me)) {
          names.unshift(me);
        }
        const picks = await vscode.window.showQuickPick(
          names.map((name) => ({ label: name, description: name === me ? 'me' : `${counts.get(name) ?? 0} commits loaded`, picked: current.has(name) })),
          { title: 'User Filter (none selected = all users)', canPickMany: true },
        );
        if (!picks) {
          return false;
        }
        this.filters.authors = picks.length ? picks.map((p) => p.label) : undefined;
        return true;
      }
      case 'date': {
        const presets = [
          { label: 'All', since: undefined },
          { label: 'Last 24 hours', since: '24 hours ago' },
          { label: 'Last 7 days', since: '7 days ago' },
          { label: 'Last 30 days', since: '30 days ago' },
          { label: 'Last year', since: '1 year ago' },
          { label: 'Since date…', since: 'custom' },
        ];
        const pick = await vscode.window.showQuickPick(presets, { title: 'Date Filter' });
        if (!pick) {
          return false;
        }
        let since = pick.since;
        let label = pick.label;
        if (since === 'custom') {
          const value = await vscode.window.showInputBox({
            title: 'Show commits since',
            prompt: 'Date as YYYY-MM-DD',
            validateInput: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? undefined : 'Use YYYY-MM-DD'),
          });
          if (!value) {
            return false;
          }
          since = value.trim();
          label = `Since ${since}`;
        }
        this.filters.since = since;
        this.filters.dateLabel = since ? label : undefined;
        return true;
      }
      case 'path': {
        const value = await vscode.window.showInputBox({
          title: 'Paths Filter',
          prompt: 'Repository-relative paths separated by commas (empty = all)',
          value: (this.filters.paths ?? []).join(', '),
        });
        if (value === undefined) {
          return false;
        }
        const paths = value.split(',').map((p) => p.trim()).filter(Boolean);
        this.filters.paths = paths.length ? paths : undefined;
        return true;
      }
    }
  }

  // ---- context menu targets ----

  /**
   * Commits a context-menu command applies to: the selection if it contains the clicked row, else the
   * row. Commits that are no longer loaded (log reloaded or filtered meanwhile) are read from git.
   */
  async targets(arg?: RowContext): Promise<{ repo: Repo; commits: LogCommit[]; head: string | undefined } | undefined> {
    const sha = arg?.sha ?? this.contextSha ?? this.selection[0];
    const repo = this.repo ?? this.repos.current;
    if (!repo || !sha) {
      return undefined;
    }
    const shas = this.selection.includes(sha) ? this.selection : [sha];
    const loaded = new Map(this.commits.map((c, i) => [c.sha, { c, i }]));
    const commits: { c: LogCommit; i: number }[] = [];
    for (const s of shas) {
      const known = loaded.get(s);
      const c = known?.c ?? parseLog(await repo.out(['log', '-1', `--format=${LOG_FORMAT}`, s, '--']))[0];
      if (c) {
        commits.push({ c, i: known?.i ?? Number.MAX_SAFE_INTEGER });
      }
    }
    commits.sort((a, b) => a.i - b.i); // newest first, as displayed
    const head = this.head ?? (await repo.exec(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })).stdout.trim();
    return commits.length ? { repo, commits: commits.map((x) => x.c), head } : undefined;
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'log.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'log.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
  <div id="toolbar">
    <input id="search" type="search" placeholder="Text or hash" aria-label="Filter by text or hash">
    <button class="filter" data-filter="branch">Branch: <span>All</span></button>
    <button class="filter" data-filter="user">User: <span>All</span></button>
    <button class="filter" data-filter="date">Date: <span>All</span></button>
    <button class="filter" data-filter="path">Paths: <span>All</span></button>
    <button id="clear" title="Clear all filters" hidden>✕ Clear</button>
    <span class="spacer"></span>
    <span id="status"></span>
    <button id="refresh" title="Refresh">↻</button>
  </div>
  <div id="main">
    <div id="table">
      <div id="header" class="row">
        <div class="c-graph"></div><div class="c-subject">Subject</div><div class="c-author">Author</div><div class="c-date">Date</div><div class="c-hash">Hash</div>
      </div>
      <div id="scroller" tabindex="0"><div id="spacer"></div><div id="rows"></div></div>
      <div id="message" hidden></div>
    </div>
    <div id="splitter"></div>
    <div id="details"><div class="placeholder">Select a commit to see its details</div></div>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Registers the log view and its commit context-menu commands. */
export function registerLogView(context: vscode.ExtensionContext, repos: RepoManager): LogView {
  const log = new LogView(context.extensionUri, repos);

  const onCommits = (title: string, fn: (t: NonNullable<Awaited<ReturnType<LogView['targets']>>>) => Promise<unknown>) =>
    async (arg?: RowContext) => {
      const t = await log.targets(arg);
      if (!t) {
        return;
      }
      try {
        await fn(t);
      } catch (e) {
        await showGitError(title, e);
      }
    };
  const oldestFirst = (commits: LogCommit[]) => [...commits].reverse();

  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider(LogView.viewId, log, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('jbgit.log.show', () => log.show()),
    vscode.commands.registerCommand('jbgit.log.showFileHistory', async (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme === 'file') {
        await log.showFileHistory(target);
      } else {
        vscode.window.showWarningMessage('Open a file to show its history.');
      }
    }),
    vscode.commands.registerCommand('jbgit.log.copyRevision', onCommits('Copy Revision', (t) => actions.copyRevision(t.commits))),
    vscode.commands.registerCommand('jbgit.log.checkout', onCommits('Checkout', (t) => actions.checkoutRevision(t.repo, t.commits[0]))),
    vscode.commands.registerCommand('jbgit.log.newBranch', onCommits('New Branch', (t) => actions.newBranch(t.repo, t.commits[0]))),
    vscode.commands.registerCommand('jbgit.log.newTag', onCommits('New Tag', (t) => actions.newTag(t.repo, t.commits[0]))),
    vscode.commands.registerCommand('jbgit.log.cherryPick', onCommits('Cherry-pick', (t) => actions.cherryPick(t.repo, oldestFirst(t.commits)))),
    vscode.commands.registerCommand('jbgit.log.revert', onCommits('Revert', (t) => actions.revert(t.repo, t.commits))),
    vscode.commands.registerCommand('jbgit.log.resetToHere', onCommits('Reset', (t) => actions.resetToHere(t.repo, t.commits[0]))),
    vscode.commands.registerCommand('jbgit.log.undoCommit', onCommits('Undo Commit', (t) => actions.undoCommit(t.repo, t.commits[0], t.head))),
    vscode.commands.registerCommand('jbgit.log.reword', onCommits('Edit Commit Message', (t) => actions.rewordHead(t.repo, t.commits[0], t.head))),
    vscode.commands.registerCommand('jbgit.log.compareWithLocal', onCommits('Compare with Local', (t) => actions.compareWithLocal(t.repo, t.commits[0]))),
    vscode.commands.registerCommand('jbgit.log.interactiveRebase', onCommits('Interactive Rebase', (t) =>
      openInteractiveRebase(context.extensionUri, t.repo, t.commits[t.commits.length - 1].sha), // oldest selected
    )),
    vscode.commands.registerCommand('jbgit.log.createPatch', onCommits('Create Patch', (t) => actions.createPatch(t.repo, oldestFirst(t.commits)))),
  );
  return log;
}
