import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  findWorkspaceRoot,
  isWithin,
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

  it('decides containment on path segments, not string prefixes', () => {
    expect(isWithin('/w/repo', '/w/repo')).toBe(true);
    expect(isWithin('/w/repo', '/w/repo/.home')).toBe(true);
    expect(isWithin('/w/repo', '/w/repo-home')).toBe(false);
    expect(isWithin('/w/repo', '/w')).toBe(false);
  });

  it('finds the git top level from a subdirectory, else the workspace', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-ws-plain-'));
    expect(await findWorkspaceRoot(plain)).toEqual({
      ok: true,
      value: { root: await realpath(plain), git: false },
    });
  });
});
