import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * Content digest of a run's result directory: sha256 over the sorted
 * `<name>\0<sha256 of the file>\n` lines of its regular files. The agent job
 * records it next to the upload; the publish job recomputes it on the
 * downloaded directory, so only the agent job's own outputs are published.
 * Anything but a flat directory of regular files is refused.
 */
export async function digestResultDir(dir: string): Promise<Result<string>> {
  let names: string[];
  try {
    names = (await readdir(dir)).toSorted();
  } catch {
    return failure('E_PUBLISH', `cannot read the result directory ${dir}`);
  }
  if (names.length === 0) {
    return failure('E_PUBLISH', `the result directory ${dir} is empty`);
  }
  const outer = createHash('sha256');
  for (const name of names) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    if (!info.isFile()) {
      return failure(
        'E_PUBLISH',
        `the result directory holds ${name}, which is not a regular file`,
      );
    }
    const inner = createHash('sha256');
    for await (const chunk of createReadStream(full)) {
      inner.update(chunk as Buffer);
    }
    outer.update(`${name}\0${inner.digest('hex')}\n`);
  }
  return success(outer.digest('hex'));
}

/** Refuse a result directory whose digest is not the expected one. */
export async function verifyResultDir(
  dir: string,
  expected: string,
): Promise<Result<void>> {
  if (!/^[0-9a-f]{64}$/u.test(expected)) {
    return failure('E_PUBLISH', '--result-digest is not 64 hex characters');
  }
  const actual = await digestResultDir(dir);
  if (!actual.ok) return actual;
  return actual.value === expected
    ? success(undefined)
    : failure(
        'E_PUBLISH',
        `the result directory digest ${actual.value} does not match the agent job's ${expected}`,
        'Publish only the artifact the agent job uploaded.',
      );
}
