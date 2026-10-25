import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * Workspace changes from `git status --porcelain -z`. Paths under
 * `excludeDirs` (agent-ci's own output) are ignored. Outside a git repository
 * the list is empty; any other git failure (missing git, a `safe.directory`
 * refusal) is an `E_WORKSPACE_STATUS` failure, never a silent "no changes".
 */
export function detectChangedFiles(
  cwd: string,
  excludeDirs: readonly string[] = [],
  git = 'git',
): Promise<Result<string[]>> {
  return new Promise((resolve) => {
    const child = execFile(
      git,
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const text = String(stderr);
          if (/not a git repository/iu.test(text)) {
            resolve(success([]));
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
          return;
        }
        const excluded = excludeDirs
          .map((dir) => path.relative(cwd, dir))
          .filter((rel) => rel !== '' && !rel.startsWith('..'))
          .map((rel) => `${rel.split(path.sep).join('/')}/`);
        const entries = stdout.split('\0');
        const files: string[] = [];
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index] ?? '';
          if (entry.length < 4) continue;
          const status = entry.slice(0, 2);
          files.push(entry.slice(3));
          // Renames and copies carry the source path as the next entry.
          if (status.includes('R') || status.includes('C')) index += 1;
        }
        resolve(
          success(
            files.filter(
              (file) => !excluded.some((prefix) => file.startsWith(prefix)),
            ),
          ),
        );
      },
    );
    child.stdin?.end();
  });
}

/** Path → content fingerprint for every dirty path at one moment. */
export type WorkspaceSnapshot = ReadonlyMap<string, string>;

async function fingerprint(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return `link:${await readlink(file)}`;
    if (!info.isFile()) return 'other';
    return `file:${createHash('sha256')
      .update(await readFile(file))
      .digest('hex')}`;
  } catch {
    return 'missing';
  }
}

/** Snapshot the dirty paths (and their content) before a run starts. */
export async function snapshotWorkspace(
  cwd: string,
  excludeDirs: readonly string[] = [],
  git = 'git',
): Promise<Result<WorkspaceSnapshot>> {
  const files = await detectChangedFiles(cwd, excludeDirs, git);
  if (!files.ok) return files;
  const entries = new Map<string, string>();
  for (const file of files.value) {
    entries.set(file, await fingerprint(path.join(cwd, file)));
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
): Promise<Result<string[]>> {
  const after = await snapshotWorkspace(cwd, excludeDirs, git);
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
