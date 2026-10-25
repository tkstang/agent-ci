import {
  assertSecretFree,
  containsSecret,
  maskSecrets,
  secretValuesFromEnv,
} from '@agent-ci/contracts/secret-guard.js';
import { describe, expect, it } from 'vitest';

// Synthetic placeholders only; never real credentials.
const SECRET = 'synthetic-secret-value-0001';

describe('secret guard', () => {
  it('finds secrets in nested values and keys', () => {
    expect(containsSecret({ a: [{ b: `x${SECRET}y` }] }, [SECRET])).toBe(true);
    expect(containsSecret({ [SECRET]: 1 }, [SECRET])).toBe(true);
    expect(containsSecret({ a: 'clean' }, [SECRET])).toBe(false);
    expect(containsSecret({ a: 'clean' }, [''])).toBe(false);
  });

  it('fails with E_SECRET_COPY without echoing the value', () => {
    const result = assertSecretFree({ summary: SECRET }, [SECRET]);
    expect(result).toMatchObject({ ok: false, code: 'E_SECRET_COPY' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('masks every occurrence', () => {
    expect(maskSecrets(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe(
      'a [REDACTED] b [REDACTED]',
    );
  });

  it('collects present values above the minimum length only', () => {
    expect(
      secretValuesFromEnv({ A: SECRET, B: 'short', C: undefined }, [
        'A',
        'B',
        'C',
        'D',
      ]),
    ).toEqual([SECRET]);
  });
});
