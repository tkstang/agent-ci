import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  changedSince,
  detectChangedFiles,
  snapshotWorkspace,
} from '@agent-ci/run/changed-files.js';
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
    // A staged rename reports both sides: the source was deleted.
    expect(files.ok && files.value.toSorted()).toEqual([
      'a.txt',
      'new file.txt',
      'old.txt',
      'renamed.txt',
    ]);
  });

  it('returns nothing outside a git repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-nogit-'));
    expect(await detectChangedFiles(dir)).toEqual({ ok: true, value: [] });
  });

  it('reports only changes made after the baseline snapshot', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-git-base-'));
    git(repo, 'init', '-q');
    await writeFile(path.join(repo, 'tracked.txt'), 't');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    // Pre-existing dirt: an untracked file and a modified tracked file.
    await writeFile(path.join(repo, 'stray.log'), 'pre-existing');
    await writeFile(path.join(repo, 'tracked.txt'), 'dirty before');
    const snapshot = await snapshotWorkspace(repo);
    if (!snapshot.ok) throw new Error(snapshot.message);
    const baseline = snapshot.value;
    expect(await changedSince(repo, baseline)).toEqual({ ok: true, value: [] });
    // The run edits the dirty file again and creates a new one.
    await writeFile(path.join(repo, 'tracked.txt'), 'edited by run');
    await writeFile(path.join(repo, 'made-by-run.txt'), 'n');
    expect(await changedSince(repo, baseline)).toEqual({
      ok: true,
      value: ['made-by-run.txt', 'tracked.txt'],
    });
    // Restoring a dirty file to its committed content is also a change.
    git(repo, 'checkout', '--', 'tracked.txt');
    expect(await changedSince(repo, baseline)).toEqual({
      ok: true,
      value: ['made-by-run.txt', 'tracked.txt'],
    });
  });

  it('reports a git failure as E_WORKSPACE_STATUS instead of no changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-badgit-'));
    const fakeGit = path.join(dir, 'git');
    await writeFile(
      fakeGit,
      "#!/bin/sh\necho 'fatal: detected dubious ownership in repository' >&2\nexit 128\n",
      { mode: 0o755 },
    );
    expect(await detectChangedFiles(dir, [], fakeGit)).toMatchObject({
      ok: false,
      code: 'E_WORKSPACE_STATUS',
      message: expect.stringContaining('dubious ownership'),
    });
    expect(
      await detectChangedFiles(dir, [], path.join(dir, 'missing-git')),
    ).toMatchObject({
      ok: false,
      code: 'E_WORKSPACE_STATUS',
      message: expect.stringContaining('git is not installed'),
    });
  });

  it('detects a run edit and keeps output excluded when run from a subdirectory', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-git-sub-'));
    const sub = path.join(repo, 'sub');
    await mkdir(sub);
    git(repo, 'init', '-q');
    await writeFile(path.join(sub, 'a.txt'), 'committed');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    await writeFile(path.join(sub, 'a.txt'), 'dirty before');
    const outDir = path.join(sub, '.agent-ci');
    await mkdir(outDir);
    await writeFile(path.join(outDir, 'prompt.md'), 'p');
    const fromRoot = await snapshotWorkspace(repo, [outDir]);
    const fromSub = await snapshotWorkspace(sub, [outDir]);
    if (!fromRoot.ok || !fromSub.ok) throw new Error('snapshot failed');
    await writeFile(path.join(sub, 'a.txt'), 'modified by run');
    await writeFile(path.join(outDir, 'run-result.json'), '{}');
    for (const [cwd, before] of [
      [repo, fromRoot.value],
      [sub, fromSub.value],
    ] as const) {
      expect(await changedSince(cwd, before, [outDir]), cwd).toEqual({
        ok: true,
        value: ['sub/a.txt'],
      });
    }
    expect(await detectChangedFiles(sub, [outDir])).toEqual({
      ok: true,
      value: ['sub/a.txt'],
    });
  });

  it('excludes an output directory whose name starts with two dots', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-git-dd-'));
    git(repo, 'init', '-q');
    const out = path.join(repo, '..output');
    await mkdir(out);
    await writeFile(path.join(out, 'run-result.json'), '{}');
    await writeFile(path.join(repo, 'work.txt'), 'w');
    expect(await detectChangedFiles(repo, [out])).toEqual({
      ok: true,
      value: ['work.txt'],
    });
  });

  it('fails instead of dropping an unreadable dirty file or an unresolvable exclusion', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-git-unread-'));
    git(repo, 'init', '-q');
    const locked = path.join(repo, 'locked.txt');
    await writeFile(locked, 'secret-ish');
    await chmod(locked, 0o000);
    try {
      expect(await snapshotWorkspace(repo)).toMatchObject({
        ok: false,
        code: 'E_WORKSPACE_STATUS',
      });
    } finally {
      await chmod(locked, 0o600);
    }
    await symlink(path.join(repo, 'loop-b'), path.join(repo, 'loop-a'));
    await symlink(path.join(repo, 'loop-a'), path.join(repo, 'loop-b'));
    expect(
      await detectChangedFiles(repo, [path.join(repo, 'loop-a', 'out')]),
    ).toMatchObject({ ok: false, code: 'E_WORKSPACE_STATUS' });
  });
});
