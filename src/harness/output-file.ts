import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Read a file a harness wrote as output (Codex's `-o` final answer, a tool
 * bridge's calls log) after the process has exited, under the run's output
 * budget: opened without following a link at its path (O_NOFOLLOW) and
 * without blocking on a FIFO (O_NONBLOCK), fstat-checked as a regular file no
 * larger than `maxBytes`, and read from that same descriptor, never past
 * `maxBytes`. The streams' capture cap does not cover such a file, so this
 * is its bound.
 */
export type OutputFileRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-large'; readonly size: number }
  | { readonly kind: 'invalid'; readonly reason: string };

export async function readOutputFile(
  file: string,
  maxBytes: number,
): Promise<OutputFileRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return {
      kind: 'invalid',
      reason:
        code === 'ELOOP' ? 'it is a symlink' : `it cannot be opened (${code})`,
    };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      return { kind: 'invalid', reason: 'not a regular file' };
    if (info.size > maxBytes) return { kind: 'too-large', size: info.size };
    // One byte past the reported size (itself within the cap): a file
    // still growing after the check is caught instead of read unbounded.
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) {
      return { kind: 'invalid', reason: 'it changed while it was read' };
    }
    return { kind: 'ok', text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch (err) {
    return {
      kind: 'invalid',
      reason: `it cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Up to the first `maxBytes` of a regular output file (for a diagnostic
 * log only the head of which is used); `undefined` when it is missing,
 * a link or not a regular file.
 */
export async function readOutputFileHead(
  file: string,
  maxBytes: number,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
