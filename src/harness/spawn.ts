import { spawn } from 'node:child_process';

import type { ProcessOutput } from '@agent-ci/harness/types.js';

/**
 * The shared harness spawn, ported from pntr's supervisor `spawnAttempt`
 * (voxmedia/pntr@06cd380). Invariants:
 *
 * - stdin is ALWAYS ignored (`/dev/null`); `opencode run` and `codex exec`
 *   hang on an inherited stdin.
 * - the child leads its own process group, so a deadline or output overflow
 *   kills the whole tree (SIGTERM, then SIGKILL after a grace period), and
 *   stragglers are killed when the leader exits.
 * - stdout + stderr capture is capped; overflow stops the process.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
}

export type SpawnResult =
  | ({ readonly started: true } & ProcessOutput)
  | {
      readonly started: false;
      /** `ENOENT` when the executable is missing. */
      readonly errorCode: string;
      readonly message: string;
    };

export interface SpawnDeps {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly now?: () => number;
}

export function spawnHarness(
  spec: SpawnSpec,
  deps: SpawnDeps = {},
): Promise<SpawnResult> {
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const now = deps.now ?? Date.now;
  const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const graceMs = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const groupKill = process.platform !== 'win32';

  return new Promise<SpawnResult>((resolve) => {
    const startedAt = now();
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      detached: groupKill,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (groupKill && child.pid !== undefined) kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        // ESRCH: already gone. EPERM: macOS reports it for a group whose
        // members have all exited (zombies). Neither leaves a live process.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
    };
    const stop = (): void => {
      killGroup('SIGTERM');
      forceTimer ??= setTimeout(() => killGroup('SIGKILL'), graceMs);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);

    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (outputLimitExceeded) return;
      captured += chunk.length;
      if (captured > maxBytes) {
        outputLimitExceeded = true;
        stop();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    // When the leader exits, take any lingering descendants with it.
    child.on('exit', () => killGroup('SIGKILL'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({
        started: false,
        errorCode: error.code ?? 'UNKNOWN',
        message: error.message,
      });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      killGroup('SIGKILL');
      resolve({
        started: true,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputLimitExceeded,
        durationMs: now() - startedAt,
      });
    });
  });
}
