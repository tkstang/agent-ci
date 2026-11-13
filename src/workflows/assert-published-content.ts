import assert from 'node:assert/strict';

import { failure, type Result, success } from '@agent-ci/result.js';

/** Fixture contract for this repository's PR-command consumer selftest. */
export function validatePublishedContent(content: {
  readonly fixture: string;
  readonly conflict: string;
  readonly baseOnly: string;
  readonly skillOrder: string;
}): Result<{ valid: true }> {
  try {
    assert.match(content.fixture, /return 42;/);
    assert.match(content.conflict, /base wording/);
    assert.match(content.conflict, /feature wording/);
    assert.doesNotMatch(content.conflict, /^(<<<<<<<|=======|>>>>>>>)/m);
    assert.equal(content.baseOnly, 'base addition\n');
    assert.equal(content.skillOrder, 'first\nsecond\n');
    return success({ valid: true });
  } catch (error) {
    return failure(
      'E_PR_RUN_FAILED',
      error instanceof Error
        ? error.message
        : 'Published fixture content did not match.',
    );
  }
}
