import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeOwnedFile } from '@agent-ci/files.js';
import { failure, type Result, success } from '@agent-ci/result.js';
import {
  CHECK_LIMITS,
  type CheckEntry,
  checkEvidenceId,
  type ChecksEvidence,
  type CommandRecord,
  type Isolation,
  validateChecksEvidence,
} from '@agent-ci/review/checks.js';
import type { LoadedSpec } from '@agent-ci/review/prepare.js';
import { readHead } from '@agent-ci/run/changed-files.js';
import {
  findWorkspaceRoot,
  isWithin,
  resolveRealPath,
} from '@agent-ci/run/workspace.js';

/**
 * The verify stage: run every configured check on the pull request head in
 * a controlled environment and record `checks.json`.
 *
 * Where it runs is the boundary (DR-261025-run-verify-review-checks-where): in
 * Actions, a job that holds no model credential and no helper token; locally,
 * before the reviewer's home root or harness exist. Inside, every command is
 * controlled for hygiene and containment where the host allows:
 *
 * - a fresh copy of the post-setup tree per check (no `.git` anywhere, so a
 *   check cannot reach the clone's object store, hooks or config), removed
 *   afterwards; the checkout itself is never written;
 * - an environment built from a short allowlist (never a token, key or
 *   credential variable, even if allowlisted by name), a scratch HOME and
 *   TMPDIR, and a PATH without any entry inside the checkout or the copies;
 * - `/bin/bash -c` in its own process group, stdin closed, a deadline
 *   (SIGTERM, then SIGKILL), a 1 MiB output capture, and a SIGKILL of the
 *   whole group when the shell exits so nothing keeps running;
 * - Linux: user and pid namespaces (`unshare`), so every process of the
 *   command dies with it, plus a network namespace with only loopback for
 *   checks; macOS: `sandbox-exec` confining writes to the run's directory,
 *   refusing reads of agent-ci's output and home roots and of known
 *   credential stores, and (checks only) refusing the network except
 *   localhost. Each record names the isolation it got; without either tool
 *   it is `none` and the network is reachable.
 *
 * The setup command (dependency installation) keeps the network.
 */

export const VERIFY_FILES = Object.freeze({ evidence: 'checks.json' });

/** Variables a command may inherit; the scrubber still applies. */
export const CHECK_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'CI',
  'GITHUB_ACTIONS',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'NODE_ENV',
  'USER',
  'LOGNAME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);
const SECRET_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH/iu;

/** True for a variable name that must never reach a command. */
export function isSecretEnvName(name: string): boolean {
  return (
    SECRET_NAME.test(name) ||
    /^(ACTIONS_|RUNNER_|GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY|TOKEN))/u.test(
      name,
    )
  );
}

/**
 * PATH entries of the trusted PATH that are absolute and outside every
 * `excluded` directory, deduplicated in order.
 */
export function controlledPath(
  trustedPath: string,
  excluded: readonly string[],
): string {
  const entries = trustedPath
    .split(path.delimiter)
    .filter((entry) => entry !== '' && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry))
    .filter(
      (entry) => !excluded.some((dir) => isWithin(path.resolve(dir), entry)),
    );
  return [...new Set(entries)].join(path.delimiter);
}

/**
 * {@link controlledPath} over real paths: an entry is dropped when either
 * its spelling or its resolved location is inside an excluded directory
 * (macOS `/var` is `/private/var`; a PATH entry may be a link).
 */
export async function controlledRealPath(
  trustedPath: string,
  excludedReal: readonly string[],
): Promise<string> {
  const kept: string[] = [];
  for (const entry of controlledPath(trustedPath, excludedReal).split(
    path.delimiter,
  )) {
    if (entry === '') continue;
    const location = await resolveRealPath(entry).catch(() => entry);
    if (!excludedReal.some((dir) => isWithin(dir, location))) kept.push(entry);
  }
  return kept.join(path.delimiter);
}

/** The environment one command runs with. */
export function buildCheckEnv(input: {
  source: Readonly<Record<string, string | undefined>>;
  home: string;
  excludedPaths: readonly string[];
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHECK_ENV_ALLOWLIST) {
    const value = input.source[name];
    if (value !== undefined && !isSecretEnvName(name)) env[name] = value;
  }
  env.PATH = controlledPath(input.source.PATH ?? '', input.excludedPaths);
  env.HOME = input.home;
  env.TMPDIR = path.join(input.home, 'tmp');
  env.XDG_CONFIG_HOME = path.join(input.home, '.config');
  env.XDG_CACHE_HOME = path.join(input.home, '.cache');
  env.XDG_DATA_HOME = path.join(input.home, '.local', 'share');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(input.home, '.gitconfig');
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  return env;
}

