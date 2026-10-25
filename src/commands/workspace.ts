import path from 'node:path';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { restoreWorkspace } from '@agent-ci/workspace/bundle.js';

const USAGE = `agent-ci workspace restore — take the setup job's prepared working tree.

  agent-ci workspace restore --archive <file.tgz> --target <dir> --sha256 <hex>

Verifies the archive digest, then parses the gzip tar itself (no tar
process, so no TAR_OPTIONS or archive tricks) into a fresh staging directory.
Only directories, regular files (permission bits only), hard links to earlier
files and relative symlinks that stay in the tree are accepted; .git at any
depth, absolute paths, '..', devices, FIFOs, setuid/setgid/sticky bits and
duplicates are refused. <dir>/.git (this job's own checkout) is moved in and
the result swapped into place; on any refusal <dir> is left untouched.`;

export const workspaceCommand: CommandSpec = {
  name: 'workspace',
  summary: "Restore the setup job's prepared working tree safely",
  usage: USAGE,
  async run(argv, context) {
    const [action, ...rest] = argv;
    if (action !== 'restore') {
      throw new CliError('E_INVALID_INPUT', 'use: workspace restore', {
        hint: USAGE,
      });
    }
    const flags = parseFlags(
      rest,
      {
        archive: { type: 'string' },
        target: { type: 'string' },
        sha256: { type: 'string' },
      },
      USAGE,
    );
    const resolve = (value: string) => path.resolve(context.cwd, value);
    const restored = await restoreWorkspace({
      archive: resolve(required(flags.archive, '--archive')),
      target: resolve(required(flags.target, '--target')),
      sha256: required(flags.sha256, '--sha256'),
    });
    if (!restored.ok) throw CliError.fromFailure(restored);
    context.log(
      `agent-ci workspace: restored ${restored.value.entries} entries`,
    );
    return restored.value;
  },
};
