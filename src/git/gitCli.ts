import { spawn } from 'child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly result: GitResult) {
    super(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed with exit code ${result.exitCode}`);
  }
}

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  /** Resolve instead of throwing on a non-zero exit code. */
  allowFailure?: boolean;
}

export type GitLogger = (line: string) => void;

/** Thin wrapper around the git binary. No vscode imports, so it is unit-testable. */
export class GitCli {
  constructor(private readonly gitPath: string, private readonly log: GitLogger = () => undefined) {}

  async exec(cwd: string, args: string[], options: ExecOptions = {}): Promise<GitResult> {
    const started = Date.now();
    const result = await new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env },
        signal: options.signal,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode: code ?? -1,
        }),
      );
      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
    this.log(`[${new Date().toLocaleTimeString()}] git ${args.join(' ')}  (${Date.now() - started} ms, exit ${result.exitCode})`);
    if (result.exitCode !== 0) {
      if (result.stderr.trim()) {
        this.log(result.stderr.trimEnd());
      }
      if (!options.allowFailure) {
        throw new GitError(args, result);
      }
    }
    return result;
  }

  async out(cwd: string, args: string[], options?: ExecOptions): Promise<string> {
    return (await this.exec(cwd, args, options)).stdout;
  }
}
