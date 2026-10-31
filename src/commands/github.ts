import { appendFile } from 'node:fs/promises';

import { CliError } from '@agent-ci/errors.js';

/**
 * GitHub Actions step files. Values are single-line by construction; a
 * newline would let one value forge another key, so it is refused.
 */

function stepFile(
  env: Readonly<Record<string, string | undefined>>,
  name: 'GITHUB_OUTPUT' | 'GITHUB_PATH',
): string {
  const file = env[name];
  if (file === undefined || file === '') {
    throw new CliError(
      'E_INVALID_INPUT',
      `${name} is not set; this flag only works inside a GitHub Actions step`,
    );
  }
  return file;
}

/** Append `key=value` lines to `$GITHUB_OUTPUT`. */
export async function appendGithubOutput(
  env: Readonly<Record<string, string | undefined>>,
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || /[\r\n]/u.test(value)) {
      throw new CliError(
        'E_INVALID_INPUT',
        `refusing to write the step output ${key}: keys are snake_case and values single-line`,
      );
    }
    lines.push(`${key}=${value}`);
  }
  await appendFile(stepFile(env, 'GITHUB_OUTPUT'), `${lines.join('\n')}\n`);
}

/** Prepend a directory to PATH for later steps (`$GITHUB_PATH`). */
export async function appendGithubPath(
  env: Readonly<Record<string, string | undefined>>,
  dir: string,
): Promise<void> {
  if (/[\r\n]/u.test(dir)) {
    throw new CliError('E_INVALID_INPUT', 'refusing a multi-line PATH entry');
  }
  await appendFile(stepFile(env, 'GITHUB_PATH'), `${dir}\n`);
}
