import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SAFE_GIT_ENV, safeGitArgs } from '@agent-ci/git/safe-git.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import {
  isWithin,
  resolvePhysical,
  resolveRealPath,
} from '@agent-ci/run/workspace.js';

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
  skipDir?: string,
): Promise<IsolationSupport> {
  if (!git) {
    return {
      mode: 'unavailable',
      reason: 'the workspace is not a git repository',
    };
  }
  try {
    const info = await lstat(path.join(boundaryRoot, '.git'));
    if (!info.isDirectory()) {
      return {
        mode: 'unavailable',
        reason:
          'the repository .git is not a directory (linked worktree or submodule)',
      };
    }
  } catch {
    return { mode: 'unavailable', reason: 'the repository .git is missing' };
  }
  // Copies keep link text byte-for-byte; an absolute link into the
  // repository would then let an attempt write the original through it.
  try {
    const link = await findAbsoluteInRepoLink(boundaryRoot, skipDir);
    if (link !== undefined) {
      return {
        mode: 'unavailable',
        reason: `${path.relative(boundaryRoot, link)} is a symlink a copy cannot isolate (absolute into the repository, or climbing out of it)`,
      };
    }
  } catch {
    return {
      mode: 'unavailable',
      reason: 'the repository could not be scanned for symlinks',
    };
  }
  return { mode: 'copy' };
}

/** True when an absolute link target points into `root` (lexically or physically). */
async function pointsInto(root: string, target: string): Promise<boolean> {
  if (!path.isAbsolute(target)) return false;
  if (isWithin(root, path.resolve(target))) return true;
  try {
    return isWithin(root, await resolveRealPath(target));
  } catch {
    return false;
  }
}

/**
 * True when a relative target, walked segment by segment from the link's
 * directory, climbs above the repository root. From a copy at another depth
 * such a link resolves differently, and with enough `..` segments it can
 * reach the original repository (review p02 L1).
 */
function climbsOut(root: string, link: string, target: string): boolean {
  if (path.isAbsolute(target)) return false;
  let depth = path
    .relative(root, path.dirname(link))
    .split(path.sep)
    .filter(Boolean).length;
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

/**
 * The first symlink under `root` that a copy cannot isolate: an absolute
 * target inside the repository, a relative target that climbs out of it, or
 * any link whose real path lands inside the repository from outside.
 */
async function findAbsoluteInRepoLink(
  root: string,
  skipDir: string | undefined,
): Promise<string | undefined> {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() ?? root;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (full === skipDir || (dir === root && entry.name === '.git')) continue;
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        if ((await pointsInto(root, target)) || climbsOut(root, full, target)) {
          return full;
        }
      }
    }
  }
  return undefined;
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
 * Copy the repository into a fresh private directory. Symlinks are copied
 * byte-for-byte (`isolationSupport` refuses repositories with absolute links
 * into themselves, which an attempt could write the original through).
 * Sockets, FIFOs and device files are not copied (git does not track them).
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
        // Byte-for-byte: an unchanged link must stay unchanged.
        await symlink(await readlink(s), d);
      }
      // sockets, FIFOs and devices are skipped
    }
  }
}

/**
 * Copy-isolation qualification, run on every finished copy. The rule is
 * deliberately simple and conservative (phase gate p02 H1):
 *
 * 1. every symlink anywhere in the copy, the copied `.git` included,
 *    resolves physically (chains, `..` after links) inside the copy root
 *    (the root itself included);
 * 2. every git metadata pointer in the copy resolves inside the copy root,
 *    first as a cheap file-level screen (`core.worktree` in any `config` or
 *    `config.worktree` under a `.git` directory or any other git directory, the `gitdir`/`commondir`
 *    pointer files there, and `gitdir:` in any `.git` file in the worktree),
 *    then authoritatively by asking git itself (phase gate p02 round 2 H1):
 *    for the copy root and every directory holding a `.git` entry,
 *    `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir` and
 *    `--show-superproject-working-tree`; for every git directory anywhere in
 *    the copy (`.git`, `.git/modules/*`, a nested `tool.git`, ...; any
 *    directory with a `HEAD` plus `config`, `objects`, `commondir` or
 *    `gitdir`, links included), its effective `core.worktree` (config,
 *    `config.worktree` under `extensions.worktreeConfig`, and includes, as
 *    git reads them), `--git-common-dir`, and what git discovers when run
 *    from inside it (`--absolute-git-dir`, `--git-common-dir`,
 *    `--show-toplevel`). Every answer must resolve inside the copy root; any
 *    git error fails closed (a missing toplevel is accepted only when no
 *    `core.worktree` is configured).
 *
 * Why this is enough: walk any path that descends from the copy root (no
 * `..` segment). Every real directory or file the copy holds is inside it;
 * every symlink met on the way is resolved from its own location, which is
 * inside the copy, and by (1) lands inside the copy; so by induction every
 * step stays inside. Git commands run in the copy operate on the work tree
 * and git directories git itself reports, inside the copy by (2), so they
 * cannot write elsewhere either. A write through the copy can therefore
 * never change the original (or any ancestor or other location). agent-ci's
 * own git calls in a copy additionally pin `GIT_DIR`/`GIT_WORK_TREE` to it.
 * Not covered, by design: paths an agent constructs to climb above the
 * copy (`../..`) or absolute paths. An edit agent is not filesystem
 * sandboxed; isolation is about discarding failed attempts, not containment.
 *
 * Returns the reason the copy does not qualify, or undefined.
 */
