import * as vscode from 'vscode';
import { GitError } from '../git/gitCli';

let console: vscode.OutputChannel | undefined;

export function gitConsole(): vscode.OutputChannel {
  console ??= vscode.window.createOutputChannel('Git (JB) Console');
  return console;
}

/** Runs `task` with a progress notification; reports git errors with a link to the console. */
export async function runWithProgress<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      task,
    );
  } catch (e) {
    await showGitError(title, e);
    return undefined;
  }
}

export async function showGitError(title: string, e: unknown): Promise<void> {
  const message = e instanceof GitError || e instanceof Error ? e.message : String(e);
  const choice = await vscode.window.showErrorMessage(`${title} failed: ${firstLines(message, 4)}`, 'Show Console');
  if (choice === 'Show Console') {
    gitConsole().show(true);
  }
}

function firstLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(0, n).join(' ') + (lines.length > n ? ' …' : '');
}

export async function confirm(message: string, action: string, detail?: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}
