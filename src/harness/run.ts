import { secretValuesFromEnv } from '@agent-ci/contracts/secret-guard.js';
import { CredentialLeakError } from '@agent-ci/harness/env.js';
import {
  type SpawnResult,
  spawnHarness,
  type SpawnSpec,
} from '@agent-ci/harness/spawn.js';
import type {
  HarnessAdapter,
  HarnessOutcome,
  HarnessRequest,
  Invocation,
} from '@agent-ci/harness/types.js';

export interface RunLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}

/**
 * Test seam: run a stand-in executable (for example `node fake-cli.mjs
 * <control>`) in place of the harness binary. The adapter's argv and
 * environment are passed through unchanged after `prefixArgs`.
 */
export interface CommandOverride {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
}

export interface RunHarnessDeps {
  readonly spawn?: (spec: SpawnSpec) => Promise<SpawnResult>;
  readonly commandOverride?: CommandOverride;
}

export interface HarnessRun {
  readonly outcome: HarnessOutcome;
  readonly invocation: Invocation;
  readonly durationMs?: number;
}

/** Credentials must travel by environment, never by argv. */
function assertNoCredentialInArgs(
  invocation: Invocation,
  request: HarnessRequest,
): void {
  const secrets = secretValuesFromEnv(
    request.parentEnv,
    request.route.credentials,
  );
  if (
    invocation.args.some((arg) =>
      secrets.some((secret) => arg.includes(secret)),
    )
  ) {
    throw new CredentialLeakError(
      'a credential value appeared in harness argv',
    );
  }
}

/** The request asks for a posture this adapter has not verified. */
export class UnsupportedPostureError extends Error {
  override readonly name = 'UnsupportedPostureError';
}

/**
 * Refuse a resume or a tool-free run on an adapter that has not verified
 * it, and a tool-free run outside read-only mode, before anything starts.
 */
export function assertSupportedPosture(
  adapter: HarnessAdapter,
  request: Pick<
    HarnessRequest,
    'resumeSessionId' | 'noTools' | 'mode' | 'toolBridge'
  >,
): void {
  if (request.toolBridge !== undefined) {
    if (!adapter.supportsToolBridge) {
      throw new UnsupportedPostureError(
        `${adapter.id} has no verified read-only tool bridge (verify-review's run_check)`,
      );
    }
    if (request.mode !== 'read-only' || request.noTools === true) {
      throw new UnsupportedPostureError(
        'a tool bridge is offered only in read-only runs that keep their tools',
      );
    }
    if (
      !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(request.toolBridge.server) ||
      !/^[a-z][a-z0-9_]{0,39}$/u.test(request.toolBridge.tool)
    ) {
      throw new UnsupportedPostureError('invalid tool bridge name');
    }
  }
  if (request.resumeSessionId !== undefined && !adapter.supportsResume) {
    throw new UnsupportedPostureError(
      `${adapter.id} has no verified session resume`,
    );
  }
  if (
    request.noTools === true &&
    (!adapter.supportsNoTools || request.mode !== 'read-only')
  ) {
    throw new UnsupportedPostureError(
      `${adapter.id} has no verified tool-free read-only posture`,
    );
  }
}

/** Prepare, spawn and interpret one harness invocation. */
export async function runHarness(
  adapter: HarnessAdapter,
  request: HarnessRequest,
  limits: RunLimits,
  deps: RunHarnessDeps = {},
): Promise<HarnessRun> {
  assertSupportedPosture(adapter, request);
  const invocation = await adapter.prepare(request);
  assertNoCredentialInArgs(invocation, request);
  const override = deps.commandOverride;
  const command = override?.command ?? invocation.command;
  const args = [...(override?.prefixArgs ?? []), ...invocation.args];
  const result = await (deps.spawn ?? spawnHarness)({
    command,
    args,
    cwd: request.cwd,
    env: invocation.env,
    timeoutMs: limits.timeoutMs,
    ...(limits.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: limits.maxOutputBytes }),
  });

  if (!result.started) {
    return {
      invocation,
      outcome: {
        ok: false,
        code:
          result.errorCode === 'ENOENT'
            ? 'E_HARNESS_NOT_FOUND'
            : 'E_HARNESS_FAILED',
        message:
          result.errorCode === 'ENOENT'
            ? `${adapter.id} executable not found: ${command}`
            : `could not start ${adapter.id}: ${result.message}`,
        retryable: false,
      },
    };
  }
  if (result.timedOut) {
    return {
      invocation,
      durationMs: result.durationMs,
      outcome: {
        ok: false,
        code: 'E_HARNESS_TIMEOUT',
        message: `${adapter.id} exceeded its ${limits.timeoutMs} ms deadline`,
        retryable: false,
      },
    };
  }
  if (result.outputLimitExceeded) {
    return {
      invocation,
      durationMs: result.durationMs,
      outcome: {
        ok: false,
        code: 'E_HARNESS_OUTPUT_LIMIT',
        message: `${adapter.id} exceeded the output capture limit`,
        retryable: false,
      },
    };
  }
  return {
    invocation,
    durationMs: result.durationMs,
    outcome: await adapter.interpret(result, request),
  };
}