export async function copyIsolationProblem(
  copyRoot: string,
  git = 'git',
): Promise<string | undefined> {
  const root = await resolveRealPath(copyRoot);
  const inside = async (target: string): Promise<boolean> => {
    try {
      const real = (await resolvePhysical(target)).real;
      return isWithin(root, real);
    } catch {
      return false;
    }
  };
  const pending: { dir: string; inGitDir: boolean }[] = [
    { dir: root, inGitDir: false },
  ];
  // Directories git treats as a work tree root, and git directories.
  const worktrees: string[] = [root];
  const gitDirs: string[] = [];
  while (pending.length > 0) {
    const popped = pending.pop() ?? { dir: root, inGitDir: false };
    const { dir } = popped;
    const entries = await readdir(dir, { withFileTypes: true });
    // A git directory anywhere, not only under `.git` (for example a
    // `fixtures/tool.git` with `core.worktree`): git run from inside it
    // uses it as the repository (phase review r5 M1).
    const isGitDir = isGitDirectory(entries);
    if (isGitDir) gitDirs.push(dir);
    const inGitDir = popped.inGitDir || isGitDir;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.name === '.git' && !inGitDir && dir !== root) {
        worktrees.push(dir);
      }
      if (entry.isSymbolicLink()) {
        if (!(await inside(full))) {
          return `${rel} is a symlink that does not resolve inside the copy`;
        }
      } else if (entry.isDirectory()) {
        pending.push({
          dir: full,
          inGitDir: inGitDir || entry.name === '.git',
        });
      } else if (entry.isFile()) {
        const pointer = await gitPointer(full, entry.name, inGitDir, git);
        if (pointer !== undefined && !(await inside(pointer))) {
          return `${rel} points git outside the copy`;
        }
      }
    }
  }
  return gitAnswerProblem(root, worktrees, gitDirs, inside, git);
}

/**
 * A git directory candidate, recognized conservatively (phase gate g2 M1):
 * a `HEAD` file or link together with any of `config`, `objects`,
 * `commondir` or `gitdir`, each as a file, directory or link. Git accepts
 * linked metadata (for example `objects -> ../../.git/objects`), so links
 * count; rule 1 has already required every link to stay in the copy.
 * `.git/logs`, which holds only `HEAD` and `refs/`, is not a candidate. A
 * candidate git cannot answer for refuses the copy.
 */
function isGitDirectory(entries: readonly Dirent[]): boolean {
  const names = new Set(
    entries
      .filter((e) => e.isFile() || e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name),
  );
  return (
    names.has('HEAD') &&
    ['config', 'objects', 'commondir', 'gitdir'].some((name) => names.has(name))
  );
}

/**
 * Rule 2, asked of git itself: what git would actually use from each work
 * tree root and git directory in the copy. Relative answers resolve against
 * the directory git ran in.
 */
