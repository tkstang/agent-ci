import { rm, writeFile } from 'node:fs/promises';

/**
 * Write a file agent-ci owns without following a link at its path: remove
 * whatever is there (a link is removed, not its target), then create it
 * exclusively (`O_EXCL`). A link re-created in between makes the write fail
 * with `EEXIST` instead of following it.
 */
export async function writeOwnedFile(
  file: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await rm(file, { force: true });
  await writeFile(file, content, { flag: 'wx', mode });
}
