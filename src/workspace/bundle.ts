import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';

import { isSafeRepoPath } from '@agent-ci/publish/changes.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import {
  isWithin,
  resolvePhysical,
  resolveRealPath,
} from '@agent-ci/run/workspace.js';

/**
 * Restore the setup job's prepared working tree in the agent job.
 *
 * The setup job runs repository code, so its archive (gzip tar, produced
 * there with plain `tar`) is hostile input. agent-ci parses it itself (no
 * `tar` process, so no `TAR_OPTIONS`, transforms or extraction quirks) and
 * accepts only: directories, regular files with permission bits only,
 * hard links to files extracted earlier, and relative symlinks that stay in
 * the tree. `.git` at any depth, absolute paths, `..`, devices, FIFOs,
 * setuid/setgid/sticky bits, duplicates and entries below a link are
 * refused. Extraction goes into a fresh staging directory; the agent job's
 * own `.git` is moved in and the result swapped into place, so a refused
 * archive leaves the checkout untouched.
 */

const BLOCK = 512;
const CHUNK = 1024 * 1024;

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 2_000_000,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
};

/**
 * A relative link target that, resolved segment by segment from the link's
 * directory, never climbs above the tree root and never enters `.git`.
 */
export function isInTreeLinkTarget(linkPath: string, target: string): boolean {
  if (
    target === '' ||
    target.startsWith('/') ||
    target.includes('\\') ||
    target.includes('\0')
  ) {
    return false;
  }
  const stack = linkPath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return false;
      stack.pop();
      continue;
    }
    if (part.toLowerCase() === '.git') return false;
    stack.push(part);
  }
  return true;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Pull-based reader over the gunzipped stream. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.length < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
      } else {
        this.chunks.push(next.value);
        this.length += next.value.length;
      }
    }
  }

  private take(n: number): Buffer {
    const all =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const buffer = all ?? Buffer.alloc(0);
    const out = buffer.subarray(0, n);
    const rest = buffer.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  /** Exactly `n` bytes, or null at a clean end of stream. */
  async read(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.length === 0 && this.ended) return null;
    if (this.length < n) throw new Error('truncated archive');
    return this.take(n);
  }

  /** Up to `max` bytes, at least one. */
  async readSome(max: number): Promise<Buffer> {
    await this.fill(1);
    if (this.length === 0) throw new Error('truncated archive');
    return this.take(Math.min(max, this.length));
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0)
      left -= (await this.readSome(Math.min(left, CHUNK))).length;
  }

  /** True when only zero bytes (or nothing) remain. */
  async onlyZerosLeft(): Promise<boolean> {
    for (;;) {
      await this.fill(1);
      if (this.length === 0) return true;
      const chunk = this.take(Math.min(this.length, CHUNK));
      if (chunk.some((byte) => byte !== 0)) return false;
    }
  }
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function octal(
  block: Buffer,
  start: number,
  length: number,
  name: string,
): number {
  if ((block[start] ?? 0) & 0x80) {
    throw new Error(`base-256 ${name} is not supported`);
  }
  const text = field(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`invalid ${name} field`);
  return Number.parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8, 'checksum');
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  }
  return sum === stored;
}

/** Parse pax extended-header records ("<len> key=value\n"). */
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('invalid pax header');
    const length = Number.parseInt(
      data.subarray(offset, space).toString('ascii'),
      10,
    );
    if (
      !Number.isInteger(length) ||
      length <= 0 ||
      offset + length > data.length
    ) {
      throw new Error('invalid pax record length');
    }
    const record = data
      .subarray(space + 1, offset + length - 1)
      .toString('utf8');
    const equals = record.indexOf('=');
    if (equals === -1) throw new Error('invalid pax record');
    out.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return out;
}

/** `./a/b/` → `a/b`; the archive root (`.` or `./`) → ''. */
function memberPath(raw: string): string {
  let name = raw;
  if (name.startsWith('./')) name = name.slice(2);
  else if (name === '.') name = '';
  while (name.endsWith('/')) name = name.slice(0, -1);
  return name;
}

interface Extracted {
  readonly entries: number;
  /** Paths (relative to staging) of every extracted symlink. */
  readonly links: readonly string[];
}

