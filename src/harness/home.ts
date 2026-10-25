import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseSecretMaterial } from '@agent-ci/contracts/secret-guard.js';
import { spawnHarness } from '@agent-ci/harness/spawn.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import { isCiEnvironment } from '@agent-ci/routing/policy.js';
import type { HarnessId } from '@agent-ci/routing/schema.js';
import { isWithin, resolveRealPath } from '@agent-ci/run/workspace.js';

/**
 * One isolated home root per run (locally) or per job (Actions). Every
 * harness config home derives from it, so saved logins and helper settings in
 * the operator's real home cannot select another account. The skills
 * installer writes into the same root, so isolation and skill discovery share
 * one mechanism.
 */
export interface HomeRoot {
  /** The root directory that owns everything below. */
  readonly root: string;
  /** The child's HOME. */
  readonly home: string;
  /** Canonical skills directory (`~/.agents/skills`). */
  readonly skillsDir: string;
  /** Environment variables that point every harness at this root. */
  readonly env: Readonly<Record<string, string>>;
}

/** The layout below a root, without touching the filesystem. */
export function homeLayout(root: string): HomeRoot {
  const home = path.join(root, 'home');
  return {
    root,
    home,
    skillsDir: path.join(home, '.agents', 'skills'),
    env: {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'),
    },
  };
}

/** Entries a kept root may hold before validation gives up (fail closed). */
const MAX_VALIDATED_ENTRIES = 200_000;

export interface CreateHomeRootOptions {
  /**
   * Real path of the workspace boundary. No link under the root may resolve
   * into it (credentials and invocation files must stay out of the checkout).
   */
  readonly workspaceRoot?: string;
}

/**
 * Walk a kept root WITHOUT following links. Every symlink must resolve inside
 * the root and outside the workspace: a link such as `home/.codex -> <repo>`
 * would otherwise route login copies, clears and harness writes into the
 * checkout, and a link to the operator's real `~/.codex` would hand the run
 * an unnamed login. Provider skill views (links within the root) stay valid.
 */
