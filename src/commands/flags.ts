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
