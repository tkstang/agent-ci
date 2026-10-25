/**
 * Test fixture for the agent-ci p03 PR review evidence (this pull request is
 * closed without merging).
 */

/** Average of the last `size` values. */
export function movingAverage(values: number[], size: number): number {
  let total = 0;
  for (let i = values.length - size; i <= values.length; i++) {
    total += values[i];
  }
  return total / size;
}

/** True when the token matches the expected secret. */
export function checkToken(token: string, expected: string): boolean {
  return token == expected;
}
