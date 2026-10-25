import { execFile } from 'node:child_process';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

import { failure, success, type Result } from '@agent-ci/result.js';

/** Symlink hops allowed while resolving one path (as in POSIX MAXSYMLINKS). */
const MAX_SYMLINK_HOPS = 40;

export class PathResolutionError extends Error {
  override readonly name = 'PathResolutionError';
}

function components(absolute: string): { root: string; parts: string[] } {
  const { root } = path.parse(absolute);
  return {
    root,
    parts: absolute.slice(root.length).split(path.sep).filter(Boolean),
  };
}

/**
 * The real path of `target`, following symlinks at EVERY component, dangling
 * ones included: a link whose target does not exist yet still resolves to
 * where a write through it would land. Components that do not exist are
 * appended lexically, so a home root about to be created compares correctly
 * with resolved paths (`/tmp` vs `/private/tmp` on macOS). Throws
 * `PathResolutionError` on a symlink loop; callers fail closed.
 */
export async function resolveRealPath(target: string): Promise<string> {
  const start = components(path.resolve(target));
  let current = start.root;
  const queue = [...start.parts];
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() ?? '';
    if (part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    let isLink = false;
    try {
      isLink = (await lstat(next)).isSymbolicLink();
    } catch {
      // Missing from here on: the rest of the path is lexical.
      return path.resolve(next, ...queue);
    }
    if (!isLink) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) {
      throw new PathResolutionError(`too many symlinks resolving ${target}`);
    }
    const link = await readlink(next);
    const resolved = components(path.resolve(current, link));
    current = resolved.root;
    queue.unshift(...resolved.parts);
  }
  return current;
}

/**
 * True when `child` is `parent` or inside it. Both must be real, absolute
 * paths. Compares whole path segments: only an exact `..` first segment
 * leaves the parent, so a child named `..agent-home` is inside.
 */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] !== '..';
}

/** The nearest ancestor of `start` (inclusive) that contains a `.git` entry. */
async function nearestGitAncestor(start: string): Promise<string | undefined> {
  let current = start;
  for (;;) {
    try {
      await lstat(path.join(current, '.git'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export interface WorkspaceRoot {
  /** Real path of the repository top level, or of the workspace outside git. */
  readonly root: string;
  /** True when git status can be read for this workspace. */
  readonly git: boolean;
}

/**
 * The boundary a run works in. Inside a repository: its top level (git status
 * paths are relative to it). When git reports "not a git repository", the
 * nearest ancestor holding a `.git` entry still counts as the boundary
 * (a damaged or foreign repository is still a repository), else the
 * workspace itself. Any other git failure (git missing, a `safe.directory`
 * refusal) is `E_WORKSPACE_STATUS`: the boundary is unknown, and callers
 * must not substitute the workspace for it.
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
          try {
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
              const real = await resolveRealPath(cwd);
              const repository = await nearestGitAncestor(real);
              resolve(success({ root: repository ?? real, git: false }));
              return;
            }
            const reason =
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'git is not installed'
                : text.trim().split('\n')[0] || error.message;
            resolve(
              failure(
                'E_WORKSPACE_STATUS',
                `could not establish the workspace boundary: ${reason}`,
                'Fix git access to the workspace (for example safe.directory); agent-ci will not guess where the repository ends.',
              ),
            );
          } catch (err) {
            resolve(
              failure(
                'E_WORKSPACE_STATUS',
                `could not resolve the workspace path: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        })();
      },
    );
    child.stdin?.end();
  });
}