async function extract(
  archive: string,
  staging: string,
  limits: ArchiveLimits,
): Promise<Extracted> {
  const reader = new ByteReader(
    createReadStream(archive).pipe(createGunzip()) as AsyncIterable<Buffer>,
  );
  const seen = new Set<string>();
  const dirs = new Set<string>(['']);
  const files = new Set<string>();
  const links: string[] = [];
  let entries = 0;
  let total = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax = new Map<string, string>();
  for (;;) {
    const block = await reader.read(BLOCK);
    if (block === null) throw new Error('archive has no end-of-archive marker');
    if (block.every((byte) => byte === 0)) {
      if (!(await reader.onlyZerosLeft())) {
        throw new Error('data after the end-of-archive marker');
      }
      return { entries, links };
    }
    if (!checksumOk(block)) throw new Error('archive header checksum mismatch');
    const type = String.fromCharCode(block[156] ?? 0);
    const size = octal(block, 124, 12, 'size');
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    // Metadata entries describe the next member.
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (size > 1024 * 1024)
        throw new Error('archive metadata entry too large');
      const data = (await reader.read(padded)) ?? Buffer.alloc(0);
      const body = data.subarray(0, size);
      if (type === 'L') longName = body.toString('utf8').replaceAll('\0', '');
      else if (type === 'K')
        longLink = body.toString('utf8').replaceAll('\0', '');
      else if (type === 'x') pax = paxRecords(body);
      else {
        const global = paxRecords(body);
        if (
          global.has('path') ||
          global.has('linkpath') ||
          global.has('size')
        ) {
          throw new Error('global pax header sets path, linkpath or size');
        }
      }
      continue;
    }
    const prefix = field(block, 345, 155);
    const rawName =
      pax.get('path') ??
      longName ??
      (prefix === ''
        ? field(block, 0, 100)
        : `${prefix}/${field(block, 0, 100)}`);
    const linkName = pax.get('linkpath') ?? longLink ?? field(block, 157, 100);
    const effectiveSize = pax.has('size') ? Number(pax.get('size')) : size;
    longName = undefined;
    longLink = undefined;
    pax = new Map();
    if (!Number.isInteger(effectiveSize) || effectiveSize < 0) {
      throw new Error('invalid member size');
    }
    const mode = octal(block, 100, 8, 'mode');
    const rel = memberPath(rawName);
    const dataBytes = Math.ceil(effectiveSize / BLOCK) * BLOCK;
    if (rel === '' && type === '5') {
      await reader.skip(dataBytes);
      continue; // the archive root
    }
    entries += 1;
    if (entries > limits.maxEntries)
      throw new Error('too many archive entries');
    if (!isSafeRepoPath(rel) || rel.length > 4096) {
      throw new Error(`refusing archive member ${JSON.stringify(rawName)}`);
    }
    if (mode & ~0o777) {
      throw new Error(
        `archive member ${rel} has setuid, setgid or sticky bits`,
      );
    }
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate archive member ${rel}`);
    seen.add(key);
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (!dirs.has(parent)) {
      throw new Error(
        `archive member ${rel} has no directory entry for its parent`,
      );
    }
    const full = path.join(staging, rel);
    if (type === '5') {
      await mkdir(full, { mode: 0o755 });
      dirs.add(rel);
      await reader.skip(dataBytes);
    } else if (type === '2') {
      if (!isInTreeLinkTarget(rel, linkName)) {
        throw new Error(`archive link ${rel} leaves the tree (${linkName})`);
      }
      await symlink(linkName, full);
      links.push(rel);
      await reader.skip(dataBytes);
    } else if (type === '1') {
      const source = memberPath(linkName);
      if (!files.has(source.toLowerCase())) {
        throw new Error(
          `archive hard link ${rel} does not name an earlier file`,
        );
      }
      await copyFile(path.join(staging, source), full);
      files.add(key);
      await reader.skip(dataBytes);
    } else if (type === '0' || type === '\0' || type === '7') {
      if (effectiveSize > limits.maxFileBytes) {
        throw new Error(`archive member ${rel} is too large`);
      }
      total += effectiveSize;
      if (total > limits.maxTotalBytes) throw new Error('archive is too large');
      const handle = await open(full, 'wx', mode & 0o777);
      try {
        let left = effectiveSize;
        while (left > 0) {
          const chunk = await reader.readSome(Math.min(left, CHUNK));
          await handle.write(chunk);
          left -= chunk.length;
        }
        await handle.chmod(mode & 0o777);
      } finally {
        await handle.close();
      }
      files.add(key);
      await reader.skip(dataBytes - effectiveSize);
    } else {
      throw new Error(
        `archive member ${rel} has unsupported type ${JSON.stringify(type)}`,
      );
    }
  }
}

/**
 * The per-entry check is lexical; links can chain through other archive
 * links (`l1 -> ../..` then `x -> l1/../../etc/passwd`). Once everything is
 * extracted, resolve each link physically (the p01 resolver follows chains,
 * applies `..` after links and rejects loops) and refuse any whose final
 * target leaves the staging tree or lands in `.git`.
 */
async function assertLinksStayInTree(
  staging: string,
  links: readonly string[],
): Promise<void> {
  const root = await resolveRealPath(staging);
  for (const rel of links) {
    let real: string;
    try {
      real = (await resolvePhysical(path.join(root, rel))).real;
    } catch {
      throw new Error(`archive link ${rel} cannot be resolved inside the tree`);
    }
    if (!isWithin(root, real)) {
      throw new Error(`archive link ${rel} resolves outside the tree`);
    }
    const inside = path.relative(root, real).split(path.sep);
    if (inside.some((part) => part.toLowerCase() === '.git')) {
      throw new Error(`archive link ${rel} resolves into .git`);
    }
  }
}

export interface RestoreOptions {
  /** gzip tar archive from the setup job. */
  readonly archive: string;
  /** The agent job's checkout; its `.git` is kept, everything else replaced. */
  readonly target: string;
  /** Expected sha256 of the archive file (lowercase hex). */
  readonly sha256: string;
  readonly limits?: ArchiveLimits;
}

export interface RestoreReport {
  readonly entries: number;
  readonly sha256: string;
}

export async function restoreWorkspace(
  options: RestoreOptions,
): Promise<Result<RestoreReport>> {
  const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
  if (!/^[0-9a-f]{64}$/u.test(options.sha256)) {
    return failure(
      'E_WORKSPACE_BUNDLE',
      'expected archive sha256 is not 64 hex characters',
    );
  }
  const target = path.resolve(options.target);
  let actual: string;
  try {
    actual = await sha256File(options.archive);
  } catch {
    return failure(
      'E_WORKSPACE_BUNDLE',
      `cannot read the archive ${options.archive}`,
    );
  }
  if (actual !== options.sha256) {
    return failure(
      'E_WORKSPACE_BUNDLE',
      `archive sha256 ${actual} does not match the expected ${options.sha256}`,
    );
  }
  try {
    const info = await lstat(path.join(target, '.git'));
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    return failure(
      'E_WORKSPACE_BUNDLE',
      `${target}/.git is not a directory; restore needs the agent job's own checkout`,
    );
  }
  const suffix = randomBytes(6).toString('hex');
  const staging = `${target}.agent-ci-staging-${suffix}`;
  const old = `${target}.agent-ci-replaced-${suffix}`;
  try {
    await mkdir(staging, { mode: 0o755 });
  } catch (err) {
    return failure(
      'E_WORKSPACE_BUNDLE',
      `cannot create the staging directory (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  let entries: number;
  try {
    const extracted = await extract(options.archive, staging, limits);
    entries = extracted.entries;
    await assertLinksStayInTree(staging, extracted.links);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    return failure(
      'E_WORKSPACE_BUNDLE',
      `refusing the prepared workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    // The staging tree holds no .git (refused at any depth); the agent job's
    // own checkout supplies it.
    await rename(path.join(target, '.git'), path.join(staging, '.git'));
    await rename(target, old);
    await rename(staging, target);
    await rm(old, { recursive: true, force: true });
  } catch (err) {
    return failure(
      'E_WORKSPACE_BUNDLE',
      `could not swap the restored workspace into place (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  return success({ entries, sha256: actual });
}
