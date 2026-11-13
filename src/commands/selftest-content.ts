import { execFileSync } from 'node:child_process';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { validatePublishedContent } from '@agent-ci/workflows/assert-published-content.js';

const USAGE = `agent-ci selftest-content: assert this repository's PR-command fixture content.

  agent-ci selftest-content --sha <full-commit-sha>

Run in the repository holding the published commit. Reads fixture files with
git show at --sha, without executing candidate code or reading worktree files.
This is specific to agent-ci's consumer selftest, not a general PR validator.`;

export const selftestContentCommand: CommandSpec = {
  name: 'selftest-content',
  summary: 'Assert the published PR-command selftest fixture content',
  usage: USAGE,
  async run(argv, context) {
    const flags = parseFlags(argv, { sha: { type: 'string' } }, USAGE);
    const sha = required(flags.sha, '--sha');
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new CliError(
        'E_INVALID_INPUT',
        '--sha must be a full lowercase commit SHA',
      );
    }
    const read = (file: string): string =>
      execFileSync('git', ['show', `${sha}:${file}`], {
        cwd: context.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let content;
    try {
      content = {
        fixture: read('agent-ci-command-fixture.mjs'),
        conflict: read('agent-ci-command-conflict.txt'),
        baseOnly: read('agent-ci-command-base-only.txt'),
        skillOrder: read('agent-ci-skill-order.txt'),
      };
    } catch {
      throw new CliError(
        'E_PR_RUN_FAILED',
        'Could not read published selftest fixture files at --sha',
      );
    }
    const result = validatePublishedContent(content);
    if (!result.ok) throw CliError.fromFailure(result);
    return { sha, ...result.value };
  },
};
