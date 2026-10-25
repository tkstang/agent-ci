import { superviseAttempts } from '@agent-ci/run/supervisor.js';
import { describe, expect, it } from 'vitest';

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('superviseAttempts', () => {
  it('returns the first success', async () => {
    const time = clock();
    const result = await superviseAttempts({
      maxAttempts: 3,
      retryDelayMs: 1_000,
      deadlineAtMs: 600_000,
      ...time,
      run: async () => ({ ok: true, retryable: false }),
    });
    expect(result).toEqual({
      result: { ok: true, retryable: false },
      attempts: 1,
    });
  });

  it('retries transient failures up to the attempt limit with a delay', async () => {
    const time = clock();
    const starts: number[] = [];
    const result = await superviseAttempts({
      maxAttempts: 3,
      retryDelayMs: 30_000,
      deadlineAtMs: 600_000,
      ...time,
      run: async () => {
        starts.push(time.now());
        return { ok: false, retryable: true };
      },
    });
    expect(result.attempts).toBe(3);
    expect(result.stopReason).toBe('max-attempts');
    expect(starts).toEqual([0, 30_000, 60_000]);
  });

  it('never retries a non-retryable failure', async () => {
    let calls = 0;
    const result = await superviseAttempts({
      maxAttempts: 5,
      retryDelayMs: 0,
      deadlineAtMs: 600_000,
      ...clock(),
      run: async () => {
        calls += 1;
        return { ok: false, retryable: false };
      },
    });
    expect(calls).toBe(1);
    expect(result.stopReason).toBe('not-retryable');
  });

  it('gives each attempt the time left and stops before the deadline', async () => {
    const time = clock();
    const timeouts: number[] = [];
    const result = await superviseAttempts({
      maxAttempts: 5,
      retryDelayMs: 10_000,
      deadlineAtMs: 100_000,
      minAttemptMs: 20_000,
      ...time,
      run: async (_attempt, timeoutMs) => {
        timeouts.push(timeoutMs);
        time.advance(40_000);
        return { ok: false, retryable: true };
      },
    });
    expect(timeouts).toEqual([100_000, 50_000]);
    expect(result.stopReason).toBe('deadline');
  });
});
