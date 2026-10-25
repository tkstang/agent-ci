import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  compactUsage,
  interpretResultEnvelope,
  num,
} from '@agent-ci/harness/adapters/result-envelope.js';
import { buildChildEnv } from '@agent-ci/harness/env.js';
import type { HarnessAdapter } from '@agent-ci/harness/types.js';

/** The fake CLI: compiled `.js` in dist, the `.ts` source under tests. */
export function fakeAgentPath(): string {
  const built = fileURLToPath(new URL('../fake-agent.js', import.meta.url));
  return existsSync(built)
    ? built
    : fileURLToPath(new URL('../fake-agent.ts', import.meta.url));
}

/**
 * The credential-free `fake` harness. The route's `providerModel` names the
 * scenario (`echo`, `edit`, `review`, `verify-review`, `adjudicate` in
 * `dist/`; tests also reach the failure-mode scenarios in
 * `testing/fake-agent-test-scenarios.ts`).
 */
export const fakeAdapter: HarnessAdapter = {
  id: 'fake',
  defaultCommand: process.execPath,
  versionArgs: ['--version'],
  // No model and no tools: resuming replays the scenario with `--resume`.
  supportsResume: true,
  supportsNoTools: true,
  // The fake CLI calls the bridge itself (`verify-review` scenario).
  supportsToolBridge: true,
  async prepare(request) {
    return {
      command: process.execPath,
      args: [
        fakeAgentPath(),
        '--scenario',
        request.route.providerModel,
        ...(request.resumeSessionId === undefined
          ? []
          : ['--resume', request.resumeSessionId]),
        ...(request.toolBridge === undefined
          ? []
          : ['--bridge', JSON.stringify(request.toolBridge)]),
        '--',
        request.prompt,
      ],
      env: buildChildEnv({
        parentEnv: request.parentEnv,
        route: request.route,
        homeEnv: request.home.env,
      }),
    };
  },
  async interpret(output) {
    return interpretResultEnvelope(output, {
      harness: 'fake',
      usage: (envelope) => {
        const usage = envelope.usage as Record<string, unknown> | undefined;
        return compactUsage({
          inputTokens: num(usage?.input_tokens),
          outputTokens: num(usage?.output_tokens),
          costUsd: num(envelope.total_cost_usd),
        });
      },
    });
  },
};
