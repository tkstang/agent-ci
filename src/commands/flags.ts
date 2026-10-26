import { parseArgs, type ParseArgsConfig } from 'node:util';

import { CliError } from '@agent-ci/errors.js';

type Options = NonNullable<ParseArgsConfig['options']>;

/** Strict flag parsing: unknown flags and stray positionals are user errors. */
export function parseFlags<T extends Options>(
  argv: readonly string[],
  options: T,
  usage: string,
) {
  try {
    return parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    throw new CliError(
      'E_INVALID_INPUT',
      err instanceof Error ? err.message : String(err),
      { hint: usage },
    );
  }
}

/**
 * An optional string flag where an empty value means "not set". Workflow
 * steps pass optional inputs unconditionally (`--harness "$HARNESS"`), so an
 * empty string must behave like an absent flag.
 */
export function optional(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** A required string flag. */
export function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new CliError('E_INVALID_INPUT', `${flag} is required`);
  }
  return value;
}

/** A positive integer flag with a default. */
export function positiveInt(
  value: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError('E_INVALID_INPUT', `${flag} must be a positive integer`);
  }
  return parsed;
}

/** A non-negative integer flag with a default. */
export function nonNegativeInt(
  value: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(
      'E_INVALID_INPUT',
      `${flag} must be a non-negative integer`,
    );
  }
  return parsed;
}

/** One of a closed set of values. */
export function oneOf<T extends string>(
  value: string | undefined,
  flag: string,
  allowed: readonly T[],
  fallback?: T,
): T | undefined {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(
      'E_INVALID_INPUT',
      `${flag} must be one of: ${allowed.join(', ')}`,
    );
  }
  return value as T;
}

/**
 * The pool opt-in: `--allow-pool`, or its workflow form
 * `--allow-pool-value <true|false>` (a workflow passes its boolean
 * `allow_pool` input unconditionally; empty means false).
 */
export function poolOptIn(flags: {
  readonly 'allow-pool'?: boolean | undefined;
  readonly 'allow-pool-value'?: string | undefined;
}): boolean {
  const value = optional(flags['allow-pool-value']);
  if (value !== undefined && !['true', 'false'].includes(value)) {
    throw new CliError(
      'E_INVALID_INPUT',
      '--allow-pool-value must be true or false',
    );
  }
  return flags['allow-pool'] === true || value === 'true';
}
