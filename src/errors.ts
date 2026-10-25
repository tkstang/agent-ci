import type { ErrorCode, Failure } from '@agent-ci/result.js';

/** Codes that describe a system or harness fault rather than a caller error. */
const SYSTEM_CODES: ReadonlySet<string> = new Set([
  'E_UNEXPECTED',
  'E_HARNESS_FAILED',
  'E_HARNESS_TIMEOUT',
  'E_HARNESS_OUTPUT_LIMIT',
  'E_CREDENTIAL_LEAK',
]);

/** Exit code for a code: 1 = user-actionable, 2 = system/unexpected. */
export function exitCodeFor(code: ErrorCode | 'E_UNEXPECTED'): number {
  return SYSTEM_CODES.has(code) ? 2 : 1;
}

/**
 * The boundary error model: a single typed class thrown at CLI/service edges
 * and caught by ONE central handler that maps `code` -> exit code / status.
 *
 * Invariant (shared with the result-envelope): callers switch on the stable
 * machine-readable `code`, never on the human `message`.
 */
export class CliError extends Error {
  override readonly name = 'CliError';
  readonly code: ErrorCode | 'E_UNEXPECTED';
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(
    code: ErrorCode | 'E_UNEXPECTED',
    message: string,
    options?: {
      readonly exitCode?: number;
      readonly hint?: string;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.exitCode = options?.exitCode ?? exitCodeFor(code);
    this.hint = options?.hint;
  }

  /** Lift a domain `Failure` to the boundary error. */
  static fromFailure(result: Failure): CliError {
    return new CliError(
      result.code,
      result.message,
      result.hint === undefined ? undefined : { hint: result.hint },
    );
  }
}

/** Prefer a type-guard over `instanceof` chains across module boundaries. */
export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}
