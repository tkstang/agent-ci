import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
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

import { maskSecrets } from '@agent-ci/contracts/secret-guard.js';
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

/** Absolute paths of the Linux isolation tools, verified before use. */
export type LinuxTools = {
  readonly unshare: string;
  readonly mount: string;
  /** Brings loopback up in a new network namespace; optional. */
  readonly ip: string | null;
};

/** Fixed system locations; PATH is never consulted for these tools. */
export const LINUX_TOOL_CANDIDATES = Object.freeze({
  unshare: ['/usr/bin/unshare', '/bin/unshare'],
  mount: ['/usr/bin/mount', '/bin/mount'],
  ip: ['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip', '/bin/ip'],
});

/** Root-owned and not writable by group or others (file: also executable). */
function rootOwned(target: string, regular: boolean): boolean {
  try {
    const info = statSync(target);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0) return false;
    return regular
      ? info.isFile() && (info.mode & 0o111) !== 0
      : info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The first candidate whose resolved file is a regular, executable file
 * owned by root and not writable by group or others, under directories
 * that are all owned by root and not writable by group or others. A tool
 * the checked code could replace (anything in a user-writable PATH entry,
 * such as `~/.local/bin` or a tool cache) is never used: a planted
 * `unshare` or `mount` would otherwise run every later check with no
 * namespace while the record still claimed one.
 */
export function trustedSystemBinary(
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    let resolved: string;
    try {
      lstatSync(candidate);
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!rootOwned(resolved, true)) continue;
    let dir = path.dirname(resolved);
    let ok = true;
    for (;;) {
      if (!rootOwned(dir, false)) {
        ok = false;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (ok) return resolved;
  }
  return undefined;
}

/** The verified Linux tools, or undefined when `unshare` or `mount` is not. */
export function resolveLinuxTools(
  candidates: typeof LINUX_TOOL_CANDIDATES = LINUX_TOOL_CANDIDATES,
): LinuxTools | undefined {
  const unshare = trustedSystemBinary(candidates.unshare);
  const mount = trustedSystemBinary(candidates.mount);
  if (unshare === undefined || mount === undefined) return undefined;
  return { unshare, mount, ip: trustedSystemBinary(candidates.ip) ?? null };
}

/**
 * Probe once: verified `unshare` on Linux (with the exact flags checks use),
 * `sandbox-exec` on macOS, else none. The recorded isolation comes from this
 * launcher-side check, never from a report by the checked code.
 */
export function detectIsolation(
  platform: NodeJS.Platform = process.platform,
  tools: LinuxTools | undefined = platform === 'linux'
    ? resolveLinuxTools()
    : undefined,
): IsolationKind {
  if (platform === 'linux') {
    if (tools === undefined) return 'none';
    const probe = spawnSync(
      tools.unshare,
      [...LINUX_NS, '--net', '--', '/bin/true'],
      { stdio: 'ignore', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } },
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
  '--mount',
  '--pid',
  '--fork',
  '--kill-child',
  '--mount-proc',
] as const;

/**
 * The Linux namespace init script (bash, run as root of the new user
 * namespace). Arguments: the command, `1` when it keeps the network, then
 * the paths to hide. It brings loopback up in a new network namespace,
 * mounts an empty tmpfs over every hidden directory and `/dev/null` over
 * every hidden file (failing with 125 when it cannot: no silent
 * degradation), then runs the command in a NESTED user and mount namespace.
 * Mounts inherited by a less privileged mount namespace are locked, so the
 * command cannot unmount them to reach what they cover, and `/proc` shows
 * only this pid namespace (no other process's environment).
 */
export const LINUX_INIT = [
  // Every tool is an absolute, launcher-verified path argument: nothing
  // here is looked up through the (checked-code-writable) PATH.
  'cmd=$1; net=$2; unshare_bin=$3; mount_bin=$4; ip_bin=$5; work=$6; shift 6',
  'fail() { echo "agent-ci: $1" >&2; exit 125; }',
  'if [ "$net" = 0 ] && [ -n "$ip_bin" ]; then "$ip_bin" link set lo up >/dev/null 2>&1 || true; fi',
  // The run directory (prepared tree, copies, scratch HOME) becomes its own
  // mount first, so it alone stays writable below.
  '"$mount_bin" --bind "$work" "$work" || fail "could not keep $work writable"',
  'for p in "$@"; do',
  '  if [ -d "$p" ]; then "$mount_bin" -t tmpfs -o size=16k agent-ci-hidden "$p" || fail "could not hide $p"',
  '  elif [ -e "$p" ]; then "$mount_bin" --bind /dev/null "$p" || fail "could not hide $p"',
  '  fi',
  'done',
  // Every other mount read-only: the operator's home, writable PATH
  // directories, tool caches and agent-ci's own install, so nothing the
  // command writes can be run later by agent-ci or the operator.
  'while read -r _ mp _; do',
  '  case "$mp" in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*) continue ;; esac',
  '  [ "$mp" = "$work" ] && continue',
  // A mount covered by a later hidden mount (the output directory inside
  // RUNNER_TEMP) is unreachable by path: nothing to make read-only.
  '  [ -e "$mp" ] || continue',
  '  "$mount_bin" -o remount,bind,ro "$mp" 2>/dev/null || fail "could not make $mp read-only"',
  'done < /proc/self/mounts',
  // Re-enter the working directory through the new mounts (the old cwd
  // still points into the mount that is now read-only).
  'cd -- "$PWD" || fail "could not re-enter $PWD"',
  'exec "$unshare_bin" --user --map-root-user --mount -- /bin/bash -c "$cmd"',
].join('\n');

/**
 * Real-home paths a command may not read or write (denied by the macOS
 * profile, mounted over on Linux). Hygiene on macOS, where the sandbox is
 * not a credential boundary (see `requireCredentialIsolation`).
 */
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
    // Shell startup and history files often export or echo tokens.
    '.zshrc',
    '.zshenv',
    '.zprofile',
    '.zlogin',
    '.zsh_history',
    '.bashrc',
    '.bash_profile',
    '.bash_history',
    '.profile',
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
  /** Linux: absolute paths hidden from the command (see LINUX_INIT). */
  hidden?: readonly string[];
  /** Linux: the verified tools (required for `linux-namespaces`). */
  tools?: LinuxTools;
  /** Linux: the run directory, the only writable path (required). */
  work?: string;
}): string[] {
  const bash = ['/bin/bash', '-c', input.command];
  switch (input.isolation) {
    case 'linux-namespaces': {
      const tools = input.tools;
      if (tools === undefined || input.work === undefined)
        throw new Error(
          'linux-namespaces needs the verified tool paths and the run directory',
        );
      return [
        tools.unshare,
        ...LINUX_NS,
        ...(input.network ? [] : ['--net']),
        '--',
        '/bin/bash',
        '-c',
        LINUX_INIT,
        'agent-ci-check',
        input.command,
        input.network ? '1' : '0',
        tools.unshare,
        tools.mount,
        tools.ip ?? '',
        input.work,
        ...(input.hidden ?? []),
      ];
    }
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

/**
 * Give every directory under `current` back its owner's write bit. Only a
 * directory reached without following a link is changed, and it is checked
 * again (same device and inode) just before the change, so a process that
 * outlived its command cannot swap in a link to redirect the chmod.
 */
async function restoreWritable(current: string): Promise<void> {
  let info;
  try {
    info = await lstat(current);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;
  const again = await lstat(current).catch(() => undefined);
  if (
    again !== undefined &&
    again.isDirectory() &&
    again.dev === info.dev &&
    again.ino === info.ino
  )
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

/**
 * Values of credential-like variables in the parent environment (8 or more
 * characters). A check's output tail reaches the reviewer, which could copy
 * it into a published finding, so these values are masked in the tail.
 * Encoded or partial copies are not caught (the output-guard limit p02
 * records); the digest still covers the raw output.
 */
export function secretValues(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return [
    ...new Set(
      Object.entries(env)
        .filter(
          ([name, value]) =>
            value !== undefined &&
            value.length >= 8 &&
            // Secret-like names only: RUNNER_* and ACTIONS_* are excluded
            // from the command environment but hold paths and URLs, and
            // masking those garbles the output (RUNNER_TEMP, live run).
            SECRET_NAME.test(name),
        )
        .map(([, value]) => value as string),
    ),
  ].toSorted((a, b) => b.length - a.length);
}

/** The last `maxBytes` of `text` as UTF-8, never splitting a character. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80)
    start += 1;
  return bytes.subarray(start).toString('utf8');
}

/**
 * The output tail the evidence keeps. The WHOLE capture is decoded and
 * masked first (so a secret is never cut in half at the tail's start); when
 * the capture was cut at its byte limit, a trailing prefix of a secret is
 * masked too; then the sanitized text is bounded to `tailBytes` of UTF-8.
 * Invalid bytes become U+FFFD and `[REDACTED]` may be longer than what it
 * replaces, so the bound applies after both, never before.
 */
export function sanitizedTail(
  output: Buffer,
  truncated: boolean,
  secrets: readonly string[],
): string {
  let text = maskSecrets(decoder.decode(output), secrets);
  if (truncated)
    for (const secret of secrets)
      for (let length = secret.length - 1; length >= 4; length -= 1)
        if (text.endsWith(secret.slice(0, length))) {
          text = `${text.slice(0, text.length - length)}[REDACTED]`;
          break;
        }
  return utf8Tail(text, CHECK_LIMITS.tailBytes);
}

function record(
  command: string,
  result: ExecResult,
  durationMs: number,
  isolation: IsolationKind,
  secrets: readonly string[],
): CommandRecord {
  return {
    command,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    truncated: result.truncated,
    output_sha256: createHash('sha256').update(result.output).digest('hex'),
    output_tail: sanitizedTail(result.output, result.truncated, secrets),
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
  /**
   * Local runs: refuse. No local posture is a credential boundary, so a
   * caller that sets this always gets `E_VERIFY_RUN` (the operator's
   * `--verify-trust-pr-code` acknowledgment is the only way to run locally).
   * - macOS `sandbox-exec`: a sandboxed command still reads the environment
   *   of agent-ci and of other same-user non-platform processes
   *   (`KERN_PROCARGS2`; no profile rule stops it) and queries the login
   *   Keychain through securityd.
   * - Linux namespaces: pathname Unix sockets stay reachable (read-only
   *   mounts and namespaces do not stop `connect`), so a check can ask a
   *   host broker (systemd user manager, rootless container daemon, D-Bus
   *   services) to start a process outside the namespaces.
   * Only Actions' credential-free, discarded verify job runs checks without
   * this, because the job boundary is the isolation there.
   */
  readonly requireCredentialIsolation?: boolean;
  readonly git?: string;
  readonly log?: (message: string) => void;
};

/** The host broker socket directories that exist (Linux only). */
export function brokerDirectories(input: {
  platform: NodeJS.Platform;
  uid: number | undefined;
  xdgRuntimeDir: string | undefined;
  isDirectory?: (dir: string) => boolean;
}): string[] {
  if (input.platform !== 'linux') return [];
  const isDirectory =
    input.isDirectory ??
    ((dir: string) => existsSync(dir) && statSync(dir).isDirectory());
  return [
    ...new Set([
      ...(input.uid === undefined ? [] : [`/run/user/${input.uid}`]),
      ...(input.xdgRuntimeDir === undefined || input.xdgRuntimeDir === ''
        ? []
        : [input.xdgRuntimeDir]),
      '/run/dbus',
      '/run/podman',
      '/run/containerd',
      '/run/docker',
    ]),
  ].filter((dir) => path.isAbsolute(dir) && isDirectory(dir));
}

/**
 * The first temp parent (real path) outside every hidden directory, so
 * hiding a broker directory never covers the run directory; the first
 * candidate when none is outside (the hidden list then drops the overlap).
 */
export function chooseWorkParent(
  candidates: readonly string[],
  hidden: readonly string[],
): string {
  return (
    // Only an ancestor matters: the run directory is a new child of the
    // parent, so a hidden sibling or descendant of the parent cannot cover it.
    candidates.find((dir) => !hidden.some((h) => isWithin(h, dir))) ??
    candidates[0] ??
    os.tmpdir()
  );
}

/** `agent-ci-home-*` directories under `parents` (other runs' home roots). */
async function homeRoots(parents: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const parent of parents)
    for (const name of await readdir(parent).catch(() => []))
      if (name.startsWith('agent-ci-home-'))
        found.push(path.join(parent, name));
  return found;
}

export type VerifyDeps = {
  readonly exec?: CommandExec;
  readonly isolation?: IsolationKind;
  /** Linux tools (test seam; default: resolved from fixed system paths). */
  readonly linuxTools?: LinuxTools;
  /** Effective uid (test seam; default: process.geteuid()). */
  readonly euid?: number;
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
  // Linux tools are resolved and verified once, here, before any checked
  // code runs; without them there is no namespace isolation to record.
  // As root, "root-owned" protects nothing: a command mapped to uid 0 can
  // rename over /usr/bin/unshare (review r2 probe). Root gets no isolation.
  const euid = deps.euid ?? process.geteuid?.();
  const linuxTools =
    euid === 0
      ? undefined
      : (deps.linuxTools ??
        (process.platform === 'linux' ? resolveLinuxTools() : undefined));
  const detected =
    deps.isolation ?? detectIsolation(process.platform, linuxTools);
  const isolation: IsolationKind =
    detected === 'linux-namespaces' && linuxTools === undefined
      ? 'none'
      : detected;
  if (options.requireCredentialIsolation === true)
    return failure(
      'E_VERIFY_RUN',
      isolation === 'macos-sandbox'
        ? "verify-review would run the pull request's code on this Mac as you. macOS sandbox-exec confines its file writes and network, but the code can still read the environment of agent-ci and of your other processes (which may hold model and GitHub credentials) and query your login Keychain"
        : isolation === 'linux-namespaces'
          ? "verify-review would run the pull request's code on this machine as you. Linux namespaces hide other processes, cut the network and make the host read-only, but host service sockets (the systemd user manager, rootless container daemons, D-Bus) stay reachable and could start a process outside them"
          : "verify-review would run the pull request's code on this machine as you with no isolation at all (no Linux user namespaces with root-owned tools as a non-root user, and no macOS sandbox)",
      'Let the Actions verify job run the checks (a credential-free runner that is discarded afterwards). Pass --verify-trust-pr-code only for pull requests whose code you would run yourself; agent-ci then keeps its isolation as hygiene, not as a boundary.',
    );
  const now = deps.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  // The output directory exists (a real directory) before any command runs,
  // so a command cannot plant a link where checks.json will be written.
  await mkdir(outDir, { recursive: true });
  if (!(await lstat(outDir)).isDirectory())
    return failure(
      'E_OUTPUT_PATH',
      'the verify output path is not a directory',
    );
  // Broker socket directories are hidden (hygiene). The run directory must
  // live outside every one of them: a tmpfs over its ancestor would hide
  // the copies and HOME, and the init's `cd` would fail (TMPDIR under
  // XDG_RUNTIME_DIR, gate 2 M1). Pick a temp parent outside them.
  const brokers = await Promise.all(
    brokerDirectories({
      platform: process.platform,
      uid: process.getuid?.(),
      xdgRuntimeDir: options.env.XDG_RUNTIME_DIR,
    }).map(real),
  );
  const workParent = chooseWorkParent(
    await Promise.all(
      [os.tmpdir(), '/tmp', '/var/tmp']
        .filter((dir) => existsSync(dir))
        .map(real),
    ),
    brokers,
  );
  const work = await mkdtemp(path.join(workParent, 'agent-ci-verify-'));
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
    const homeParents = [
      ...new Set(await Promise.all([os.tmpdir(), '/tmp'].map(real))),
    ];
    // Hidden from every command: agent-ci's output, the protected paths,
    // the checkout (already copied), credential stores in the real home,
    // the runner's temp (step outputs, helpers, the spec), and other runs'
    // home roots. macOS denies them in the profile; Linux mounts over them.
    const denied = [
      ...new Set(
        await Promise.all(
          [
            outDir,
            ...(options.protectedPaths ?? []),
            root.value.root,
            ...credentialStorePaths(realHome),
            ...(options.env.RUNNER_TEMP === undefined ||
            options.env.RUNNER_TEMP === ''
              ? []
              : [options.env.RUNNER_TEMP]),
          ].map(real),
        ),
      ),
    ].filter((dir) => !isWithin(dir, realWork) && !isWithin(realWork, dir));
    // Hygiene, not a boundary (pathname sockets elsewhere stay reachable):
    // the usual host broker socket directories, never one that overlaps the
    // run directory (the same canonical exclusion as `denied`; only possible
    // when no temp parent outside them existed).
    const hidden = [
      ...new Set([
        ...denied,
        ...(await homeRoots(homeParents)),
        ...brokers.filter(
          (dir) => !isWithin(dir, realWork) && !isWithin(realWork, dir),
        ),
      ]),
    ];
    const secrets = secretValues(options.env);
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
        ...(isolation === 'linux-namespaces' && linuxTools !== undefined
          ? { hidden, tools: linuxTools, work: realWork }
          : {}),
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
      return record(command, result, now() - started, isolation, secrets);
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
    // Still the real directory created above (Linux commands saw a tmpfs
    // over it; macOS commands could not write it).
    const outInfo = await lstat(outDir);
    if (outInfo.isSymbolicLink() || !outInfo.isDirectory())
      return failure('E_OUTPUT_PATH', 'the verify output path changed');
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
