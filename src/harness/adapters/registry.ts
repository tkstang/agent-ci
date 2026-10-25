import { fakeAdapter } from '@agent-ci/harness/adapters/fake.js';
import type { HarnessAdapter } from '@agent-ci/harness/types.js';
import type { HarnessId } from '@agent-ci/routing/schema.js';

const ADAPTERS: Partial<Record<HarnessId, HarnessAdapter>> = {
  fake: fakeAdapter,
};

/** The adapter for a harness; unknown harnesses fail closed. */
export function adapterFor(harness: HarnessId): HarnessAdapter {
  const adapter = ADAPTERS[harness];
  if (adapter === undefined) {
    throw new Error(`no adapter registered for harness ${harness}`);
  }
  return adapter;
}
