import * as vscode from 'vscode';

const DEFAULT_FAVORITES = ['refs/heads/main', 'refs/heads/master'];

/** Favorite branches per repository, stored in global state like JetBrains does per project. */
export class Favorites {
  constructor(private readonly state: vscode.Memento) {}

  private key(root: string): string {
    return `jbgit.favorites:${root}`;
  }

  get(root: string): Set<string> {
    return new Set(this.state.get<string[]>(this.key(root), DEFAULT_FAVORITES));
  }

  async toggle(root: string, fullRef: string): Promise<void> {
    const favs = this.get(root);
    if (!favs.delete(fullRef)) {
      favs.add(fullRef);
    }
    await this.state.update(this.key(root), [...favs]);
  }
}
