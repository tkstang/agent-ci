import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { secretLeaves } from '@agent-ci/contracts/secret-guard.js';
import { spawnHarness } from '@agent-ci/harness/spawn.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import { isCiEnvironment } from '@agent-ci/routing/policy.js';
import type { HarnessId } from '@agent-ci/routing/schema.js';

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

/**
 * Create (or reuse) a home root. With no `root`, a fresh private temp
 * directory is allocated. A supplied root must be absolute and must not be a
 * symlink.
 */
export async function createHomeRoot(root?: string): Promise<Result<HomeRoot>> {
  let resolved: string;
  if (root === undefined) {
    resolved = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-home-'));
  } else {
    if (!path.isAbsolute(root)) {
      return failure('E_HOME_ROOT', 'home root must be an absolute path');
    }
    resolved = root;
    try {
      const info = await lstat(resolved);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        return failure(
          'E_HOME_ROOT',
          'home root must be a real directory, not a symlink or file',
        );
      }
    } catch {
      await mkdir(resolved, { recursive: true, mode: 0o700 });
    }
  }
  const layout = homeLayout(resolved);
  for (const dir of [...Object.values(layout.env), layout.skillsDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  // A kept root (--home-root) may hold a login seeded by an earlier run.
  // Every run starts without one; login routes seed afresh.
  await clearLoginStores(layout);
  return success(layout);
}

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
    return success({
      location: target,
      secrets: secretLeaves(await readFile(target, 'utf8')),
    });
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
      return fromExit === 0 && toExit === 0
        ? success({
            location: path.join(layout.env.XDG_DATA_HOME ?? '', 'opencode'),
            secrets: secretLeaves(transferred),
          })
        : failure(
            'E_SEED_UNSUPPORTED',
            `opencode login export/import failed (export ${fromExit}, import ${toExit})`,
          );
    }
    case 'cursor':
    case 'fake':
      return failure(
        'E_SEED_UNSUPPORTED',
        `${options.harness} logins cannot be seeded; use the route credential`,
      );
  }
}

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
  return result.started
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
): Promise<string[]> {
  const found = new Set<string>();
  for (const file of loginStorePaths(layout)) {
    if (!file.endsWith('.json')) continue;
    try {
      for (const value of secretLeaves(await readFile(file, 'utf8')))
        found.add(value);
    } catch {
      // store absent
    }
  }
  if (options.harness === 'opencode' && options.includeOpencodeStore) {
    const run = options.exportRunner ?? defaultExport;
    const exported = await run('opencode', ['auth', 'export', '--standalone'], {
      PATH: options.parentEnv.PATH ?? '/usr/bin:/bin',
      ...layout.env,
    });
    if (exported.exitCode === 0) {
      for (const value of secretLeaves(exported.stdout)) found.add(value);
    }
  }
  return [...found];
}
