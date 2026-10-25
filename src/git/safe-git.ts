import { execFile } from 'node:child_process';

/**
 * The only way agent-ci runs git. Command-line `-c` settings outrank every
 * config file (system, global, the repository's own `.git/config` and its
 * `include`/`includeIf` files). What is neutralized, precisely:
 *
 * - `core.fsmonitor=false`: no fsmonitor command runs;
 * - `core.hooksPath=/dev/null`: no hook runs (for example
 *   `post-index-change` during a status refresh, or `pre-push`);
 * - `core.untrackedCache=false`: no cache written into the repository;
 * - `core.attributesFile=/dev/null` and `GIT_ATTR_SOURCE=<empty tree>`
 *   (git 2.42+): no attributes from the global file or the worktree;
 * - filter drivers: before `status`, every configured `filter.<name>` is
 *   overridden with empty `clean`/`smudge`/`process` and `required=false`
 *   (`filterDriverOverrides`), because `.git/info/attributes` still applies
 *   and a configured driver would run on a clean-filter comparison;
 * - `protocol.allow=never` for local-only calls: no transport (and no
 *   `core.sshCommand`, proxy or credential helper) can start.
 *
 * Not neutralized: settings that only matter to commands agent-ci does not
 * run (diff/textconv, merge drivers, pagers). The environment skips system
 * config and attributes and never prompts.
 */

/** The empty tree: an attribute source with no attributes. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const SAFE_GIT_CONFIG: readonly string[] = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
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
  GIT_ATTR_SOURCE: EMPTY_TREE,
  GIT_TERMINAL_PROMPT: '0',
};

const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/iu;

/** `-c` overrides that disable each configured filter driver. */
export function overridesFor(configOutput: string): string[] {
  const names = new Set<string>();
  for (const record of configOutput.split('\0')) {
    const key = record.split('\n')[0] ?? '';
    const match = FILTER_KEY.exec(key);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names]
    .toSorted()
    .flatMap((name) => [
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.smudge=`,
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.required=false`,
    ]);
}

/**
 * List the filter drivers configured for `cwd` (reading config executes
 * nothing) and return the overrides that disable them. Rejects with the
 * stderr line when git fails for another reason than "no match".
 */
export function filterDriverOverrides(
  cwd: string,
  git = 'git',
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      git,
      safeGitArgs(['config', '-z', '--get-regexp', '^filter\\.']),
      {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...SAFE_GIT_ENV },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(overridesFor(String(stdout)));
          return;
        }
        // Exit 1 with no output: no filter configured.
        if (error.code === 1 && String(stderr).trim() === '') {
          resolve([]);
          return;
        }
        reject(
          new Error(
            String(stderr).trim().split('\n')[0] || 'git config failed',
          ),
        );
      },
    );
    child.stdin?.end();
  });
}
