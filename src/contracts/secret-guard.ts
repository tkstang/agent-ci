import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * Secret guard, ported from pntr's `session-context.ts`
 * (`assertSecretFree`, `maskSecrets`). Callers pass the credential VALUES the
 * run had access to; this module only compares and never logs them.
 */

/**
 * Credential environment variables agent-ci knows about. Every one of them is
 * dropped from a child environment unless the resolved route names it, and
 * every present value is treated as a secret for output guarding.
 */
export const KNOWN_CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'CURSOR_API_KEY',
  'AGENT_CI_PROXY_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AGENT_CI_SOURCE_TOKEN',
] as const;

/** Values shorter than this are too ambiguous to guard by substring. */
const MIN_SECRET_LENGTH = 8;

/** Collect secret values for the named variables that are present. */
export function secretValuesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string[] {
  const values = new Set<string>();
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length >= MIN_SECRET_LENGTH)
      values.add(value);
  }
  return [...values];
}

/** True when any string (or object key) in `value` contains a secret. */
export function containsSecret(
  value: unknown,
  secrets: readonly string[],
): boolean {
  const active = secrets.filter((secret) => secret !== '');
  if (active.length === 0) return false;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (active.some((secret) => item.includes(secret))) return true;
    } else if (Array.isArray(item)) {
      pending.push(...item);
    } else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) pending.push(key, child);
    }
  }
  return false;
}

/** Fail with `E_SECRET_COPY` when `value` carries a secret. */
export function assertSecretFree(
  value: unknown,
  secrets: readonly string[],
): Result<void> {
  return containsSecret(value, secrets)
    ? failure(
        'E_SECRET_COPY',
        'output contains a credential value',
        'The agent output was withheld; inspect the run without credentials.',
      )
    : success(undefined);
}

/** Replace every secret occurrence in free text with `[REDACTED]`. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret !== '') result = result.split(secret).join('[REDACTED]');
  }
  return result;
}
