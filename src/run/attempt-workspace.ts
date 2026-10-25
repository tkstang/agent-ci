import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { failure, success, type Result } from '@agent-ci/result.js';
import { isWithin, resolveRealPath } from '@agent-ci/run/workspace.js';

/**
 * Per-attempt workspace isolation for edit runs, after pntr's supervisor:
 * every attempt runs in a fresh copy of the pre-run repository, and only the
 * successful attempt's changes are promoted into the real workspace. A failed
 * attempt's partial edits are discarded with its copy, so they never reach a
 * retry or the published result.
 */

export type IsolationSupport =
  | { readonly mode: 'copy' }
  | { readonly mode: 'unavailable'; readonly reason: string };

/**
 * A copy is trustworthy only for a repository whose `.git` is a directory.
 * A `.git` file (linked worktree, submodule) points at a shared git
 * directory, so the copy would share the original's index and HEAD; outside
 * git, changes cannot be detected and so cannot be promoted.
 */
export async function isolationSupport(
  boundaryRoot: string,
  git: boolean,
): Promise<IsolationSupport> {
  if (!git) {
    return {
      mode: 'unavailable',
      reason: 'the workspace is not a git repository',
    };
  }
  try {
    const info = await lstat(path.join(boundaryRoot, '.git'));
    if (info.isDirectory()) return { mode: 'copy' };
    return {
      mode: 'unavailable',
      reason:
        'the repository .git is not a directory (linked worktree or submodule)',
    };
  } catch {
    return { mode: 'unavailable', reason: 'the repository .git is missing' };
  }
}

export interface AttemptWorkspace {
  /** Real path of the copy's repository root. */
  readonly root: string;
  /** The attempt's working directory inside the copy. */
  readonly cwd: string;
  /** The output directory's location inside the copy (excluded from changes). */
  readonly outDir: string;
  /** Remove the copy. */
  dispose(): Promise<void>;
}

export interface CreateAttemptWorkspaceOptions {
  /** Real path of the repository root (the workspace boundary). */
  readonly boundaryRoot: string;
  /** The run's working directory (inside the boundary). */
  readonly cwd: string;
  /** Canonical output directory; not copied when inside the boundary. */
  readonly outDir: string;
  /** Real path of the home root; the copy must be disjoint from it. */
  readonly homeRoot: string;
  readonly attempt: number;
  /** Parent directory for copies (default: the system temp directory). */
  readonly parentDir?: string;
}

const disjoint = (a: string, b: string): boolean =>
  !isWithin(a, b) && !isWithin(b, a);

/**
 * Copy the repository into a fresh private directory. Symlinks are copied as
 * links; an absolute link into the repository is retargeted into the copy so
 * an attempt cannot write the original through it. Sockets, FIFOs and device
 * files are not copied (git does not track them).
 */
