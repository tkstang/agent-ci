import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';

import { failure, success, type Result } from '@agent-ci/result.js';
import { z } from 'zod';

/**
 * The change set of an edit run (`changes.json`): the exact content of every
 * file the run changed, relative to the repository root, plus the commit it
 * was based on. `agent-ci run` writes it in the agent step (the only step that
 * holds the model credential, so file contents are secret-guarded there); the
 * publisher reads it in a separate job and turns it into a commit without
 * checking out or executing anything from it.
 */

export const CHANGE_SET_FILE = 'changes.json';

export interface ChangeSetLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
}

export const DEFAULT_CHANGE_SET_LIMITS: ChangeSetLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFiles: 2_000,
};

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;

const ChangePathSchema = z
  .string()
  .min(1)
  .refine(isSafeRepoPath, 'unsafe repository path');

export const ChangeEntrySchema = z.discriminatedUnion('action', [
  z.strictObject({
    path: ChangePathSchema,
    action: z.literal('write'),
    mode: z.enum(['100644', '100755']),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256),
    contentBase64: z.string(),
  }),
  z.strictObject({
    path: ChangePathSchema,
    action: z.literal('symlink'),
    target: z.string().min(1),
  }),
  z.strictObject({
    path: ChangePathSchema,
    action: z.literal('delete'),
  }),
]);
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

export const ChangeSetSchema = z.strictObject({
  version: z.literal(1),
  /** The commit the run started from, or null outside a repository with commits. */
  baseSha: z.string().regex(GIT_SHA).nullable(),
  files: z.array(ChangeEntrySchema),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/**
 * A repository-relative path a change set may carry: forward slashes, no
 * empty, `.` or `..` segment, nothing inside `.git`, not absolute, not a
 * directory.
 */
export function isSafeRepoPath(file: string): boolean {
  if (
    file === '' ||
    file.startsWith('/') ||
    file.endsWith('/') ||
    file.includes('\\') ||
    file.includes('\0')
  ) {
    return false;
  }
  return !file
    .split('/')
    .some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git',
    );
}

/** True when the bytes contain any secret value. */
function bytesContainSecret(
  bytes: Buffer,
  secrets: readonly string[],
): boolean {
  return secrets.some(
    (secret) => secret !== '' && bytes.includes(Buffer.from(secret, 'utf8')),
  );
}

async function realDirectoryParents(
  root: string,
  file: string,
): Promise<boolean> {
  let current = root;
  for (const part of file.split('/').slice(0, -1)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw err;
    }
  }
  return true;
}

/** Read one regular file without following a link at its path. */
async function readNoFollow(
  file: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; executable: boolean } | 'too-large'> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    if (info.size > maxBytes) return 'too-large';
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, info.size + 1, 0);
    if (bytesRead > info.size) return 'too-large';
    return {
      bytes: buffer.subarray(0, bytesRead),
      executable: (info.mode & 0o111) !== 0,
    };
  } finally {
    await handle.close();
  }
}

export interface BuildChangeSetInput {
  /** Real path of the repository root. */
  readonly root: string;
  /** Repository-relative paths detected as changed by the run. */
  readonly files: readonly string[];
  readonly baseSha: string | null;
  /** Credential values the run could see; a file containing one is refused. */
  readonly secrets: readonly string[];
  readonly limits?: ChangeSetLimits;
}

/**
 * Capture the detected changes. Fails closed: an unsafe path, a path reached
 * through a symlinked directory, a directory, an oversized file or set, or a
 * file or link containing a credential value fails the whole set.
 */
