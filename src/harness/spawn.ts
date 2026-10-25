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
 * - the wait is bounded: a descendant that leaves the group (setsid) and
 *   keeps the pipes open cannot hold the run past deadline + grace, nor past
 *   the leader's exit + grace. Such a descendant may keep running; it is
 *   detached from the run, not killed.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** After SIGKILL, settle this long later even if the pipes never close. */
const HARD_SETTLE_MS = 100;

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
    const timers: NodeJS.Timeout[] = [];
    let forceScheduled = false;
    let exitInfo: { code: number | null; signal: string | null } | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (groupKill && child.pid !== undefined) kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        // ESRCH: already gone. EPERM: macOS reports it for a group whose
        // members have all exited (zombies). Either way the hard settle
        // below bounds the wait, so a missed signal cannot hang the run.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
    };

    /**
     * Resolve once. Destroying the pipes detaches us from any descendant
     * that left the process group (setsid) and still holds stdout/stderr:
     * `close` would otherwise wait for it indefinitely.
     */
    const settle = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      killGroup('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
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
    };

    /** SIGTERM the group, SIGKILL after the grace, then settle regardless. */
    const stop = (): void => {
      killGroup('SIGTERM');
      if (forceScheduled) return;
      forceScheduled = true;
      timers.push(
        setTimeout(() => {
          killGroup('SIGKILL');
          timers.push(
            setTimeout(
              () =>
                settle(
                  exitInfo?.code ?? child.exitCode,
                  exitInfo?.signal ?? child.signalCode,
                ),
              HARD_SETTLE_MS,
            ),
          );
        }, graceMs),
      );
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, spec.timeoutMs),
    );

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
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    // When the leader exits, take its group with it, and give the pipes a
    // short drain window before settling with the leader's exit status.
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      killGroup('SIGKILL');
      timers.push(setTimeout(() => settle(code, signal), graceMs));
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve({
        started: false,
        errorCode: error.code ?? 'UNKNOWN',
        message: error.message,
      });
    });
    child.on('close', (exitCode, signal) => settle(exitCode, signal));
  });
}
