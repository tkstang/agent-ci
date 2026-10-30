import { existsSync } from 'node:fs';
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

async function canonicalTemp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}
async function caseInsensitive(dir: string): Promise<boolean> {
  await mkdir(path.join(dir, 'CaseProbe'));
  return existsSync(path.join(dir, 'caseprobe'));
}

describe('containment matrix (filesystem-authoritative resolution)', () => {
  it('applies .. after a link to the link target, as the OS does', async () => {
    const d = await canonicalTemp('agent-ci-mx-dotdot-');
    await mkdir(path.join(d, 'a', 'b'), { recursive: true });
    await symlink(path.join(d, 'a', 'b'), path.join(d, 'l'));
    expect(await resolveRealPath(`${d}/l/..`)).toBe(
      await realpath(`${d}/l/..`),
    );
    expect(await resolveRealPath(`${d}/l/..`)).toBe(path.join(d, 'a'));
    // Relative link text with '..' resolves against the link's directory.
    await symlink('../a/b', path.join(d, 'a', 'rel'));
    expect(await resolveRealPath(path.join(d, 'a', 'rel'))).toBe(
      path.join(d, 'a', 'b'),
    );
  });

  it('resolves self/../x through an in-root link to the physical location', async () => {
    const d = await canonicalTemp('agent-ci-mx-self-');
    const root = path.join(d, 'root');
    await mkdir(path.join(d, 'repo', 'loc'), { recursive: true });
    await mkdir(root);
    await symlink(root, path.join(root, 'self'));
    expect(await resolveRealPath(`${root}/self/../repo/loc`)).toBe(
      path.join(d, 'repo', 'loc'),
    );
  });

  it('rejects loops and a .. below a missing component', async () => {
    const d = await canonicalTemp('agent-ci-mx-reject-');
    await symlink(path.join(d, 'b'), path.join(d, 'a'));
    await symlink(path.join(d, 'a'), path.join(d, 'b'));
    await expect(resolveRealPath(path.join(d, 'a'))).rejects.toThrow(
      PathResolutionError,
    );
    await expect(resolveRealPath(`${d}/missing/../escape`)).rejects.toThrow(
      PathResolutionError,
    );
  });

  it('follows dangling links, including relative ones', async () => {
    const d = await canonicalTemp('agent-ci-mx-dangle-');
    await symlink('target/missing', path.join(d, 'rel-dangling'));
    expect(await resolveRealPath(path.join(d, 'rel-dangling', 'h'))).toBe(
      path.join(d, 'target', 'missing', 'h'),
    );
  });

  it('canonicalizes letter case on case-insensitive volumes (and keeps names distinct on case-sensitive ones)', async () => {
    const d = await canonicalTemp('agent-ci-mx-case-');
    const insensitive = await caseInsensitive(d);
    await mkdir(path.join(d, 'Repo', 'loc'), { recursive: true });
    const lower = path.join(d, 'repo', 'loc');
    if (insensitive) {
      expect(await resolveRealPath(lower)).toBe(path.join(d, 'Repo', 'loc'));
      expect(isWithin(path.join(d, 'Repo'), await resolveRealPath(lower))).toBe(
        true,
      );
      await symlink(lower, path.join(d, 'case-link'));
      expect(await resolveRealPath(path.join(d, 'case-link'))).toBe(
        path.join(d, 'Repo', 'loc'),
      );
    } else {
      // A different-case name is a different (missing) path here.
      expect(await resolveRealPath(lower)).toBe(lower);
      expect(isWithin(path.join(d, 'Repo'), lower)).toBe(false);
    }
  });

  it('canonicalizes a case-variant cwd for a non-git workspace boundary', async () => {
    const d = await canonicalTemp('agent-ci-mx-nongit-');
    const insensitive = await caseInsensitive(d);
    await mkdir(path.join(d, 'Work'));
    if (!insensitive) {
      // Impossible combination: 'work' does not exist on a case-sensitive volume.
      expect(existsSync(path.join(d, 'work'))).toBe(false);
      return;
    }
    expect(await findWorkspaceRoot(path.join(d, 'work'))).toEqual({
      ok: true,
      value: { root: path.join(d, 'Work'), git: false },
    });
  });
});