export async function buildChangeSet(
  input: BuildChangeSetInput,
): Promise<Result<ChangeSet>> {
  const limits = input.limits ?? DEFAULT_CHANGE_SET_LIMITS;
  if (input.files.length > limits.maxFiles) {
    return failure(
      'E_CHANGE_SET',
      `the run changed ${input.files.length} files; the limit is ${limits.maxFiles}`,
    );
  }
  const files: ChangeEntry[] = [];
  let total = 0;
  for (const file of [...new Set(input.files)].toSorted()) {
    if (!isSafeRepoPath(file)) {
      return failure(
        'E_CHANGE_SET',
        `cannot publish the changed path ${JSON.stringify(file)}`,
      );
    }
    const full = path.join(input.root, file);
    try {
      if (!(await realDirectoryParents(input.root, file))) {
        return failure(
          'E_CHANGE_SET',
          `${file} is reached through a symlink or a file in the workspace`,
        );
      }
      let info: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        info = await lstat(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (info === undefined) {
        files.push({ path: file, action: 'delete' });
      } else if (info.isSymbolicLink()) {
        const target = await readlink(full);
        if (bytesContainSecret(Buffer.from(target), input.secrets)) {
          return failure(
            'E_SECRET_COPY',
            'a changed symlink target contains a credential value',
          );
        }
        files.push({ path: file, action: 'symlink', target });
      } else if (info.isFile()) {
        const read = await readNoFollow(full, limits.maxFileBytes);
        if (read === 'too-large') {
          return failure(
            'E_CHANGE_SET',
            `${file} is larger than ${limits.maxFileBytes} bytes`,
          );
        }
        total += read.bytes.length;
        if (total > limits.maxTotalBytes) {
          return failure(
            'E_CHANGE_SET',
            `the changed files exceed ${limits.maxTotalBytes} bytes`,
          );
        }
        if (bytesContainSecret(read.bytes, input.secrets)) {
          return failure(
            'E_SECRET_COPY',
            'a changed file contains a credential value',
            'The change set was withheld; nothing will be published.',
          );
        }
        files.push({
          path: file,
          action: 'write',
          mode: read.executable ? '100755' : '100644',
          size: read.bytes.length,
          sha256: createHash('sha256').update(read.bytes).digest('hex'),
          contentBase64: read.bytes.toString('base64'),
        });
      } else {
        return failure(
          'E_CHANGE_SET',
          `${file} is not a file or symlink in the workspace`,
        );
      }
    } catch (err) {
      return failure(
        'E_CHANGE_SET',
        `could not read the changed path ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
  }
  return success({ version: 1, baseSha: input.baseSha, files });
}

/**
 * Parse and verify a change set read by the publisher: schema, unique safe
 * paths, sizes and digests that match the content, and the limits.
 */
export function parseChangeSet(
  text: string,
  limits: ChangeSetLimits = DEFAULT_CHANGE_SET_LIMITS,
): Result<ChangeSet> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure('E_CHANGE_SET', 'changes.json is not valid JSON');
  }
  const parsed = ChangeSetSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(
      'E_CHANGE_SET',
      `changes.json failed validation${issue === undefined ? '' : ` at ${issue.path.join('.')}`}: ${issue?.message ?? 'unknown error'}`,
    );
  }
  const set = parsed.data;
  if (set.files.length > limits.maxFiles) {
    return failure('E_CHANGE_SET', 'changes.json lists too many files');
  }
  const seen = new Set<string>();
  let total = 0;
  for (const entry of set.files) {
    // Case-insensitive file systems would merge paths differing only in case.
    const key = entry.path.toLowerCase();
    if (seen.has(key)) {
      return failure(
        'E_CHANGE_SET',
        `changes.json lists ${entry.path} more than once`,
      );
    }
    seen.add(key);
    if (entry.action !== 'write') continue;
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    if (bytes.toString('base64') !== entry.contentBase64) {
      return failure(
        'E_CHANGE_SET',
        `changes.json content for ${entry.path} is not canonical base64`,
      );
    }
    if (bytes.length !== entry.size || bytes.length > limits.maxFileBytes) {
      return failure(
        'E_CHANGE_SET',
        `changes.json size mismatch for ${entry.path}`,
      );
    }
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      return failure(
        'E_CHANGE_SET',
        `changes.json digest mismatch for ${entry.path}`,
      );
    }
    total += bytes.length;
    if (total > limits.maxTotalBytes) {
      return failure('E_CHANGE_SET', 'changes.json content is too large');
    }
  }
  return success(set);
}
