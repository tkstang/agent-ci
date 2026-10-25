/**
 * The house result-envelope: a discriminated union over `ok` with a CLOSED
 * error-code tuple. Pure/domain logic returns these instead of throwing, so
 * callers must handle every failure path and never string-match on messages.
 *
 * Boundaries (see `errors.ts` + `cli.ts`) are where we throw a typed error.
 */

/**
 * Closed set of domain error codes. Add codes here deliberately; the union is
 * the contract. Keep them machine-readable (`E_*`), never free-form strings.
 */
export const ERROR_CODES = ['E_INVALID_INPUT', 'E_EMPTY_INPUT'] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A successful result carrying the parsed value. */
export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

/** A failed result carrying a machine-readable code + an actionable hint. */
export interface Failure {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
  /** Optional human/agent-actionable next step. */
  readonly hint?: string;
}

export type Result<T> = Success<T> | Failure;

export function success<T>(value: T): Success<T> {
  return { ok: true, value };
}

export function failure(
  code: ErrorCode,
  message: string,
  hint?: string,
): Failure {
  return hint === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, hint };
}

/** Narrowing helper so callers can branch without touching `.ok` directly. */
export function isSuccess<T>(result: Result<T>): result is Success<T> {
  return result.ok;
}
