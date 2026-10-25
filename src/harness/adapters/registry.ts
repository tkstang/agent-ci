import { claudeAdapter } from '@agent-ci/harness/adapters/claude.js';
import { codexAdapter } from '@agent-ci/harness/adapters/codex.js';
import { cursorAdapter } from '@agent-ci/harness/adapters/cursor.js';
import { fakeAdapter } from '@agent-ci/harness/adapters/fake.js';
import { opencodeAdapter } from '@agent-ci/harness/adapters/opencode.js';
import type { HarnessAdapter } from '@agent-ci/harness/types.js';
import type { HarnessId } from '@agent-ci/routing/schema.js';

/** One adapter per harness; the record type makes a missing one a type error. */
export const ADAPTERS: Readonly<Record<HarnessId, HarnessAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
  fake: fakeAdapter,
};

export function adapterFor(harness: HarnessId): HarnessAdapter {
  return ADAPTERS[harness];
}