export type ExecResult = {
  /** `null` when the process was killed (timeout or signal). */
  exitCode: number | null;
  output: Buffer;
  truncated: boolean;
  timedOut: boolean;
  /** Why stopping the process group failed, if it did. */
  cleanupError: string | null;
};
export type CommandExec = (input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}) => Promise<ExecResult>;

export const EXEC_TIMING = Object.freeze({ killGraceMs: 2000, drainMs: 1000 });

/**
 * Run argv in its own process group (ported from pntr's `run-check.ts`,
 * voxmedia/pntr@e438668). It resolves once the leader has exited and a
 * short drain window has passed, never waiting on pipe EOF, so a descendant
 * that left the group cannot hold the call open; the group is SIGKILLed
 * when the call settles.
 */
export const execCommand: CommandExec = ({
  argv,
  cwd,
  env,
  timeoutMs,
  maxBytes,
}) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error('empty argv'));
      return;
    }
    let cleanupError: string | null = null;
    const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH')
          cleanupError ??= `process group ${signal} failed: ${code ?? String(error)}`;
      }
    };
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    const timers: NodeJS.Timeout[] = [];
    const capture = (chunk: Buffer) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      if (chunk.length > room) truncated = true;
      const kept = chunk.subarray(0, room);
      chunks.push(Buffer.from(kept));
      size += kept.length;
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      killGroup(child.pid, 'SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        exitCode:
          timedOut || exit === null || exit.signal !== null ? null : exit.code,
        output: Buffer.concat(chunks),
        truncated,
        timedOut,
        cleanupError,
      });
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, 'SIGTERM');
        timers.push(
          setTimeout(() => {
            killGroup(child.pid, 'SIGKILL');
            timers.push(setTimeout(finish, EXEC_TIMING.drainMs));
          }, EXEC_TIMING.killGraceMs),
        );
      }, timeoutMs),
    );
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      timers.push(setTimeout(finish, EXEC_TIMING.drainMs));
    });
    child.on('close', (code, signal) => {
      exit ??= { code, signal };
      finish();
    });
  });

/** What the host can contain commands with. */
export type IsolationKind = Exclude<Isolation, 'none'> | 'none';

/** Probe once: `unshare` on Linux, `sandbox-exec` on macOS, else none. */
export function detectIsolation(
  platform: NodeJS.Platform = process.platform,
): IsolationKind {
  if (platform === 'linux') {
    const probe = spawnSync(
      'unshare',
      [...LINUX_NS, '--net', '--', '/bin/true'],
      { stdio: 'ignore', timeout: 10_000 },
    );
    return probe.status === 0 ? 'linux-namespaces' : 'none';
  }
  if (platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const probe = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/usr/bin/true'],
      { stdio: 'ignore', timeout: 10_000 },
    );
    return probe.status === 0 ? 'macos-sandbox' : 'none';
  }
  return 'none';
}

const LINUX_NS = [
  '--user',
  '--map-root-user',
  '--pid',
  '--fork',
  '--kill-child',
] as const;

