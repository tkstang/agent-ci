import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import type { HomeRoot } from '@agent-ci/harness/home.js';
import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * The skills installed into a home root are trusted instructions, and an
 * edit-mode harness may reach them (Claude gets `--add-dir` on the canonical
 * skills directory so it can read user-invocable-only skills). A run must
 * not change them: the run core fingerprints the skill trees before the
 * agent starts and again after every harness attempt and repair turn, fails
 * closed on any difference, and purges the trees so a kept home root never
 * carries modified skills into a later run.
 *
 * Neither the fingerprint nor the purge ever follows a link. Every path
 * component from the home root down to a skill tree is checked with
 * `lstat`; a component that is a link (or not a directory) is never
 * traversed: the fingerprint records it as changed, and the purge unlinks
 * that component itself, from its verified parent, so a harness that
 * redirects `home/.agents` or `home/.claude` elsewhere cannot turn cleanup
 * into deletion outside the root.
 */

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;

/** Path components below the home root for each skill tree. */
function treeComponents(home: HomeRoot): string[][] {
  const fromRoot = (target: string) =>
    path.relative(home.root, target).split(path.sep);
  return [
    fromRoot(home.skillsDir),
    fromRoot(path.join(home.home, '.claude', 'skills')),
  ];
}

/** The skill trees a run fingerprints: the canonical view and Claude's view. */
export function skillTrees(home: HomeRoot): string[] {
  return treeComponents(home).map((parts) => path.join(home.root, ...parts));
}

type Lstat = Stats;

async function lstatOrNull(target: string): Promise<Lstat | null> {
  try {
    return await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const isRealDirectory = (info: Lstat | null): boolean =>
  info !== null && info.isDirectory() && !info.isSymbolicLink();

/** One digest over every entry (path, kind, mode, content or link target). */
export async function fingerprintSkills(
  home: HomeRoot,
): Promise<Result<string>> {
  const lines: string[] = [];
  let entries = 0;
  let bytes = 0;
  const describe = async (full: string, rel: string): Promise<void> => {
    entries += 1;
    if (entries > MAX_ENTRIES) throw new Error('too many skill entries');
    const info = await lstatOrNull(full);
    if (info === null) {
      lines.push(`${rel}\tmissing`);
      return;
    }
    const mode = (info.mode & 0o777).toString(8);
    if (info.isSymbolicLink()) {
      lines.push(`${rel}\tlink\t${await readlink(full)}`);
    } else if (info.isDirectory()) {
      lines.push(`${rel}\tdir\t${mode}`);
      for (const name of (await readdir(full)).toSorted()) {
        await describe(path.join(full, name), `${rel}/${name}`);
      }
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > MAX_BYTES) throw new Error('skill trees too large');
      const digest = createHash('sha256')
        .update(await readFile(full))
        .digest('hex');
      lines.push(`${rel}\tfile\t${mode}\t${digest}`);
    } else {
      lines.push(`${rel}\tother`);
    }
  };
  try {
    if (!isRealDirectory(await lstatOrNull(home.root))) {
      throw new Error('the home root is not a directory');
    }
    for (const [index, parts] of treeComponents(home).entries()) {
      // Ancestors must be real directories; a link or file is recorded, not followed.
      let current = home.root;
      let reachable = true;
      for (const part of parts.slice(0, -1)) {
        current = path.join(current, part);
        const info = await lstatOrNull(current);
        if (info === null || !isRealDirectory(info)) {
          lines.push(
            `${index}:${part}\t${info === null ? 'missing' : info.isSymbolicLink() ? 'link' : 'not-a-directory'}`,
          );
          reachable = false;
          break;
        }
      }
      if (reachable) {
        await describe(path.join(current, parts.at(-1) ?? ''), String(index));
      }
    }
  } catch (err) {
    return failure(
      'E_HOME_ROOT',
      `cannot fingerprint the installed skills: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return success(createHash('sha256').update(lines.join('\n')).digest('hex'));
}

/**
 * Remove the skill trees without following any link: walk each tree's path
 * from the home root; the first component that is a link or not a directory
 * is unlinked itself (its target is never touched) and the walk stops; a
 * tree reached through real directories only is removed (`rm` removes links
 * inside it, never their targets). Then recreate the canonical skills
 * directory one component at a time, only through real directories.
 */
export async function purgeSkills(home: HomeRoot): Promise<void> {
  if (!isRealDirectory(await lstatOrNull(home.root))) return;
  for (const parts of treeComponents(home)) {
    let current = home.root;
    for (const [index, part] of parts.entries()) {
      const next = path.join(current, part);
      const info = await lstatOrNull(next);
      if (info === null) break;
      if (!isRealDirectory(info)) {
        await unlink(next);
        break;
      }
      if (index === parts.length - 1) {
        await rm(next, { recursive: true, force: true });
        break;
      }
      current = next;
    }
  }
  let current = home.root;
  for (const part of path.relative(home.root, home.skillsDir).split(path.sep)) {
    const next = path.join(current, part);
    const info = await lstatOrNull(next);
    if (info === null) {
      await mkdir(next, { mode: 0o700 });
    } else if (!isRealDirectory(info)) {
      return;
    }
    current = next;
  }
}
