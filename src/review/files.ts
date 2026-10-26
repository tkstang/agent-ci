import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { verifyResultDir } from '@agent-ci/publish/digest.js';
import { contractError } from '@agent-ci/review/contracts.js';

/**
 * Reading downloaded review artifacts: every file is untrusted data, read
 * without following a link at its path, as a regular file under a size cap.
 */

/** Bytes of a regular file under `maxBytes`, `null` when it does not exist. */
export async function readArtifactFile(
  file: string,
  maxBytes: number,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return contractError(
      'E_REVIEW_INPUT',
      `cannot open ${path.basename(file)} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      contractError(
        'E_REVIEW_INPUT',
        `${path.basename(file)} is not a regular file under ${maxBytes} bytes`,
      );
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, info.size + 1, 0);
    if (bytesRead > info.size)
      contractError(
        'E_REVIEW_INPUT',
        `${path.basename(file)} changed while reading`,
      );
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Check a downloaded artifact directory against the content digest its
 * producing job reported (`agent-ci digest`): only that job's own upload is
 * read, never one another job of the run uploaded under the same name.
 */
export async function verifyArtifactDir(
  dir: string,
  digest: string,
): Promise<void> {
  const verified = await verifyResultDir(dir, digest);
  if (!verified.ok) contractError('E_REVIEW_INPUT', verified.message);
}
