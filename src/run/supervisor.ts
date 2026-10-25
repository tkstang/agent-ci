/**
 * Attempt supervisor, after pntr's `runSupervisedAgentPrompt`: bounded
 * attempts against one absolute deadline, retrying only failures the
 * adapter classified as transient, with a delay between attempts. Each
 * attempt's timeout is the time left before the deadline.
 */

export interface AttemptResult {
  readonly ok: boolean;
  readonly retryable: boolean;
}

export interface SuperviseOptions<T extends AttemptResult> {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  /** Absolute deadline (epoch ms) for all attempts together. */
  readonly deadlineAtMs: number;
  /** Do not start a retry with less time than this left. */
  readonly minAttemptMs?: number;
  readonly run: (attempt: number, timeoutMs: number) => Promise<T>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Supervised<T> {
  readonly result: T;
  readonly attempts: number;
  /** Why the supervisor stopped retrying, when the last attempt failed. */
  readonly stopReason?: 'not-retryable' | 'max-attempts' | 'deadline';
}

const DEFAULT_MIN_ATTEMPT_MS = 10_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function superviseAttempts<T extends AttemptResult>(
  options: SuperviseOptions<T>,
): Promise<Supervised<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const minAttemptMs = options.minAttemptMs ?? DEFAULT_MIN_ATTEMPT_MS;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));

  let attempt = 1;
  for (;;) {
    const timeoutMs = Math.max(1, options.deadlineAtMs - now());
    const result = await options.run(attempt, timeoutMs);
    if (result.ok) return { result, attempts: attempt };
    if (!result.retryable) {
      return { result, attempts: attempt, stopReason: 'not-retryable' };
    }
    if (attempt >= maxAttempts) {
      return { result, attempts: attempt, stopReason: 'max-attempts' };
    }
    if (options.deadlineAtMs - now() - options.retryDelayMs < minAttemptMs) {
      return { result, attempts: attempt, stopReason: 'deadline' };
    }
    await sleep(options.retryDelayMs);
    attempt += 1;
  }
}
