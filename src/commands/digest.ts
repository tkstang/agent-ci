import path from 'node:path';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import { appendGithubOutput } from '@agent-ci/commands/github.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { digestResultDir } from '@agent-ci/publish/digest.js';

const USAGE = `agent-ci digest — content digest of a run's result directory.

  agent-ci digest --dir <dir> [--github-output]

sha256 over the sorted "<name>\\0<sha256>" lines of the directory's regular
files (anything else is refused). The agent job records it with its upload;
agent-ci publish and notify verify it with --result-digest.
--github-output writes digest=<hex> to $GITHUB_OUTPUT.`;

export const digestCommand: CommandSpec = {
  name: 'digest',
  summary: "Digest a run's result directory for the publish job",
  usage: USAGE,
  async run(argv, context) {
    const flags = parseFlags(
      argv,
      { dir: { type: 'string' }, 'github-output': { type: 'boolean' } },
      USAGE,
    );
    const dir = path.resolve(context.cwd, required(flags.dir, '--dir'));
    const digest = await digestResultDir(dir);
    if (!digest.ok) throw CliError.fromFailure(digest);
    if (flags['github-output'] === true) {
      await appendGithubOutput(context.env, { digest: digest.value });
    }
    return { dir, digest: digest.value };
  },
};
