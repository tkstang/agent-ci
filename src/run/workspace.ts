import { execFile } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import { failure, success, type Result } from '@agent-ci/result.js';

/** Symlink hops allowed while resolving one path (as in POSIX MAXSYMLINKS). */
const MAX_SYMLINK_HOPS = 40;

export class PathResolutionError extends Error {
  override readonly name = 'PathResolutionError';
}

/** Raw path segments, WITHOUT lexical normalization ('..' is kept). */
function rawSegments(text: string): string[] {
  return text.split(path.sep).filter((part) => part !== '' && part !== '.');
}

export interface PhysicalPath {
  /** Canonical real path (on-disk case for existing components). */
  readonly real: string;
  /** Canonical locations of every symlink traversed on the way. */
  readonly links: readonly string[];
}

/**
 * Resolve a path the way the filesystem does, component by component:
 *
 * - every existing component is canonicalized by `fs.promises.realpath`
 *   (physical, and on-disk letter case on case-insensitive volumes);
 * - a symlink (dangling ones included) is expanded from its raw link text, so
 *   a `..` after it applies to the link's resolved target, never lexically;
 * - the first missing component ends the walk: the remainder is appended
 *   as-is, and a remainder containing `..` is rejected (it cannot be
 *   resolved physically);
 * - more than 40 link hops (a loop) is rejected.
 *
 * Relative inputs are taken against `process.cwd()` without normalizing.
 * Throws `PathResolutionError`; callers fail closed.
 */
export async function resolvePhysical(target: string): Promise<PhysicalPath> {
  const raw = path.isAbsolute(target)
    ? target
    : `${process.cwd()}${path.sep}${target}`;
  let current = path.parse(raw).root;
  const queue = rawSegments(raw.slice(current.length));
  const links: string[] = [];
  while (queue.length > 0) {
    const part = queue.shift() ?? '';
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, part);
    let info;
    try {
      info = await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PathResolutionError(
          `cannot inspect ${candidate} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
        );
      }
      if (queue.includes('..')) {
        throw new PathResolutionError(
          `cannot resolve '..' below the missing component ${candidate}`,
        );
      }
      return { real: path.join(candidate, ...queue), links };
    }
    if (info.isSymbolicLink()) {
      links.push(candidate);
      if (links.length > MAX_SYMLINK_HOPS) {
        throw new PathResolutionError(`too many symlinks resolving ${target}`);
      }
      const text = await readlink(candidate);
      if (path.isAbsolute(text)) current = path.parse(text).root;
      queue.unshift(
        ...rawSegments(
          text.slice(path.isAbsolute(text) ? path.parse(text).root.length : 0),
        ),
      );
      continue;
    }
    // Not a link: let the filesystem name it (canonical case).
    current = await realpath(candidate);
  }
  return { real: current, links };
}

/** The canonical real path of `target` (see `resolvePhysical`). */
export async function resolveRealPath(target: string): Promise<string> {
  return (await resolvePhysical(target)).real;
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
