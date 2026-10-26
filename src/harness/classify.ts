import type { HarnessFailureCode } from '@agent-ci/harness/types.js';

/**
 * Failure classification shared by every adapter. Authentication failures
 * are never retried; transient provider or network failures may be. Patterns
 * come from the 2026-10-25 live probes (see the project's
 * `harness-probes-2026-10-25.md`) plus common provider status codes.
 */

export const AUTH_PATTERNS: readonly RegExp[] = [
  /\b401\b/u,
  /unauthori[sz]ed/iu,
  /not logged in/iu,
  /authentication required/iu,
  /invalid (?:api|x-api) key/iu,
  /missing (?:environment variable|bearer)/iu,
  /provider\.no-route/iu,
];

export const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b(?:429|500|502|503|504|529)\b/u,
  /rate[ _-]?limit/iu,
  /overloaded/iu,
  /resource[ _-]exhausted/iu,
  /temporarily unavailable/iu,
  /stream disconnected/iu,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)\b/u,
  /socket hang up/iu,
];

export interface Classification {
  readonly code: Extract<
    HarnessFailureCode,
    'E_HARNESS_AUTH' | 'E_HARNESS_FAILED'
  >;
  readonly retryable: boolean;
}

/** Classify a harness failure from its diagnostic text. */
export function classifyFailure(
  text: string,
  extra: { auth?: readonly RegExp[]; transient?: readonly RegExp[] } = {},
): Classification {
  const auth = [...AUTH_PATTERNS, ...(extra.auth ?? [])];
  if (auth.some((pattern) => pattern.test(text))) {
    return { code: 'E_HARNESS_AUTH', retryable: false };
  }
  const transient = [...TRANSIENT_PATTERNS, ...(extra.transient ?? [])];
  return {
    code: 'E_HARNESS_FAILED',
    retryable: transient.some((pattern) => pattern.test(text)),
  };
}

/** Keep diagnostics short enough for an envelope or run-log line. */
export function truncate(text: string, max = 2_000): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
