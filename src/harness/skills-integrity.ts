import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import type { HomeRoot } from '@agent-ci/harness/home.js';
import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * The skills installed into a home root are trusted instructions, and an
 * edit-mode harness may reach them (Claude gets `--add-dir` on the canonical
 * skills directory so it can read user-invocable-only skills). A run must
 * not change them: the run core fingerprints the skill trees before the
 * agent starts and again after every agent turn, fails closed on any
 * difference, and purges the trees so a kept home root never carries
 * modified skills into a later run.
 */

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;

/** The skill trees a run fingerprints: the canonical view and Claude's view. */
export function skillTrees(home: HomeRoot): string[] {
  return [home.skillsDir, path.join(home.home, '.claude', 'skills')];
}

/** One digest over every entry (path, kind, mode, content or link target). */
export async function fingerprintSkills(
  home: HomeRoot,
): Promise<Result<string>> {
  const lines: string[] = [];
  let entries = 0;
  let bytes = 0;
  const walk = async (dir: string, label: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).toSorted();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        lines.push(`${label}\tmissing`);
        return;
      }
      throw err;
    }
    for (const name of names) {
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error('too many skill entries');
      const full = path.join(dir, name);
      const rel = `${label}/${name}`;
      const info = await lstat(full);
      const mode = (info.mode & 0o777).toString(8);
      if (info.isSymbolicLink()) {
        lines.push(`${rel}\tlink\t${await readlink(full)}`);
      } else if (info.isDirectory()) {
        lines.push(`${rel}\tdir\t${mode}`);
        await walk(full, rel);
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
    }
  };
  try {
    for (const [index, tree] of skillTrees(home).entries()) {
      await walk(tree, String(index));
    }
  } catch (err) {
    return failure(
      'E_HOME_ROOT',
      `cannot fingerprint the installed skills: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return success(createHash('sha256').update(lines.join('\n')).digest('hex'));
}

/** Remove the skill trees (a kept home must not keep modified skills). */
export async function purgeSkills(home: HomeRoot): Promise<void> {
  for (const tree of skillTrees(home)) {
    await rm(tree, { recursive: true, force: true });
  }
  await mkdir(home.skillsDir, { recursive: true, mode: 0o700 });
}
