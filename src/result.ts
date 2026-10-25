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
export const ERROR_CODES = [
  // Input and configuration
  'E_INVALID_INPUT',
  'E_OUTPUT_PATH',
  'E_ROUTE_CONFIG',
  'E_ROUTE_NOT_FOUND',
  // Routing policy
  'E_POLICY_HARNESS',
  'E_POLICY_FALLBACK',
  'E_POLICY_ACCOUNT_FALLBACK',
  'E_POLICY_POOL',
  'E_POLICY_POOL_CI',
  'E_POLICY_CREDENTIAL',
  'E_POLICY_LOGIN_CI',
  'E_CREDENTIAL_MISSING',
  // Isolated home root
  'E_HOME_ROOT',
  'E_SEED_REFUSED',
  'E_SEED_UNSUPPORTED',
  // Harness execution
  'E_HARNESS_NOT_FOUND',
  'E_HARNESS_AUTH',
  'E_HARNESS_FAILED',
  'E_HARNESS_TIMEOUT',
  'E_HARNESS_OUTPUT_LIMIT',
  'E_CREDENTIAL_LEAK',
  'E_WORKSPACE_STATUS',
  'E_UNSAFE_WORKSPACE',
  'E_WORKSPACE_BUNDLE',
  // Results
  'E_INVALID_RUN_RESULT',
  'E_SECRET_COPY',
  'E_SECRET_GUARD',
  // Change sets and publishing
  'E_CHANGE_SET',
  'E_PUBLISH',
  // PR review
  'E_REVIEW_REQUEST',
  'E_REVIEW_INPUT',
  'E_REVIEW_GUIDANCE',
  'E_REVIEW_STALE_HEAD',
  'E_DIFF_TOO_LARGE',
  'E_INVALID_DIFF',
  'E_GITHUB_API',
] as const;

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
