import {
  compactUsage,
  interpretResultEnvelope,
  num,
} from '@agent-ci/harness/adapters/result-envelope.js';
import { buildChildEnv } from '@agent-ci/harness/env.js';
import type { HarnessAdapter, RunMode } from '@agent-ci/harness/types.js';

/**
 * Cursor: `agent -p --trust --output-format json --model M <mode> <prompt>`.
 * read-only: `--mode ask` (Q&A, no edits) and no `--force`; edit: `--force`.
 * The API key travels only as `CURSOR_API_KEY` in the environment, never as
 * `--api-key`, which would put it in argv.
 */
export function cursorArgs(
  providerModel: string,
  mode: RunMode,
  prompt: string,
): string[] {
  return [
    '-p',
    '--trust',
    '--output-format',
    'json',
    '--model',
    providerModel,
    ...(mode === 'read-only' ? ['--mode', 'ask'] : ['--force']),
    prompt,
  ];
}

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',
  defaultCommand: 'agent',
  versionArgs: ['--version'],
  async prepare(request) {
    return {
      command: 'agent',
      args: cursorArgs(
        request.route.providerModel,
        request.mode,
        request.prompt,
      ),
      env: buildChildEnv({
        parentEnv: request.parentEnv,
        route: request.route,
        homeEnv: request.home.env,
        settings: { NO_OPEN_BROWSER: '1' },
      }),
    };
  },
  async interpret(output) {
    return interpretResultEnvelope(output, {
      harness: 'cursor',
      usage: (envelope) => {
        const usage = envelope.usage as Record<string, unknown> | undefined;
        return compactUsage({
          inputTokens: num(usage?.inputTokens),
          outputTokens: num(usage?.outputTokens),
          cacheReadTokens: num(usage?.cacheReadTokens),
          cacheWriteTokens: num(usage?.cacheWriteTokens),
        });
      },
    });
  },
};
