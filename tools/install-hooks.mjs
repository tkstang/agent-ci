import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// A worktree has a .git file; an unpacked scaffold must not configure its ancestor.
if (existsSync(join(root, '.git'))) {
  const result = spawnSync(
    'git',
    ['-C', root, 'config', '--local', 'core.hooksPath', 'tools/git-hooks'],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
