// Interactive rebase todo generation and validation (no vscode imports, unit-tested).

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseEntry {
  sha: string;
  action: RebaseAction;
  /** New full message for 'reword'. */
  message?: string;
}

/** Returns an error message, or undefined when the plan can be executed. */
export function validateEntries(entries: RebaseEntry[]): string | undefined {
  const kept = entries.filter((e) => e.action !== 'drop');
  if (kept.length === 0) {
    return 'At least one commit must be kept. To remove all of them, use "Reset Current Branch to Here" instead.';
  }
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') {
    return `The first kept commit (${kept[0].sha.slice(0, 8)}) cannot be squashed or fixed up: there is no earlier commit to combine it with.`;
  }
  const emptyReword = entries.find((e) => e.action === 'reword' && !e.message?.trim());
  if (emptyReword) {
    return `Enter a new message for ${emptyReword.sha.slice(0, 8)}.`;
  }
  return undefined;
}

/** POSIX shell single-quoting (git runs `exec` lines with sh). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the git-rebase-todo content. Rewording is done with `pick` + `exec git commit --amend`
 * using a prepared message file, so no editor has to be opened.
 */
export function buildTodo(entries: RebaseEntry[], messageFile: (index: number) => string): string {
  const lines: string[] = [];
  entries.forEach((e, i) => {
    if (e.action === 'reword') {
      lines.push(`pick ${e.sha}`);
      lines.push(`exec git commit --amend --only --no-verify --allow-empty -F ${shellQuote(messageFile(i))}`);
    } else {
      lines.push(`${e.action} ${e.sha}`);
    }
  });
  return lines.join('\n') + '\n';
}