/** Real-home paths a macOS-sandboxed command may not read or write. */
export function credentialStorePaths(realHome: string): string[] {
  return [
    '.ssh',
    '.aws',
    '.gnupg',
    '.config',
    '.claude',
    '.claude.json',
    '.codex',
    '.cursor',
    '.local/share/opencode',
    '.netrc',
    '.git-credentials',
    '.npmrc',
    '.docker',
    '.kube',
    'Library/Keychains',
  ].map((entry) => path.join(realHome, entry));
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

/** The macOS sandbox profile for one command. */
export function sandboxProfile(input: {
  work: string;
  denied: readonly string[];
  /** Directories whose `agent-ci-home-*` children are denied. */
  homeParents: readonly string[];
  network: boolean;
}): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sbplString(input.work)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))`,
    ...input.denied.map(
      (dir) => `(deny file-read* file-write* (subpath ${sbplString(dir)}))`,
    ),
    ...input.homeParents.map(
      (dir) =>
        `(deny file-read* file-write* (regex ${sbplString(`^${escapeRegex(dir)}/agent-ci-home-`)}))`,
    ),
  ];
  if (!input.network) {
    // Loopback only. `(local ip "localhost:*")` on outbound traffic would
    // allow every connection (live check 2026-10-25), so binding, inbound
    // and outbound are allowed separately.
    lines.push(
      '(deny network*)',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
    );
  }
  return `${lines.join('\n')}\n`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** argv that runs `command` under the given isolation. */
export function isolatedArgv(input: {
  isolation: IsolationKind;
  command: string;
  network: boolean;
  profile?: string;
}): string[] {
  const bash = ['/bin/bash', '-c', input.command];
  switch (input.isolation) {
    case 'linux-namespaces':
      return input.network
        ? ['unshare', ...LINUX_NS, '--', ...bash]
        : [
            'unshare',
            ...LINUX_NS,
            '--net',
            '--',
            '/bin/bash',
            '-c',
            // A new network namespace starts with loopback down.
            'ip link set lo up >/dev/null 2>&1 || true; exec /bin/bash -c "$1"',
            'agent-ci-check',
            input.command,
          ];
    case 'macos-sandbox':
      return ['/usr/bin/sandbox-exec', '-p', input.profile ?? '', ...bash];
    case 'none':
      return bash;
  }
}

/** Copy a tree without `.git` entries anywhere; links are copied as links. */
async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: (source) => path.basename(source) !== '.git',
  });
}

/** Give every directory under `current` back its owner's write bit. */
async function restoreWritable(current: string): Promise<void> {
  let info;
  try {
    info = await lstat(current);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;
  await chmod(current, 0o700).catch(() => undefined);
  for (const name of await readdir(current).catch(() => [])) {
    await restoreWritable(path.join(current, name));
  }
}

/** Remove a tree a command may have made unwritable. */
export async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch {
    // fall through: restore write permission on directories, then retry
  }
  await restoreWritable(dir);
  await rm(dir, { recursive: true, force: true });
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** The real path of `target`, or its resolved spelling when that fails. */
function real(target: string): Promise<string> {
  return resolveRealPath(path.resolve(target)).catch(() =>
    path.resolve(target),
  );
}

function record(
  command: string,
  result: ExecResult,
  durationMs: number,
  isolation: IsolationKind,
): CommandRecord {
  const tail = result.output.subarray(
    Math.max(0, result.output.length - CHECK_LIMITS.tailBytes),
  );
  return {
    command,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    truncated: result.truncated,
    output_sha256: createHash('sha256').update(result.output).digest('hex'),
    output_tail: decoder.decode(tail),
    duration_ms: Math.max(0, Math.round(durationMs)),
    isolation,
  };
}

export type VerifyOptions = {
  /** The PR head checkout (its top level is copied, never written). */
  readonly cwd: string;
  readonly spec: LoadedSpec;
  readonly outDir: string;
  /** Trusted parent environment (only allowlisted names are used). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Home roots and output directories commands must not reach. */
  readonly protectedPaths?: readonly string[];
  readonly git?: string;
  readonly log?: (message: string) => void;
};

export type VerifyDeps = {
  readonly exec?: CommandExec;
  readonly isolation?: IsolationKind;
  readonly now?: () => number;
  /** Real home whose credential stores the macOS sandbox denies. */
  readonly realHome?: string;
};

export type VerifyResult = {
  readonly evidence: ChecksEvidence;
  readonly evidencePath: string;
};

/** Run the configured checks and write `checks.json` to `outDir`. */
export async function runVerify(
  options: VerifyOptions,
  deps: VerifyDeps = {},
): Promise<Result<VerifyResult>> {
  const { spec } = options.spec;
  const verify = spec.verify;
  if (spec.request.mode !== 'verify-review' || verify === undefined)
    return failure(
      'E_REVIEW_INPUT',
      'the review spec is not a verify-review spec with a checks configuration',
    );
  const root = await findWorkspaceRoot(options.cwd, options.git);
  if (!root.ok) return root;
  const head = await readHead(root.value.root, options.git);
  if (!head.ok) return head;
  if (head.value !== spec.head_sha)
    return failure(
      'E_REVIEW_STALE_HEAD',
      `the checkout is at ${head.value ?? 'no commit'}, not the captured head ${spec.head_sha}`,
    );
  const outDir = await resolveRealPath(path.resolve(options.outDir));
  if (isWithin(root.value.root, outDir) || isWithin(outDir, root.value.root))
    return failure(
      'E_OUTPUT_PATH',
      'the verify output directory must be outside the checkout',
    );

  const exec = deps.exec ?? execCommand;
  const isolation = deps.isolation ?? detectIsolation();
  const now = deps.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const work = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-verify-'));
  try {
    // Real paths throughout: sandbox rules match resolved locations.
    const realWork = await resolveRealPath(work);
    const home = path.join(realWork, 'home');
    await mkdir(path.join(home, 'tmp'), { recursive: true, mode: 0o700 });
    const prepared = path.join(realWork, 'prepared');
    try {
      await copyTree(root.value.root, prepared);
    } catch (error) {
      return failure(
        'E_VERIFY_RUN',
        `could not copy the checkout (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
    const excluded = [root.value.root, realWork];
    const env = buildCheckEnv({
      source: options.env,
      home,
      excludedPaths: excluded,
    });
    env.PATH = await controlledRealPath(options.env.PATH ?? '', excluded);
    const realHome = deps.realHome ?? options.env.HOME ?? os.homedir();
    const denied = await Promise.all(
      [
        outDir,
        ...(options.protectedPaths ?? []),
        ...credentialStorePaths(realHome),
      ].map(real),
    );
    const homeParents = [
      ...new Set(await Promise.all([os.tmpdir(), '/tmp'].map(real))),
    ];
    const profile = (network: boolean) =>
      sandboxProfile({ work: realWork, denied, homeParents, network });
    const runOne = async (
      command: string,
      cwd: string,
      timeoutMinutes: number,
      network: boolean,
    ): Promise<CommandRecord> => {
      const started = now();
      const argv = isolatedArgv({
        isolation,
        command,
        network,
        ...(isolation === 'macos-sandbox' ? { profile: profile(network) } : {}),
      });
      let result: ExecResult;
      try {
        result = await exec({
          argv,
          cwd,
          env,
          timeoutMs: timeoutMinutes * 60_000,
          maxBytes: CHECK_LIMITS.outputBytes,
        });
      } catch (error) {
        result = {
          exitCode: null,
          output: Buffer.from(
            `agent-ci could not start the command: ${(error as NodeJS.ErrnoException).code ?? 'error'}\n`,
          ),
          truncated: false,
          timedOut: false,
          cleanupError: null,
        };
      }
      return record(command, result, now() - started, isolation);
    };

    const config = verify.config;
    let setup: CommandRecord | null = null;
    if (config.setup !== null) {
      log('agent-ci verify: setup');
      setup = await runOne(
        config.setup.command,
        prepared,
        config.setup.timeout_minutes,
        true,
      );
    }
    const setupFailed = setup !== null && setup.exit_code !== 0;
    const entries: CheckEntry[] = [];
    if (!setupFailed) {
      for (const [index, check] of config.checks.entries()) {
        const copy = path.join(realWork, `check-${index + 1}`);
        try {
          await copyTree(prepared, copy);
        } catch (error) {
          return failure(
            'E_VERIFY_RUN',
            `could not copy the prepared tree for ${check.name} (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
          );
        }
        log(`agent-ci verify: ${check.name}`);
        const ran = await runOne(
          check.command,
          copy,
          check.timeout_minutes,
          false,
        );
        await removeTree(copy);
        entries.push({
          evidence_id: checkEvidenceId({
            name: check.name,
            command: check.command,
            head_sha: spec.head_sha,
            exit_code: ran.exit_code,
            output_sha256: ran.output_sha256,
          }),
          name: check.name,
          ...ran,
        });
      }
    }
    const evidence: ChecksEvidence = {
      version: 1,
      repository: spec.repository,
      head_sha: spec.head_sha,
      config_sha256: verify.config_sha256,
      status: setupFailed ? 'setup-failed' : 'complete',
      setup,
      entries,
    };
    // The file this stage writes is the file the pass will validate.
    validateChecksEvidence(evidence, {
      repository: spec.repository,
      head_sha: spec.head_sha,
      verify,
    });
    await mkdir(outDir, { recursive: true });
    const evidencePath = path.join(outDir, VERIFY_FILES.evidence);
    await writeOwnedFile(
      evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      0o644,
    );
    return success({ evidence, evidencePath });
  } finally {
    await removeTree(work);
  }
}
