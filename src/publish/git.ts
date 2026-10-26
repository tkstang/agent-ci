import { spawn } from 'node:child_process';

import { SAFE_GIT_ENV, safeGitArgs } from '@agent-ci/git/safe-git.js';

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git in one repository; `input` is written to stdin, else stdin is closed. */
export type GitRunner = (
  args: readonly string[],
  options?: {
    readonly input?: string | Buffer;
    readonly env?: Readonly<Record<string, string>>;
  },
) => Promise<GitResult>;

const MAX_OUTPUT = 16 * 1024 * 1024;

export function createGit(
  cwd: string,
  baseEnv: Readonly<Record<string, string | undefined>>,
  command = 'git',
): GitRunner {
  return (args, options = {}) =>
    new Promise((resolve) => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(baseEnv)) {
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, options.env ?? {}, SAFE_GIT_ENV, { LC_ALL: 'C' });
      // The publisher talks to the remote (fetch, ls-remote, push); every
      // other neutralizing setting applies.
      const child = spawn(command, safeGitArgs(args, { network: true }), {
        cwd,
        env,
        stdio: [
          options.input === undefined ? 'ignore' : 'pipe',
          'pipe',
          'pipe',
        ],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT) into.push(chunk);
      };
      child.stdout?.on('data', collect(out));
      child.stderr?.on('data', collect(err));
      child.on('error', (error) =>
        resolve({ code: null, stdout: '', stderr: error.message }),
      );
      child.on('close', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
}

/** First line of a git failure, for error messages. */
export function gitError(result: GitResult): string {
  return (
    result.stderr.trim().split('\n').at(-1) ??
    `git exited with ${result.code ?? 'no code'}`
  ).slice(0, 300);
}
