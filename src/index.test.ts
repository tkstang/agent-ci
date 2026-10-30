import {
  CliError,
  ERROR_CODES,
  exitCodeFor,
  failure,
  isCliError,
  isSuccess,
  success,
} from '@agent-ci/index.js';
import { describe, expect, it } from 'vitest';

describe('result envelope', () => {
  it('narrows success and failure', () => {
    expect(isSuccess(success(1))).toBe(true);
    const failed = failure('E_INVALID_INPUT', 'bad', 'fix it');
    expect(isSuccess(failed)).toBe(false);
    expect(failed).toEqual({
      ok: false,
      code: 'E_INVALID_INPUT',
      message: 'bad',
      hint: 'fix it',
    });
  });

  it('keeps every error code in the E_* namespace', () => {
    for (const code of ERROR_CODES) expect(code).toMatch(/^E_[A-Z_]+$/u);
  });
});

describe('CliError', () => {
  it('maps harness faults to exit 2 and caller errors to exit 1', () => {
    expect(exitCodeFor('E_HARNESS_FAILED')).toBe(2);
    expect(exitCodeFor('E_UNEXPECTED')).toBe(2);
    expect(exitCodeFor('E_POLICY_POOL')).toBe(1);
    expect(new CliError('E_HARNESS_TIMEOUT', 't').exitCode).toBe(2);
  });

  it('lifts a domain failure', () => {
    const err = CliError.fromFailure(failure('E_ROUTE_NOT_FOUND', 'x', 'h'));
    expect(err.code).toBe('E_ROUTE_NOT_FOUND');
    expect(err.hint).toBe('h');
    expect(isCliError(err)).toBe(true);
    expect(isCliError(new Error('plain'))).toBe(false);
  });
});