async function gitAnswerProblem(
  root: string,
  worktrees: readonly string[],
  gitDirs: readonly string[],
  inside: (target: string) => Promise<boolean>,
  git: string,
): Promise<string | undefined> {
  const outside = async (cwd: string, answers: readonly string[]) => {
    for (const answer of answers) {
      if (!(await inside(path.resolve(cwd, answer)))) return answer;
    }
    return undefined;
  };
  for (const dir of worktrees) {
    const rel = path.relative(root, dir) || '.';
    const located = await gitOutput(
      git,
      [
        'rev-parse',
        '--show-toplevel',
        '--absolute-git-dir',
        '--git-common-dir',
      ],
      dir,
    );
    if (located === undefined || located.length !== 3) {
      return `git cannot locate the repository at ${rel} in the copy`;
    }
    const superproject = await gitOutput(
      git,
      ['rev-parse', '--show-superproject-working-tree'],
      dir,
    );
    if (superproject === undefined || superproject.length > 1) {
      return `git cannot locate the superproject of ${rel} in the copy`;
    }
    const escaped = await outside(dir, [...located, ...superproject]);
    if (escaped !== undefined) {
      return `git resolves ${rel} in the copy to ${escaped}, outside the copy`;
    }
  }
  for (const dir of gitDirs) {
    const rel = path.relative(root, dir);
    const worktree = await gitOutput(
      git,
      [`--git-dir=${dir}`, 'config', '--get', 'core.worktree'],
      dir,
      true,
    );
    const common = await gitOutput(
      git,
      [`--git-dir=${dir}`, 'rev-parse', '--git-common-dir'],
      dir,
    );
    // As the agent's git would see it from inside the directory: discovery
    // from the cwd, no inherited GIT_* (the reviewer's attack runs here).
    const discovered = await gitOutput(
      git,
      ['rev-parse', '--absolute-git-dir', '--git-common-dir'],
      dir,
    );
    const toplevel = await gitOutput(
      git,
      ['rev-parse', '--show-toplevel'],
      dir,
    );
    if (
      worktree === undefined ||
      common === undefined ||
      common.length !== 1 ||
      discovered === undefined ||
      discovered.length !== 2 ||
      // No work tree is an answer only when none is configured.
      (toplevel === undefined && worktree.length > 0) ||
      (toplevel !== undefined && toplevel.length !== 1)
    ) {
      return `git cannot read the git directory ${rel} in the copy`;
    }
    const escaped = await outside(dir, [
      ...worktree,
      ...common,
      ...discovered,
      ...(toplevel ?? []),
    ]);
    if (escaped !== undefined) {
      return `git directory ${rel} in the copy points git at ${escaped}, outside the copy`;
    }
  }
  return undefined;
}

/**
 * The non-empty output lines of one safe git call with no inherited `GIT_*`
 * environment, or undefined on any failure. With `unsetOk`, exit 1 (a
 * `config --get` miss) is an empty answer.
 */
function gitOutput(
  git: string,
  args: readonly string[],
  cwd: string,
  unsetOk = false,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const child = execFile(
      git,
      safeGitArgs([...args]),
      {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...SAFE_GIT_ENV },
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(unsetOk && error.code === 1 ? [] : undefined);
          return;
        }
        resolve(
          String(stdout)
            .split('\n')
            .filter((line) => line !== ''),
        );
      },
    );
    child.stdin?.end();
  });
}

/**
 * The path a git metadata file points at (absolute), or undefined when the
 * file is not a pointer.
 */
async function gitPointer(
  file: string,
  name: string,
  inGitDir: boolean,
  git: string,
): Promise<string | undefined> {
  const base = path.dirname(file);
  const resolve = (value: string) =>
    path.isAbsolute(value) ? value : `${base}${path.sep}${value}`;
  if (name === '.git' && !inGitDir) {
    const text = (await readFile(file, 'utf8')).trim();
    const match = /^gitdir:\s*(.+)$/mu.exec(text);
    // Unparseable: fail closed (the filesystem root is never inside).
    return match?.[1] === undefined ? '/' : resolve(match[1].trim());
  }
  if (!inGitDir) return undefined;
  if (name === 'gitdir' || name === 'commondir') {
    const value = (await readFile(file, 'utf8')).trim();
    return value === '' ? undefined : resolve(value);
  }
  if (name === 'config' || name === 'config.worktree') {
    const worktree = await configValue(file, 'core.worktree', git);
    return worktree === undefined ? undefined : resolve(worktree);
  }
  return undefined;
}

