// Minimal subset of the built-in vscode.git extension API (v1) that this extension uses.
// Source: microsoft/vscode extensions/git/src/api/git.d.ts
import type { Event, Uri } from 'vscode';

export interface GitExtension {
  getAPI(version: 1): API;
}

export interface API {
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: { readonly onDidChange: Event<void> };
}
