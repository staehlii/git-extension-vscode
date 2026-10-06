import * as path from 'path';
import * as vscode from 'vscode';
import { GitCli } from './gitCli';

export const SCHEME = 'jbgit';

interface RevisionQuery {
  root: string;
  /** Commit-ish ("HEAD", a SHA, "main~1"), "" for the index, or ":1"/":2"/":3" for conflict stages. */
  ref: string;
}

/** URI for the content of `file` (absolute path) at `ref`. Keeps the file name so syntax highlighting works. */
export function revisionUri(root: string, file: string, ref: string): vscode.Uri {
  const query: RevisionQuery = { root, ref };
  return vscode.Uri.from({ scheme: SCHEME, path: file, query: JSON.stringify(query) });
}

/** Serves read-only file content at a revision via `git show <ref>:<path>`. Missing files resolve to empty. */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly cli: GitCli) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref } = JSON.parse(uri.query) as RevisionQuery;
    const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
    const res = await this.cli.exec(root, ['show', `${ref}:${rel}`], { allowFailure: true });
    return res.exitCode === 0 ? res.stdout : '';
  }
}
