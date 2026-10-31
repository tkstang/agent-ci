import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { failure, type Result, success } from '@agent-ci/result.js';

/**
 * A harness executable pinned before untrusted code runs.
 *
 * Local verify-review runs the pull request's checks on the operator's
 * machine and then, in the same process, launches the reviewer harness with
 * the model credential. A harness looked up by bare name through PATH at
 * launch time could resolve to something the checks planted. Pinning
 * resolves the executable (and, for an `#!/usr/bin/env node` script, its
 * interpreter) to absolute real paths before any check runs, fingerprints
 * each file (real path, device, inode, size, mtime, sha256), and
 * `verifyPin` re-checks the fingerprints right before launch. The harness
 * then runs by absolute path, never through PATH.
 */

export type PinnedFile = {
  readonly path: string;
  readonly fingerprint: string;
};
export type PinnedHarness = {
  /** What to execute (the interpreter for a script). */
  readonly command: string;
  /** Arguments placed before the adapter's own (the script for a script). */
  readonly prefixArgs: readonly string[];
  readonly files: readonly PinnedFile[];
};

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function fingerprint(file: string): Promise<string> {
  const info = await stat(file);
  return [
    file,
    info.dev,
    info.ino,
    info.size,
    info.mtimeMs,
    await sha256File(file),
  ].join(':');
}

/** The real path of `name` on `searchPath`, or undefined. */
export async function whichExecutable(
  name: string,
  searchPath: string,
): Promise<string | undefined> {
  if (name.includes('/')) {
    try {
      await access(name, constants.X_OK);
      return await realpath(name);
    } catch {
      return undefined;
    }
  }
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      const real = await realpath(candidate);
      if (!(await stat(real)).isFile()) continue;
      await access(real, constants.X_OK);
      return real;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The interpreter a script names, when it names one by `env`. */
async function shebang(file: string): Promise<string[] | undefined> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, 256, 0);
    const text = buffer.subarray(0, bytesRead).toString('latin1');
    if (!text.startsWith('#!')) return undefined;
    return text.slice(2).split('\n')[0]?.trim().split(/\s+/u);
  } finally {
    await handle.close();
  }
}

/** Resolve and fingerprint a harness executable on `searchPath`. */
export async function pinHarness(
  command: string,
  searchPath: string,
): Promise<Result<PinnedHarness>> {
  const resolved = await whichExecutable(command, searchPath);
  if (resolved === undefined)
    return failure(
      'E_HARNESS_NOT_FOUND',
      `${command} executable not found on PATH`,
    );
  const line = await shebang(resolved);
  let interpreter: string | undefined;
  if (line !== undefined) {
    const [program, ...rest] = line;
    // `#!/usr/bin/env node` (or `env -S node …`) looks node up through
    // PATH at run time: pin node too and run the script with it.
    const viaEnv = program !== undefined && path.basename(program) === 'env';
    const name = viaEnv ? rest.find((arg) => !arg.startsWith('-')) : program;
    if (name === undefined)
      return failure('E_HARNESS_FAILED', `${resolved} has an unusable #! line`);
    interpreter = await whichExecutable(name, searchPath);
    if (interpreter === undefined)
      return failure(
        'E_HARNESS_NOT_FOUND',
        `${name} (the interpreter of ${resolved}) not found on PATH`,
      );
  }
  const files = await Promise.all(
    [...(interpreter === undefined ? [] : [interpreter]), resolved].map(
      async (file) => ({ path: file, fingerprint: await fingerprint(file) }),
    ),
  );
  return success(
    interpreter === undefined
      ? { command: resolved, prefixArgs: [], files }
      : { command: interpreter, prefixArgs: [resolved], files },
  );
}

/** Fail unless every pinned file is unchanged. */
export async function verifyPin(pin: PinnedHarness): Promise<Result<true>> {
  for (const file of pin.files) {
    let now: string;
    try {
      now = await fingerprint(file.path);
    } catch {
      now = '';
    }
    if (now !== file.fingerprint)
      return failure(
        'E_UNSAFE_WORKSPACE',
        `${file.path} changed after it was pinned (before the pull request's checks ran); refusing to launch it`,
      );
  }
  return success(true);
}

/** Fingerprint fixed files (for example the bridge server agent-ci spawns). */
export async function pinFiles(
  files: readonly string[],
): Promise<PinnedHarness> {
  const pinned = await Promise.all(
    files.map(async (file) => {
      const real = await realpath(file);
      return { path: real, fingerprint: await fingerprint(real) };
    }),
  );
  return { command: pinned[0]?.path ?? '', prefixArgs: [], files: pinned };
}
