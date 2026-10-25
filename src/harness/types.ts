import type { HomeRoot } from '@agent-ci/harness/home.js';
import type { HarnessId, Route } from '@agent-ci/routing/schema.js';

/**
 * Permission posture. `read-only` lets the agent read the workspace but not
 * edit it or run commands; `edit` lets it change files.
 */
export const RUN_MODES = ['read-only', 'edit'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** Everything an adapter needs to build one harness invocation. */
export interface HarnessRequest {
  readonly route: Route;
  readonly prompt: string;
  /** Workspace the agent runs in. */
  readonly cwd: string;
  readonly mode: RunMode;
  /** The isolated per-run home root. */
  readonly home: HomeRoot;
  /** Private directory for invocation files (output files, schemas). */
  readonly scratchDir: string;
  /** JSON Schema for the final answer, when the route supports one. */
  readonly jsonSchema?: Record<string, unknown> | undefined;
  /**
   * The parent environment. Adapters read ONLY the route's named credentials
   * and allowlisted base variables from it (see `env.ts`).
   */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
}

/** A fully built process invocation. */
export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** What the shared spawn observed. */
export interface ProcessOutput {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly durationMs: number;
}

/** Token usage when the harness reports it; absent counters stay undefined. */
export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

export type HarnessFailureCode =
  | 'E_HARNESS_NOT_FOUND'
  | 'E_HARNESS_AUTH'
  | 'E_HARNESS_FAILED'
  | 'E_HARNESS_TIMEOUT'
  | 'E_HARNESS_OUTPUT_LIMIT';

export type HarnessOutcome =
  | {
      readonly ok: true;
      /** The agent's final answer text. */
      readonly finalText: string;
      /** Schema-validated structured output, when the harness returned one. */
      readonly structured?: unknown;
      /** `null` when the harness did not report usage (never shown as zero). */
      readonly usage: Usage | null;
      readonly sessionId?: string;
    }
  | {
      readonly ok: false;
      readonly code: HarnessFailureCode;
      readonly message: string;
      /** True for transient failures the supervisor may retry. */
      readonly retryable: boolean;
      readonly usage?: Usage | null;
      readonly sessionId?: string;
    };

/** One harness CLI behind the common interface. */
export interface HarnessAdapter {
  readonly id: HarnessId;
  /** Executable name looked up on PATH. */
  readonly defaultCommand: string;
  /** Arguments that print the harness version (used by `doctor`). */
  readonly versionArgs: readonly string[];
  /**
   * Build argv and the child environment, and write any config or schema
   * files into the home root or scratch directory.
   */
  prepare(request: HarnessRequest): Promise<Invocation>;
  /** Turn process output into an outcome: final answer, usage, or a failure. */
  interpret(
    output: ProcessOutput,
    request: HarnessRequest,
  ): Promise<HarnessOutcome>;
}
