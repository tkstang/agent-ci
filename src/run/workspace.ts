import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * The real path of `target`, resolving symlinks through its nearest existing
 * ancestor, so paths that do not exist yet (a home root about to be created)
 * compare correctly with resolved ones (`/tmp` vs `/private/tmp` on macOS).
 */
export async function resolveRealPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...missing.toReversed());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` is `parent` or inside it (both real, absolute paths). */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export interface WorkspaceRoot {
  /** Real path of the git top level, or of the workspace outside git. */
  readonly root: string;
  readonly git: boolean;
}

/**
 * The boundary a run works in: the repository top level (git status paths
 * are relative to it), or the workspace itself when it is not a git
 * repository. Git failures other than "not a git repository" are errors.
 */
export function findWorkspaceRoot(
  cwd: string,
  git = 'git',
): Promise<Result<WorkspaceRoot>> {
  return new Promise((resolve) => {
    const child = execFile(
      git,
      ['rev-parse', '--show-toplevel'],
      { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
      (error, stdout, stderr) => {
        void (async () => {
          if (error === null) {
            resolve(
              success({
                root: await resolveRealPath(String(stdout).trim()),
                git: true,
              }),
            );
            return;
          }
          const text = String(stderr);
          if (/not a git repository/iu.test(text)) {
            resolve(success({ root: await resolveRealPath(cwd), git: false }));
            return;
          }
          const reason =
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'git is not installed'
              : text.trim().split('\n')[0] || error.message;
          resolve(
            failure(
              'E_WORKSPACE_STATUS',
              `could not read workspace changes: ${reason}`,
              'Fix git access to the workspace (for example safe.directory) so changes can be detected.',
            ),
          );
        })();
      },
    );
    child.stdin?.end();
  });
}
