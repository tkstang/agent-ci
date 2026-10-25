import type { ErrorCode } from '@agent-ci/result.js';

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
    // House baseline: 1 = user-actionable, 2 = system/unexpected.
    this.exitCode = options?.exitCode ?? (code === 'E_UNEXPECTED' ? 2 : 1);
    this.hint = options?.hint;
  }
}

/** Prefer a type-guard over `instanceof` chains across module boundaries. */
export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}
