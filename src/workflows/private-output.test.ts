import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAgent, step } from '@agent-ci/workflows/testing/helpers.js';
import { expect, it } from 'vitest';

it('suppresses setup stdout and stderr for private targets while preserving failure and public diagnostics', async () => {
  const workflow = await runAgent();
  const script = step(workflow.jobs.setup ?? {}, 'Run the setup command').run;
  if (script === undefined) throw new Error('setup command has no script');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-private-setup-'));
  try {
    await writeFile(
      path.join(dir, 'corepack'),
      '#!/bin/sh\nprintf "tool-setup-sentinel\\n"\n',
      { mode: 0o755 },
    );
    for (const privateMode of [true, false]) {
      const result = spawnSync('/bin/bash', ['-eo', 'pipefail', '-c', script], {
        encoding: 'utf8',
        cwd: dir,
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          AGENT_CI_PRIVATE_TARGET: String(privateMode),
          SETUP_COMMAND:
            'printf "PRIVATE_STDOUT/file.ts\\n"; printf "PRIVATE_STDERR/file.ts\\n" >&2; exit 17',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(17);
      if (privateMode) {
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      } else {
        expect(result.stdout).toContain('tool-setup-sentinel');
        expect(result.stdout).toContain('PRIVATE_STDOUT/file.ts');
        expect(result.stderr).toContain('PRIVATE_STDERR/file.ts');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
