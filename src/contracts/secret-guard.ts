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
  'AGENT_CI_CREDENTIAL',
] as const;

/** Values shorter than this are too ambiguous to guard by substring. */
const MIN_SECRET_LENGTH = 8;

/**
 * Token-like values inside credential material (a login file or an exported
 * credential store): string leaves with no whitespace that are either 16+
 * characters, or 8+ characters mixing letters and digits. Plain words such as
 * an account label ("Personal") are not secrets and would only cause false
 * `E_SECRET_COPY` failures. Non-JSON text yields its token-like runs.
 * Used to guard outputs; the values are never logged.
 */
export function secretLeaves(material: string): string[] {
  const found = new Set<string>();
  const keep = (value: string) => {
    if (/\s/u.test(value) || value.length < MIN_SECRET_LENGTH) return;
    const mixed = /[a-z]/iu.test(value) && /\d/u.test(value);
    if (value.length >= 16 || mixed) found.add(value);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(material);
  } catch {
    for (const run of material.split(/[\s"',{}[\]:]+/u)) keep(run);
    return [...found];
  }
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') keep(item);
    else if (Array.isArray(item)) pending.push(...item);
    else if (item !== null && typeof item === 'object')
      pending.push(...Object.values(item));
  }
  return [...found];
}

/**
 * Strict form of `secretLeaves` for login material the output guard depends
 * on: the material must be JSON (an unparseable store means the guard cannot
 * know what to protect), and seeded material must yield at least one value.
 * Failures are `E_SECRET_GUARD` with a value-free message.
 */
export function parseSecretMaterial(
  material: string,
  source: string,
  options: { readonly requireValues: boolean },
): Result<string[]> {
  try {
    JSON.parse(material);
  } catch {
    return failure(
      'E_SECRET_GUARD',
      `credential guard incomplete: ${source} is not valid JSON`,
    );
  }
  const values = secretLeaves(material);
  if (options.requireValues && values.length === 0) {
    return failure(
      'E_SECRET_GUARD',
      `credential guard incomplete: no credential values found in ${source}`,
    );
  }
  return success(values);
}

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