/** One value from a config file, read without executing anything. */
function configValue(
  file: string,
  key: string,
  git: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(
      git,
      safeGitArgs(['config', '--file', file, '--get', key]),
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...SAFE_GIT_ENV } },
      (error, stdout) => {
        const value = String(stdout).trim();
        // Exit 1: unset. Anything else unreadable: treat as an outside pointer.
        if (error !== null) {
          resolve(error.code === 1 ? undefined : '/');
          return;
        }
        resolve(value === '' ? undefined : value);
      },
    );
    child.stdin?.end();
  });
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
 * Where the directory components between `root` and `file` stop being real
 * directories: `real` when all exist as directories, `missing` at the first
 * absent one, `blocked` at the first that is a link, file or anything else
 * (named in `at`). Nothing is followed.
 */
async function parentState(
  root: string,
  file: string,
): Promise<{
  readonly state: 'real' | 'missing' | 'blocked';
  readonly at?: string;
}> {
  const parts = file.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i += 1) {
    const rel = parts.slice(0, i).join('/');
    try {
      const info = await lstat(path.join(root, rel));
      if (!info.isDirectory()) return { state: 'blocked', at: rel };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return { state: 'missing', at: rel };
    }
  }
  return { state: 'real' };
}

/**
 * Promote an attempt's changes (repository-relative paths reported by change
 * detection in the copy) into the real repository, in two steps (phase gate
 * p02 round 2 L):
 *
 * 1. plan, reading only: every path is classified on both sides by `lstat`,
 *    never through a link. In the copy, a path below a link or file the
 *    attempt created is gone (that link must itself be a promoted change).
 *    In the workspace, a directory is never replaced, nothing is read or
 *    removed below a link, and a link or file is crossed only when it is
 *    itself deleted first. Any conflict refuses the whole promotion;
 * 2. apply: deletions, then files and links.
 *
 * A refused promotion writes nothing.
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
    const listed = new Set(changed);
    const kinds = new Map<string, Kind>();
    for (const file of changed) {
      kinds.set(file, await sourceKind(copyRoot, file, listed));
    }
    const deleted = new Set(changed.filter((f) => kinds.get(f) === 'missing'));
    const removals: string[] = [];
    for (const file of changed) {
      const parents = await parentState(boundaryRoot, file);
      if (parents.state === 'blocked') {
        // Crossing a workspace link or file is fine only once it is deleted.
        if (!deleted.has(parents.at ?? '')) {
          throw new Error(
            `${parents.at ?? file} is not a directory in the workspace`,
          );
        }
        continue; // nothing exists below it to remove
      }
      if (parents.state === 'missing') continue;
      const existing = await kindOf(path.join(boundaryRoot, file));
      if (existing === 'other') {
        throw new Error(`${file} is a directory in the workspace`);
      }
      if (deleted.has(file) && existing !== 'missing') removals.push(file);
    }
    const writes = changed.filter((file) => !deleted.has(file));
    for (const file of writes) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('/');
        if (listed.has(prefix) && !deleted.has(prefix)) {
          throw new Error(`${prefix} is both a promoted path and a directory`);
        }
      }
    }
    // Apply. Only I/O errors can fail from here.
    for (const file of removals) await rm(path.join(boundaryRoot, file));
    for (const file of writes) {
      const source = path.join(copyRoot, file);
      const target = path.join(boundaryRoot, file);
      await checkParents(boundaryRoot, file, true);
      await rm(target, { force: true });
      if (kinds.get(file) === 'link') {
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

/**
 * What a changed path is in the copy, by `lstat` and never through a link:
 * a file, a link, or missing (deleted, below a link or file the attempt
 * created, or now a directory whose files are listed on their own).
 */
async function sourceKind(
  copyRoot: string,
  file: string,
  listed: ReadonlySet<string>,
): Promise<Kind> {
  const parents = await parentState(copyRoot, file);
  if (parents.state === 'blocked') {
    // The attempt replaced a directory with a link or file; that entry must
    // be promoted (or refused) on its own.
    if (!listed.has(parents.at ?? '')) {
      throw new Error(
        `${file} is below ${parents.at ?? file}, which is not a directory in the attempt`,
      );
    }
    return 'missing';
  }
  if (parents.state === 'missing') return 'missing';
  const source = path.join(copyRoot, file);
  const info = await lstat(source).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  if (info === undefined || info.isDirectory()) return 'missing';
  if (info.isFile()) return 'file';
  if (!info.isSymbolicLink()) {
    throw new Error(`${file} is not a file or symlink in the attempt`);
  }
  // A link into the attempt copy would dangle once the copy is removed.
  if (await pointsInto(path.dirname(copyRoot), await readlink(source))) {
    throw new Error(`${file} links into the attempt workspace`);
  }
  return 'link';
}
