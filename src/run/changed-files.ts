import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import {
  filterDriverOverrides,
  type GitPin,
  pinEnv,
  SAFE_GIT_ENV,
  safeGitArgs,
} from '@agent-ci/git/safe-git.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import {
  findWorkspaceRoot,
  isWithin,
  resolveRealPath,
} from '@agent-ci/run/workspace.js';

interface WorkspaceChanges {
  /** Real path all returned paths are relative to (the git top level). */
  readonly root: string;
  readonly files: string[];
}

/**
 * Dirty paths from `git status --porcelain -z`, relative to the repository
 * top level (porcelain paths are root-relative even when `cwd` is a
 * subdirectory). Paths under `excludeDirs` (agent-ci's own output) are
 * ignored. Outside a git repository the list is empty; any other git failure
 * (missing git, a `safe.directory` refusal) is an `E_WORKSPACE_STATUS`
 * failure, never a silent "no changes".
 */
async function listChanges(
  cwd: string,
  excludeDirs: readonly string[],
  git: string,
  pin?: GitPin,
): Promise<Result<WorkspaceChanges>> {
  const workspace = await findWorkspaceRoot(cwd, git, pin);
  if (!workspace.ok) return workspace;
  const { root } = workspace.value;
  if (!workspace.value.git) return success({ root, files: [] });
  const excluded: string[] = [];
  for (const dir of excludeDirs) {
    let real: string;
    try {
      real = await resolveRealPath(dir);
    } catch {
      return failure(
        'E_WORKSPACE_STATUS',
        `could not resolve the excluded directory ${dir}`,
      );
    }
    // Only a directory strictly inside the repository can be excluded.
    if (real !== root && isWithin(root, real)) {
      excluded.push(`${path.relative(root, real).split(path.sep).join('/')}/`);
    }
  }
  // A configured filter driver would run when status compares content.
  let filters: string[];
  try {
    filters = await filterDriverOverrides(root, git, pin);
  } catch (err) {
    return failure(
      'E_WORKSPACE_STATUS',
      `could not read the repository's filter configuration: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new Promise((resolve) => {
    const child = execFile(
      git,
      safeGitArgs([
        ...filters,
        'status',
        '--porcelain',
        '-z',
        '--untracked-files=all',
        // No child `git status` per submodule: it would run the module's own
        // filter drivers and follow a redirected `sub/.git` (phase review r5
        // L1/L2). A moved submodule commit is still reported; edits inside a
        // submodule's work tree are not (they belong to another repository
        // and could never be promoted or published).
        '--ignore-submodules=dirty',
      ]),
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ...SAFE_GIT_ENV,
          ...pinEnv(pin),
        },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve(
            failure(
              'E_WORKSPACE_STATUS',
              `could not read workspace changes: ${String(stderr).trim().split('\n')[0] || error.message}`,
              'Fix git access to the workspace (for example safe.directory) so changes can be detected.',
            ),
          );
          return;
        }
        const entries = stdout.split('\0');
        const files: string[] = [];
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index] ?? '';
          if (entry.length < 4) continue;
          const status = entry.slice(0, 2);
          files.push(entry.slice(3));
          // Renames and copies carry the source path as the next entry. A
          // rename removed its source, so the source changed too (its
          // deletion must be promoted and published); a copy kept it.
          if (status.includes('R') || status.includes('C')) {
            index += 1;
            const source = entries[index] ?? '';
            if (status.includes('R') && source !== '') files.push(source);
          }
        }
        resolve(
          success({
            root,
            files: files.filter(
              (file) => !excluded.some((prefix) => file.startsWith(prefix)),
            ),
          }),
        );
      },
    );
    child.stdin?.end();
  });
}

/** Dirty paths relative to the repository top level (see `listChanges`). */
export async function detectChangedFiles(
  cwd: string,
  excludeDirs: readonly string[] = [],
  git = 'git',
  pin?: GitPin,
): Promise<Result<string[]>> {
  const changes = await listChanges(cwd, excludeDirs, git, pin);
  return changes.ok ? success(changes.value.files) : changes;
}

/** Path → content fingerprint for every dirty path at one moment. */
export type WorkspaceSnapshot = ReadonlyMap<string, string>;

/**
 * Content fingerprint of one path. A missing path is 'missing'; any other
 * error (permissions, I/O) is returned as a failure: treating an unreadable
 * file as 'missing' before and after the run would silently drop its edits.
 */
async function fingerprint(file: string): Promise<Result<string>> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return success(`link:${await readlink(file)}`);
    if (!info.isFile()) return success('other');
    return success(
      `file:${createHash('sha256')
        .update(await readFile(file))
        .digest('hex')}`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return success('missing');
    return failure(
      'E_WORKSPACE_STATUS',
      `could not read workspace file ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
}

/** Snapshot the dirty paths (and their content) before a run starts. */
export async function snapshotWorkspace(
  cwd: string,
  excludeDirs: readonly string[] = [],
  git = 'git',
  pin?: GitPin,
): Promise<Result<WorkspaceSnapshot>> {
  const changes = await listChanges(cwd, excludeDirs, git, pin);
  if (!changes.ok) return changes;
  const entries = new Map<string, string>();
  for (const file of changes.value.files) {
    const print = await fingerprint(path.join(changes.value.root, file));
    if (!print.ok) return print;
    entries.set(file, print.value);
  }
  return success(entries);
}

/**
 * Paths the run changed: dirty now but not before, dirty before and now with
 * different content, or dirty before and clean now (restored). Pre-existing
 * dirt the run did not touch is not reported.
 */
export async function changedSince(
  cwd: string,
  before: WorkspaceSnapshot,
  excludeDirs: readonly string[] = [],
  git = 'git',
  pin?: GitPin,
): Promise<Result<string[]>> {
  const after = await snapshotWorkspace(cwd, excludeDirs, git, pin);
  if (!after.ok) return after;
  const changed = new Set<string>();
  for (const [file, print] of after.value) {
    if (before.get(file) !== print) changed.add(file);
  }
  for (const file of before.keys()) {
    if (!after.value.has(file)) changed.add(file);
  }
  return success([...changed].toSorted());
}

/**
 * The commit HEAD points at, or null in a repository without commits or
 * outside git. Other git failures are `E_WORKSPACE_STATUS`.
 */
export function readHead(
  cwd: string,
  git = 'git',
  pin?: GitPin,
): Promise<Result<string | null>> {
  return new Promise((resolve) => {
    const child = execFile(
      git,
      safeGitArgs(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ...SAFE_GIT_ENV,
          ...pinEnv(pin),
        },
      },
      (error, stdout, stderr) => {
        const sha = String(stdout).trim();
        if (error === null && /^[0-9a-f]{40}$/u.test(sha)) {
          resolve(success(sha));
          return;
        }
        // --quiet: an unborn HEAD exits 1 with no output.
        const text = String(stderr);
        if (
          (error !== null && error.code === 1 && text.trim() === '') ||
          /not a git repository/iu.test(text)
        ) {
          resolve(success(null));
          return;
        }
        resolve(
          failure(
            'E_WORKSPACE_STATUS',
            `could not read the workspace HEAD: ${text.trim().split('\n')[0] || (error?.message ?? 'unexpected output')}`,
          ),
        );
      },
    );
    child.stdin?.end();
  });
}
