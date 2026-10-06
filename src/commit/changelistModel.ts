// Changelists are metadata only (as in JetBrains): which changed file belongs to which list.
// No vscode imports, unit-tested.

export interface Changelist {
  id: string;
  name: string;
}

export interface ChangelistData {
  lists: Changelist[];
  activeId: string;
  /** Repo-relative path -> changelist id. Only changed files are kept. */
  assignment: Record<string, string>;
}

export const DEFAULT_CHANGELIST_NAME = 'Changes';

let counter = 0;
function newId(): string {
  return `cl-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export class ChangelistModel {
  private lists: Changelist[];
  private activeId: string;
  private assignment: Map<string, string>;

  constructor(data?: ChangelistData) {
    if (data && data.lists.length > 0) {
      this.lists = data.lists.map((l) => ({ ...l }));
      this.activeId = this.lists.some((l) => l.id === data.activeId) ? data.activeId : this.lists[0].id;
      this.assignment = new Map(
        Object.entries(data.assignment).filter(([, id]) => this.lists.some((l) => l.id === id)),
      );
    } else {
      const first = { id: newId(), name: DEFAULT_CHANGELIST_NAME };
      this.lists = [first];
      this.activeId = first.id;
      this.assignment = new Map();
    }
  }

  get all(): readonly Changelist[] {
    return this.lists;
  }

  get active(): Changelist {
    return this.lists.find((l) => l.id === this.activeId)!;
  }

  get(id: string): Changelist | undefined {
    return this.lists.find((l) => l.id === id);
  }

  /** Changelist id of a changed path (call `reconcile` first so every path is assigned). */
  listOf(path: string): string {
    return this.assignment.get(path) ?? this.activeId;
  }

  /**
   * Assigns new changed paths to the active list and forgets paths that are no longer changed.
   * Returns the paths that were newly assigned.
   */
  reconcile(changedPaths: string[]): string[] {
    const current = new Set(changedPaths);
    for (const p of [...this.assignment.keys()]) {
      if (!current.has(p)) {
        this.assignment.delete(p);
      }
    }
    const added: string[] = [];
    for (const p of changedPaths) {
      if (!this.assignment.has(p)) {
        this.assignment.set(p, this.activeId);
        added.push(p);
      }
    }
    return added;
  }

  create(name: string): Changelist {
    this.assertUniqueName(name);
    const list = { id: newId(), name: name.trim() };
    this.lists.push(list);
    return list;
  }

  rename(id: string, name: string): void {
    const list = this.require(id);
    if (list.name !== name.trim()) {
      this.assertUniqueName(name);
    }
    list.name = name.trim();
  }

  /** Deletes a list; its files move to the active list (or the next list if the active one is deleted). */
  remove(id: string): void {
    this.require(id);
    if (this.lists.length === 1) {
      throw new Error('The last changelist cannot be deleted.');
    }
    this.lists = this.lists.filter((l) => l.id !== id);
    if (this.activeId === id) {
      this.activeId = this.lists[0].id;
    }
    for (const [p, listId] of this.assignment) {
      if (listId === id) {
        this.assignment.set(p, this.activeId);
      }
    }
  }

  setActive(id: string): void {
    this.activeId = this.require(id).id;
  }

  move(paths: string[], id: string): void {
    this.require(id);
    paths.forEach((p) => this.assignment.set(p, id));
  }

  toJSON(): ChangelistData {
    return {
      lists: this.lists.map((l) => ({ ...l })),
      activeId: this.activeId,
      assignment: Object.fromEntries(this.assignment),
    };
  }

  private require(id: string): Changelist {
    const list = this.get(id);
    if (!list) {
      throw new Error(`Unknown changelist ${id}`);
    }
    return list;
  }

  private assertUniqueName(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Changelist name must not be empty.');
    }
    if (this.lists.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`A changelist named '${trimmed}' already exists.`);
    }
  }
}
