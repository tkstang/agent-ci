import { run } from '@agent-ci/cli.js';
import { describe, expect, it } from 'vitest';

/**
 * Every subcommand that resolves a route accepts the workflow form of the
 * pool opt-in and validates it strictly before doing anything else (gate 2
 * H1 sweep: the review gate had been missed). The workflow structure sweep
 * (`src/workflows/fan-out.test.ts`) checks that every workflow step running
 * one of these passes `--allow-pool-value "$ALLOW_POOL"`.
 */
export const RESOLVING_SUBCOMMANDS: readonly (readonly string[])[] = [
  ['route', '--model', 'fake-echo'],
  ['run', '--model', 'fake-echo', '--prompt', 'x'],
  ['review', 'gate'],
  ['review', 'pass', '--pass', 'primary'],
  ['review', 'adjudicate'],
  ['review', 'run', '--pr', '1', '--model', 'fake-review'],
  ['targets', 'matrix', '--preset', 'docs-update'],
  ['targets', 'validate'],
  ['doctor'],
];

describe('the pool opt-in on every route-resolving subcommand', () => {
  it('rejects a malformed --allow-pool-value first', async () => {
    for (const argv of RESOLVING_SUBCOMMANDS) {
      const result = await run([...argv, '--allow-pool-value', 'yes'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        log: () => undefined,
      });
      expect(result.envelope, argv.join(' ')).toMatchObject({
        ok: false,
        code: 'E_INVALID_INPUT',
        message: '--allow-pool-value must be true or false',
      });
    }
  });
});