async function validateKeptRoot(
  realRoot: string,
  workspaceRoot: string | undefined,
): Promise<Result<void>> {
  const pending = [realRoot];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop() ?? realRoot;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      return failure(
        'E_HOME_ROOT',
        `cannot inspect the home root at ${dir} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_VALIDATED_ENTRIES) {
        return failure(
          'E_HOME_ROOT',
          `home root ${realRoot} is too large to validate`,
          'Use a fresh home root.',
        );
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await resolveRealPath(full);
        } catch {
          return failure(
            'E_HOME_ROOT',
            `unresolvable symlink in home root: ${full}`,
          );
        }
        if (
          !isWithin(realRoot, target) ||
          (workspaceRoot !== undefined && isWithin(workspaceRoot, target))
        ) {
          return failure(
            'E_HOME_ROOT',
            `symlink ${full} in the home root points outside it or into the workspace`,
            'Remove the link or use a fresh home root.',
          );
        }
      }
    }
  }
  return success(undefined);
}

/**
 * Create (or reuse) a home root. With no `root`, a fresh private temp
 * directory is allocated. A supplied root must be absolute and a real
 * directory; an existing one is validated (see `validateKeptRoot`) before any
 * directory is created or login store cleared in it. Filesystem errors are
 * `E_HOME_ROOT`, never unexpected.
 */
export async function createHomeRoot(
  root?: string,
  options: CreateHomeRootOptions = {},
): Promise<Result<HomeRoot>> {
  let resolved: string;
  try {
    if (root === undefined) {
      resolved = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-home-'));
    } else {
      if (!path.isAbsolute(root)) {
        return failure('E_HOME_ROOT', 'home root must be an absolute path');
      }
      let exists = true;
      try {
        const info = await lstat(root);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          return failure(
            'E_HOME_ROOT',
            'home root must be a real directory, not a symlink or file',
          );
        }
      } catch {
        exists = false;
      }
      if (!exists) await mkdir(root, { recursive: true, mode: 0o700 });
      resolved = await resolveRealPath(root);
      const valid = await validateKeptRoot(resolved, options.workspaceRoot);
      if (!valid.ok) return valid;
    }
    const layout = homeLayout(resolved);
    for (const dir of [...Object.values(layout.env), layout.skillsDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // mkdir -p accepts an existing directory reached through nothing but
      // real directories here (validated above); re-check the leaf anyway.
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        return failure(
          'E_HOME_ROOT',
          `home layout path is not a directory: ${dir}`,
        );
      }
    }
    // A kept root (--home-root) may hold a login seeded by an earlier run.
    // Every run starts without one; login routes seed afresh.
    await clearLoginStores(layout);
    return success(layout);
  } catch (err) {
    return failure(
      'E_HOME_ROOT',
      `could not prepare the home root (${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : 'error')})`,
    );
  }
}

export { writeOwnedFile } from '@agent-ci/files.js';

/**
 * Harness login stores that can live inside a home root. OpenCode v2 keeps
 * its credential table in `opencode.db` (probe 2026-10-25); `auth.json` is
 * the v1 store.
 */
export function loginStorePaths(layout: HomeRoot): string[] {
  const data =
    layout.env.XDG_DATA_HOME ?? path.join(layout.home, '.local', 'share');
  const opencode = path.join(data, 'opencode');
  return [
    path.join(
      layout.env.CODEX_HOME ?? path.join(layout.home, '.codex'),
      'auth.json',
    ),
    path.join(
      layout.env.CLAUDE_CONFIG_DIR ?? path.join(layout.home, '.claude'),
      '.credentials.json',
    ),
    path.join(opencode, 'auth.json'),
    path.join(opencode, 'opencode.db'),
    path.join(opencode, 'opencode.db-wal'),
    path.join(opencode, 'opencode.db-shm'),
  ];
}

/** Remove every known login store from the root. */
export async function clearLoginStores(layout: HomeRoot): Promise<void> {
  for (const file of loginStorePaths(layout)) {
    await rm(file, { force: true });
  }
}

/**
 * Seed installed skills into the root: the canonical `~/.agents/skills` tree
 * plus the Claude provider view `~/.claude/skills`.
 */
export async function seedSkills(
  layout: HomeRoot,
  fromDir: string,
): Promise<Result<readonly string[]>> {
  try {
    const info = await lstat(fromDir);
    if (!info.isDirectory()) {
      return failure('E_HOME_ROOT', 'skills source must be a directory');
    }
  } catch {
    return failure('E_HOME_ROOT', `skills source not found: ${fromDir}`);
  }
  const targets = [
    layout.skillsDir,
    path.join(layout.env.CLAUDE_CONFIG_DIR ?? layout.home, 'skills'),
  ];
  for (const target of targets) {
    await cp(fromDir, target, { recursive: true, dereference: true });
  }
  return success(targets);
}

/** Pipes one command's stdout into another's stdin; never surfaces either stream. */
export type PipeRunner = (
  from: { command: string; args: string[]; env: Record<string, string> },
  to: { command: string; args: string[]; env: Record<string, string> },
) => Promise<{
  fromExit: number | null;
  toExit: number | null;
  /** The bytes that crossed the pipe, kept in memory for the secret guard. */
  transferred: string;
}>;

const defaultPipe: PipeRunner = (from, to) =>
  new Promise((resolve, reject) => {
    const producer = spawn(from.command, from.args, {
      env: from.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const consumer = spawn(to.command, to.args, {
      env: to.env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const chunks: Buffer[] = [];
    producer.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    producer.stdout.pipe(consumer.stdin);
    let fromExit: number | null = null;
    producer.on('error', reject);
    consumer.on('error', reject);
    producer.on('close', (code) => {
      fromExit = code;
    });
    consumer.on('close', (code) =>
      resolve({
        fromExit,
        toExit: code,
        transferred: Buffer.concat(chunks).toString('utf8'),
      }),
    );
  });

export interface SeedLoginOptions {
  readonly harness: HarnessId;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** The operator's real home; defaults to the parent HOME. */
  readonly realHome?: string;
  readonly pipe?: PipeRunner;
}

/** Where a login was seeded, and the token-like values it carries. */
export interface SeededLogin {
  readonly location: string;
  /** Secret values for the output guard. Never log them. */
  readonly secrets: readonly string[];
}

async function copyPrivate(
  source: string,
  target: string,
  harness: string,
): Promise<Result<SeededLogin>> {
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    const values = parseSecretMaterial(
      await readFile(target, 'utf8'),
      `the seeded ${harness} login`,
      { requireValues: true },
    );
    if (!values.ok) {
      await rm(target, { force: true });
      return values;
    }
    return success({ location: target, secrets: values.value });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return failure(
        'E_HOME_ROOT',
        `a ${harness} login is already present in the home root at ${target}`,
        'Each run clears login stores when it creates the home root; do not share a home root between concurrent runs.',
      );
    }
    if (code === 'ENOENT') {
      return failure(
        'E_SEED_UNSUPPORTED',
        `no ${harness} login file to seed at ${source}`,
      );
    }
    return failure(
      'E_SEED_UNSUPPORTED',
      `could not seed the ${harness} login (${code ?? 'unknown error'})`,
    );
  }
}

/**
 * Copy the operator's existing harness login into the root. Local runs only:
 * refused whenever CI or GITHUB_ACTIONS is set. The login's account is the
 * operator's; callers record which account a seeded run used.
 */
export async function seedLogin(
  layout: HomeRoot,
  options: SeedLoginOptions,
): Promise<Result<SeededLogin>> {
  if (isCiEnvironment(options.parentEnv)) {
    return failure(
      'E_SEED_REFUSED',
      'seeding an existing login is refused when CI or GITHUB_ACTIONS is set',
    );
  }
  const realHome = options.realHome ?? options.parentEnv.HOME ?? os.homedir();
  const basePath = options.parentEnv.PATH ?? '/usr/bin:/bin';
  switch (options.harness) {
    case 'codex':
      return copyPrivate(
        path.join(
          options.parentEnv.CODEX_HOME ?? path.join(realHome, '.codex'),
          'auth.json',
        ),
        path.join(layout.env.CODEX_HOME ?? '', 'auth.json'),
        'codex',
      );
    case 'claude':
      // Linux stores the login in a file; the macOS keychain login cannot be seeded.
      return copyPrivate(
        path.join(realHome, '.claude', '.credentials.json'),
        path.join(layout.env.CLAUDE_CONFIG_DIR ?? '', '.credentials.json'),
        'claude',
      );
    case 'opencode': {
      const pipe = options.pipe ?? defaultPipe;
      const sourceEnv: Record<string, string> = {
        PATH: basePath,
        HOME: realHome,
      };
      for (const name of [
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
      ]) {
        const value = options.parentEnv[name];
        if (value !== undefined) sourceEnv[name] = value;
      }
      const { fromExit, toExit, transferred } = await pipe(
        { command: 'opencode', args: ['auth', 'export'], env: sourceEnv },
        {
          command: 'opencode',
          args: ['auth', 'import', '--standalone'],
          env: { PATH: basePath, ...layout.env },
        },
      );
      if (fromExit !== 0 || toExit !== 0) {
        return failure(
          'E_SEED_UNSUPPORTED',
          `opencode login export/import failed (export ${fromExit}, import ${toExit})`,
        );
      }
      const values = parseSecretMaterial(
        transferred,
        'the exported opencode login',
        { requireValues: true },
      );
      if (!values.ok) return values;
      return success({
        location: path.join(layout.env.XDG_DATA_HOME ?? '', 'opencode'),
        secrets: values.value,
      });
    }
    case 'cursor':
    case 'fake':
      return failure(
        'E_SEED_UNSUPPORTED',
        `${options.harness} logins cannot be seeded; use the route credential`,
      );
  }
}

/** Login stores are small JSON files; anything larger is not read. */
const MAX_LOGIN_STORE_BYTES = 1024 * 1024;

/** Runs a credential-export command; output stays in memory. */
export type ExportRunner = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
) => Promise<{ exitCode: number | null; stdout: string }>;

const defaultExport: ExportRunner = async (command, args, env) => {
  const result = await spawnHarness({
    command,
    args,
    cwd: env.HOME ?? os.tmpdir(),
    env,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  // A missing executable, a timeout or truncated output is not a complete
  // read of the store: report it as a failed run so the guard fails closed.
  return result.started && !result.timedOut && !result.outputLimitExceeded
    ? { exitCode: result.exitCode, stdout: result.stdout }
    : { exitCode: null, stdout: '' };
};

export interface LoginSecretsOptions {
  readonly harness: HarnessId;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Also export the OpenCode credential store (login routes only). */
  readonly includeOpencodeStore: boolean;
  readonly exportRunner?: ExportRunner;
}

/**
 * Token-like values currently held in the root's login stores. A harness can
 * refresh its login during a run, so callers re-read after every attempt.
 * File stores are read directly; OpenCode v2 keeps credentials in SQLite, so
 * its isolated store is read through `opencode auth export --standalone`.
 * Values are for the output guard only and are never logged.
 */
export async function readLoginSecrets(
  layout: HomeRoot,
  options: LoginSecretsOptions,
): Promise<Result<string[]>> {
  const found = new Set<string>();
  for (const file of loginStorePaths(layout)) {
    if (!file.endsWith('.json')) continue;
    let info;
    try {
      info = await lstat(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return failure(
        'E_SECRET_GUARD',
        `credential guard incomplete: cannot inspect ${file}`,
      );
    }
    if (!info.isFile()) {
      return failure(
        'E_SECRET_GUARD',
        `credential guard incomplete: ${file} is not a regular file`,
      );
    }
    if (info.size > MAX_LOGIN_STORE_BYTES) {
      return failure(
        'E_SECRET_GUARD',
        `credential guard incomplete: ${file} is larger than a login store should be`,
      );
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return failure(
        'E_SECRET_GUARD',
        `credential guard incomplete: cannot read ${file}`,
      );
    }
    const values = parseSecretMaterial(text, file, { requireValues: false });
    if (!values.ok) return values;
    for (const value of values.value) found.add(value);
  }
  const opencodeDb = path.join(
    layout.env.XDG_DATA_HOME ?? path.join(layout.home, '.local', 'share'),
    'opencode',
    'opencode.db',
  );
  const storeExists = await lstat(opencodeDb).then(
    () => true,
    () => false,
  );
  if (
    options.harness === 'opencode' &&
    (options.includeOpencodeStore || storeExists)
  ) {
    const run = options.exportRunner ?? defaultExport;
    let exported: { exitCode: number | null; stdout: string };
    try {
      exported = await run('opencode', ['auth', 'export', '--standalone'], {
        PATH: options.parentEnv.PATH ?? '/usr/bin:/bin',
        ...layout.env,
      });
    } catch {
      exported = { exitCode: null, stdout: '' };
    }
    if (exported.exitCode !== 0) {
      return failure(
        'E_SECRET_GUARD',
        `credential guard incomplete: opencode auth export ${
          exported.exitCode === null
            ? 'did not run to completion'
            : `exited ${exported.exitCode}`
        }`,
      );
    }
    const values = parseSecretMaterial(exported.stdout, 'the opencode export', {
      requireValues: false,
    });
    if (!values.ok) return values;
    for (const value of values.value) found.add(value);
  }
  return success([...found]);
}
