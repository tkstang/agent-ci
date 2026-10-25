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

/** Prepare, spawn and interpret one harness invocation. */
export async function runHarness(
  adapter: HarnessAdapter,
  request: HarnessRequest,
  limits: RunLimits,
  deps: RunHarnessDeps = {},
): Promise<HarnessRun> {
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
