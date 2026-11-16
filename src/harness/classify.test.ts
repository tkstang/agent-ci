import { describe, expect, it } from 'vitest';

import { classifyFailure } from './classify.js';

describe('classifyFailure', () => {
  it('retries a provider capacity rejection', () => {
    expect(classifyFailure('[unavailable] Server at capacity')).toEqual({
      code: 'E_HARNESS_FAILED',
      retryable: true,
    });
  });
});
