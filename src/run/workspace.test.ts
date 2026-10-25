import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  findWorkspaceRoot,
  isWithin,
  PathResolutionError,
  resolveRealPath,
} from '@agent-ci/run/workspace.js';
import { describe, expect, it } from 'vitest';

describe('workspace paths', () => {
  it('resolves a not-yet-existing path through a symlinked ancestor', async () => {
    const base = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'agent-ci-ws-')),
    );
    await mkdir(path.join(base, 'real'));
    await symlink(path.join(base, 'real'), path.join(base, 'link'));
    expect(await resolveRealPath(path.join(base, 'link', 'new', 'home'))).toBe(
      path.join(base, 'real', 'new', 'home'),
    );
  });

  it('decides containment on whole path segments', () => {
    expect(isWithin('/w/repo', '/w/repo')).toBe(true);
    expect(isWithin('/w/repo', '/w/repo/.home')).toBe(true);
    // Names that merely start with two dots are children, not parents.
    expect(isWithin('/w/repo', '/w/repo/..agent-home')).toBe(true);
    expect(isWithin('/w/repo', '/w/repo/...')).toBe(true);
    expect(isWithin('/w/repo', '/w/repo-home')).toBe(false);
    expect(isWithin('/w/repo', '/w')).toBe(false);
    expect(isWithin('/w/repo', '/w/other/..x')).toBe(false);
  });

  it('follows a dangling symlink to where a write would land', async () => {
    const base = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'agent-ci-ws-dangle-')),
    );
    await symlink(
      path.join(base, 'target', 'missing'),
      path.join(base, 'link'),
    );
    expect(await resolveRealPath(path.join(base, 'link', 'h'))).toBe(
      path.join(base, 'target', 'missing', 'h'),
    );
    await symlink(path.join(base, 'loop-b'), path.join(base, 'loop-a'));
    await symlink(path.join(base, 'loop-a'), path.join(base, 'loop-b'));
    await expect(
      resolveRealPath(path.join(base, 'loop-a', 'x')),
    ).rejects.toThrow(PathResolutionError);
  });

  it('treats a directory holding .git as the boundary even when git disowns it', async () => {
    const repo = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'agent-ci-ws-dotgit-')),
    );
    await mkdir(path.join(repo, '.git'));
    await mkdir(path.join(repo, 'sub'));
    expect(await findWorkspaceRoot(path.join(repo, 'sub'))).toEqual({
      ok: true,
      value: { root: repo, git: false },
    });
  });

  it('finds the git top level from a subdirectory, else the workspace', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-ws-plain-'));
    expect(await findWorkspaceRoot(plain)).toEqual({
      ok: true,
      value: { root: await realpath(plain), git: false },
    });
  });
});
