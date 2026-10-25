import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectChangedFiles } from '@agent-ci/run/changed-files.js';
import { describe, expect, it } from 'vitest';

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

describe('detectChangedFiles', () => {
  it('lists modified, added and renamed files but not agent-ci output', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-git-'));
    git(repo, 'init', '-q');
    await writeFile(path.join(repo, 'a.txt'), 'a');
    await writeFile(path.join(repo, 'old.txt'), 'o');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    await writeFile(path.join(repo, 'a.txt'), 'changed');
    await writeFile(path.join(repo, 'new file.txt'), 'n');
    await rename(path.join(repo, 'old.txt'), path.join(repo, 'renamed.txt'));
    git(repo, 'add', 'renamed.txt', 'old.txt');
    await mkdir(path.join(repo, '.agent-ci'));
    await writeFile(path.join(repo, '.agent-ci', 'run-result.json'), '{}');
    const files = await detectChangedFiles(repo, [
      path.join(repo, '.agent-ci'),
    ]);
    expect(files.toSorted()).toEqual(['a.txt', 'new file.txt', 'renamed.txt']);
  });

  it('returns nothing outside a git repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-nogit-'));
    expect(await detectChangedFiles(dir)).toEqual([]);
  });
});
