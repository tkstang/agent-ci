import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { SAFE_GIT_ENV, safeGitArgs } from '@agent-ci/git/safe-git.js';
import { failure, type Result, success } from '@agent-ci/result.js';
import { isWithin, resolvePhysical } from '@agent-ci/run/workspace.js';

/**
 * Committed symlinks that leave the repository. A reviewer reads the PR
 * head while the model credential is in its process environment; a PR that
 * commits `notes.md -> /proc/self/environ` (or any link out of the
 * checkout) would hand that file to the reviewer's read tools, which allow
 * workspace paths. Review passes refuse such a head.
 *
 * Each tracked link (`git ls-files -s`, mode 120000) and each untracked link
 * is resolved physically,
 * component by component through every link on the way (so `b -> .` plus
 * `a -> b/../x` is caught, dangling or not); a path that cannot be resolved
 * (a loop, `..` below a missing component) counts as leaving.
 */

function gitLsFiles(
  root: string,
  git: string,
  args: readonly string[],
): Promise<Result<string>> {
  return new Promise((resolve) => {
    const child = execFile(
      git,
      safeGitArgs(['ls-files', '-z', ...args]),
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...SAFE_GIT_ENV },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(success(String(stdout)));
        else
          resolve(
            failure(
              'E_WORKSPACE_STATUS',
              `cannot list the checkout: ${String(stderr).trim().split('\n')[0] || error.message}`,
            ),
          );
      },
    );
    child.stdin?.end();
  });
}

/** The first symlink in the checkout that resolves outside `root`, if any. */
export async function escapingLink(
  root: string,
  git = 'git',
): Promise<Result<string | undefined>> {
  const tracked = await gitLsFiles(root, git, ['-s']);
  if (!tracked.ok) return tracked;
  const untracked = await gitLsFiles(root, git, ['-o']);
  if (!untracked.ok) return untracked;
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return failure('E_WORKSPACE_STATUS', `cannot resolve ${root}`);
  }
  const candidates: string[] = [];
  for (const entry of tracked.value.split('\u0000')) {
    // `<mode> <object> <stage>\t<path>`; 120000 is a symlink.
    const tab = entry.indexOf('\t');
    if (entry.startsWith('120000 ') && tab !== -1)
      candidates.push(entry.slice(tab + 1));
  }
  // A fresh checkout has no untracked files; anything else is checked too.
  for (const relative of untracked.value.split('\u0000')) {
    if (relative === '') continue;
    try {
      if ((await lstat(path.join(realRoot, relative))).isSymbolicLink())
        candidates.push(relative);
    } catch {
      candidates.push(relative);
    }
  }
  for (const relative of candidates) {
    const full = path.join(realRoot, relative);
    try {
      // Physical resolution through every link on the way; a missing tail
      // is kept as written (and `..` below a missing component throws).
      const { real } = await resolvePhysical(full);
      if (!isWithin(realRoot, real)) return success(relative);
    } catch {
      return success(relative);
    }
  }
  return success(undefined);
}