export async function createAttemptWorkspace(
  options: CreateAttemptWorkspaceOptions,
): Promise<Result<AttemptWorkspace>> {
  let base: string;
  try {
    base = await resolveRealPath(
      await mkdtemp(
        path.join(
          options.parentDir ?? os.tmpdir(),
          `agent-ci-attempt-${options.attempt}-`,
        ),
      ),
    );
  } catch (err) {
    return failure(
      'E_WORKSPACE_STATUS',
      `could not create the attempt workspace (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  const dispose = () => rm(base, { recursive: true, force: true });
  if (
    !disjoint(base, options.boundaryRoot) ||
    !disjoint(base, options.homeRoot)
  ) {
    await dispose();
    return failure(
      'E_WORKSPACE_STATUS',
      'the attempt workspace would overlap the repository or the home root',
      'Run with TMPDIR outside the repository and the home root.',
    );
  }
  const root = path.join(base, 'repo');
  const skip = isWithin(options.boundaryRoot, options.outDir)
    ? options.outDir
    : undefined;
  try {
    await copyTree(options.boundaryRoot, root, skip);
  } catch (err) {
    await dispose();
    return failure(
      'E_WORKSPACE_STATUS',
      `could not copy the repository for an isolated attempt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const rel = path.relative(options.boundaryRoot, options.cwd);
  return success({
    root,
    cwd: rel === '' ? root : path.join(root, rel),
    outDir: path.join(
      root,
      path.relative(options.boundaryRoot, options.outDir),
    ),
    dispose,
  });
}

async function copyTree(
  originalRoot: string,
  copyRoot: string,
  skip: string | undefined,
): Promise<void> {
  await mkdir(copyRoot, { recursive: true, mode: 0o700 });
  const pending: [string, string][] = [[originalRoot, copyRoot]];
  while (pending.length > 0) {
    const [src, dst] = pending.pop() ?? [originalRoot, copyRoot];
    const entries: Dirent[] = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (skip !== undefined && s === skip) continue;
      if (entry.isDirectory()) {
        const info = await lstat(s);
        await mkdir(d, { mode: (info.mode & 0o777) | 0o700 });
        pending.push([s, d]);
      } else if (entry.isFile()) {
        await copyFile(s, d, constants.COPYFILE_FICLONE);
        await chmod(d, (await lstat(s)).mode & 0o777);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(s);
        const absolute = path.isAbsolute(target) ? path.resolve(target) : '';
        await symlink(
          absolute !== '' && isWithin(originalRoot, absolute)
            ? path.join(copyRoot, path.relative(originalRoot, absolute))
            : target,
          d,
        );
      }
      // sockets, FIFOs and devices are skipped
    }
  }
}

/** A repository-relative path that may be promoted. */
function safeRelative(file: string): boolean {
  if (file === '' || file.endsWith('/') || path.isAbsolute(file)) return false;
  const parts = file.split('/');
  return !parts.some(
    (part) => part === '' || part === '.' || part === '..' || part === '.git',
  );
}

type Kind = 'file' | 'link' | 'missing' | 'other';

async function kindOf(file: string): Promise<Kind> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return 'link';
    if (info.isFile()) return 'file';
    return 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
}

/**
 * Every existing directory component between the repository root and the
 * file must be a real directory, so nothing is read, removed or written
 * through a link. With `create`, missing components are created; without it,
 * a missing component returns false (nothing below it exists).
 */
async function checkParents(
  root: string,
  file: string,
  create: boolean,
): Promise<boolean> {
  const parts = file.split('/').slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (info === undefined) {
      if (!create) return false;
      await mkdir(current);
    } else if (!info.isDirectory()) {
      throw new Error(
        `${path.relative(root, current)} is not a directory in the workspace`,
      );
    }
  }
  return true;
}

/**
 * Promote an attempt's changes (repository-relative paths reported by change
 * detection in the copy) into the real repository: deletions first, then
 * files and links. Nothing is written through a symlinked directory; any
 * path that cannot be promoted exactly fails the run.
 */
export async function promoteChanges(
  copyRoot: string,
  boundaryRoot: string,
  changed: readonly string[],
): Promise<Result<readonly string[]>> {
  const unsafe = changed.find((file) => !safeRelative(file));
  if (unsafe !== undefined) {
    return failure(
      'E_WORKSPACE_STATUS',
      `cannot promote the attempt change ${JSON.stringify(unsafe)}`,
    );
  }
  try {
    const kinds = new Map<string, Kind>();
    for (const file of changed) {
      const kind = await kindOf(path.join(copyRoot, file));
      if (kind === 'other') {
        throw new Error(`${file} is not a file or symlink in the attempt`);
      }
      kinds.set(file, kind);
    }
    // Deletions first: a path may change from a file or link to a directory.
    for (const file of changed) {
      if (kinds.get(file) !== 'missing') continue;
      if (!(await checkParents(boundaryRoot, file, false))) continue;
      const target = path.join(boundaryRoot, file);
      const existing = await kindOf(target);
      if (existing === 'other') {
        throw new Error(`${file} is a directory in the workspace`);
      }
      if (existing !== 'missing') await rm(target);
    }
    for (const file of changed) {
      const kind = kinds.get(file);
      if (kind === 'missing') continue;
      const source = path.join(copyRoot, file);
      const target = path.join(boundaryRoot, file);
      await checkParents(boundaryRoot, file, true);
      if ((await kindOf(target)) === 'other') {
        throw new Error(`${file} is a directory in the workspace`);
      }
      await rm(target, { force: true });
      if (kind === 'link') {
        await symlink(await readlink(source), target);
      } else {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        await chmod(target, (await lstat(source)).mode & 0o777);
      }
    }
  } catch (err) {
    return failure(
      'E_WORKSPACE_STATUS',
      `could not promote the attempt's changes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return success(changed);
}
