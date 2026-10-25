/**
 * The only way agent-ci runs git. Command-line `-c` settings outrank every
 * config file (system, global, the repository's own `.git/config` and its
 * `include`/`includeIf` files), so a repository (or an agent that rewrote
 * `.git/config`) cannot make agent-ci's own git calls run code:
 *
 * - `core.fsmonitor=false`: `git status` would otherwise run the configured
 *   fsmonitor command;
 * - `core.hooksPath=/dev/null`: no hook (for example `post-index-change`,
 *   run when status refreshes the index, or `pre-push`) runs;
 * - `core.untrackedCache=false`: no cache written into the repository;
 * - `protocol.allow=never` for local-only calls: no transport (and no
 *   `core.sshCommand`, proxy or credential helper) can start.
 *
 * The environment skips system config and attributes and never prompts.
 */

export const SAFE_GIT_CONFIG: readonly string[] = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.untrackedCache=false',
];

export interface SafeGitOptions {
  /** The call talks to a remote (fetch, ls-remote, push). Default false. */
  readonly network?: boolean;
}

/** Arguments to run `git` with: neutralizing config first, then `args`. */
export function safeGitArgs(
  args: readonly string[],
  options: SafeGitOptions = {},
): string[] {
  const config = [
    ...SAFE_GIT_CONFIG,
    ...(options.network === true ? [] : ['protocol.allow=never']),
  ];
  return [...config.flatMap((entry) => ['-c', entry]), ...args];
}

/** Environment additions for every git process agent-ci starts. */
export const SAFE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
