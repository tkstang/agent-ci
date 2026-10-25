import { isCliError } from '@agent-ci/errors.js';
import { parseConfig } from '@agent-ci/index.js';
import { isSuccess } from '@agent-ci/result.js';
import { describe, expect, it } from 'vitest';

describe('parseConfig', () => {
  it('parses a valid config and applies defaults', () => {
    const result = parseConfig('{"name":"my-app"}');
    expect(result.ok).toBe(true);
    if (isSuccess(result)) {
      expect(result.value.name).toBe('my-app');
      // defaults from the zod schema
      expect(result.value.retries).toBe(3);
      expect(result.value.verbose).toBe(false);
    }
  });

  it('honors explicit values over defaults', () => {
    const result = parseConfig('{"name":"x","retries":7,"verbose":true}');
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.value.retries).toBe(7);
      expect(result.value.verbose).toBe(true);
    }
  });

  it('fails with E_EMPTY_INPUT on blank input', () => {
    const result = parseConfig('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_EMPTY_INPUT');
      expect(result.hint).toBeTypeOf('string');
    }
  });

  it('fails with E_INVALID_INPUT on malformed JSON', () => {
    const result = parseConfig('{not json}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_INVALID_INPUT');
    }
  });

  it('fails with E_INVALID_INPUT when schema validation fails', () => {
    const result = parseConfig('{"name":""}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_INVALID_INPUT');
      expect(result.message).toContain('name');
    }
  });
});

describe('isCliError', () => {
  it('returns false for non-errors', () => {
    expect(isCliError(new Error('plain'))).toBe(false);
    expect(isCliError('nope')).toBe(false);
  });
});
