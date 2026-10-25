import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { overridesFor, safeGitArgs } from '@agent-ci/git/safe-git.js';
import { createGit } from '@agent-ci/publish/git.js';
import {
  detectChangedFiles,
  readHead,
  snapshotWorkspace,
} from '@agent-ci/run/changed-files.js';
import { findWorkspaceRoot } from '@agent-ci/run/workspace.js';
import { describe, expect, it } from 'vitest';

/**
 * A repository whose own config runs code: `core.fsmonitor` names a script
 * and a `post-index-change` hook exists; each leaves a marker when it runs.
 */
async function hostileRepo(): Promise<{ repo: string; markers: string[] }> {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'agent-ci-safegit-')),
  );
  const repo = path.join(base, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  git('init', '-q');
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  const fsmonitorMarker = path.join(base, 'fsmonitor-ran');
  const hookMarker = path.join(base, 'hook-ran');
  const monitor = path.join(base, 'monitor.sh');
  await writeFile(monitor, `#!/bin/sh\ntouch "${fsmonitorMarker}"\nexit 1\n`, {
    mode: 0o755,
  });
  git('config', 'core.fsmonitor', monitor);
  await writeFile(
    path.join(repo, '.git', 'hooks', 'post-index-change'),
    `#!/bin/sh\ntouch "${hookMarker}"\n`,
    { mode: 0o755 },
  );
  // Dirty state so status refreshes and rewrites the index.
  await writeFile(path.join(repo, 'a.txt'), 'changed\n');
  await writeFile(path.join(repo, 'new.txt'), 'new\n');
  return { repo, markers: [fsmonitorMarker, hookMarker] };
}

describe('agent-ci never runs repository-configured git code', () => {
  it('the planted fsmonitor and hook do run under plain git (control)', async () => {
    const { repo, markers } = await hostileRepo();
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      stdio: 'ignore',
    });
    expect(markers.some((marker) => existsSync(marker))).toBe(true);
  });

  it('status, baseline, HEAD, boundary and publisher calls run neither', async () => {
    const { repo, markers } = await hostileRepo();
    const changed = await detectChangedFiles(repo);
    expect(changed.ok && changed.value.toSorted()).toEqual([
      'a.txt',
      'new.txt',
    ]);
    expect((await snapshotWorkspace(repo)).ok).toBe(true);
    expect((await readHead(repo)).ok).toBe(true);
    expect((await findWorkspaceRoot(repo)).ok).toBe(true);
    const publisherGit = createGit(repo, { PATH: process.env.PATH });
    expect((await publisherGit(['status', '--porcelain'])).code).toBe(0);
    for (const marker of markers) expect(existsSync(marker)).toBe(false);
    await rm(path.dirname(repo), { recursive: true, force: true });
  });

  for (const source of ['.gitattributes', '.git/info/attributes']) {
    it(`a configured filter driver assigned in ${source} never runs (review r3 L3)`, async () => {
      const base = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'agent-ci-filter-')),
      );
      const repo = path.join(base, 'repo');
      await mkdir(repo);
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
          { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      git('init', '-q');
      await writeFile(path.join(repo, 'a.txt'), 'a\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      const marker = path.join(base, 'filter-ran');
      const filter = path.join(base, 'filter.sh');
      await writeFile(filter, `#!/bin/sh\ntouch "${marker}"\ncat\n`, {
        mode: 0o755,
      });
      git('config', 'filter.evil.clean', filter);
      git('config', 'filter.evil.required', 'true');
      await mkdir(path.join(repo, '.git', 'info'), { recursive: true });
      await writeFile(path.join(repo, source), '*.txt filter=evil\n');
      // Same size, newer mtime: status must compare content (clean filter).
      const touchLater = async (content: string, seconds: number) => {
        await writeFile(path.join(repo, 'a.txt'), content);
        const when = new Date(Date.now() + seconds * 1000);
        await utimes(path.join(repo, 'a.txt'), when, when);
      };
      await touchLater('b\n', 5);
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        stdio: 'ignore',
      });
      expect(existsSync(marker)).toBe(true); // control: plain git runs it
      await rm(marker);
      await touchLater('c\n', 10);
      const changed = await detectChangedFiles(repo);
      expect(changed.ok && changed.value).toContain('a.txt');
      expect((await snapshotWorkspace(repo)).ok).toBe(true);
      expect(existsSync(marker)).toBe(false);
    });
  }

  it('builds one override set per configured filter driver, dotted names included', () => {
    expect(
      overridesFor(
        'filter.x.clean\n/bin/x\0filter.my.dotted.process\n/bin/y\0core.bare\nfalse\0',
      ),
    ).toEqual([
      '-c',
      'filter.my.dotted.clean=',
      '-c',
      'filter.my.dotted.smudge=',
      '-c',
      'filter.my.dotted.process=',
      '-c',
      'filter.my.dotted.required=false',
      '-c',
      'filter.x.clean=',
      '-c',
      'filter.x.smudge=',
      '-c',
      'filter.x.process=',
      '-c',
      'filter.x.required=false',
    ]);
  });

  it('puts the neutralizing settings before the command and blocks transports for local calls', () => {
    expect(safeGitArgs(['status'])).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'protocol.allow=never',
      'status',
    ]);
    expect(safeGitArgs(['push'], { network: true })).not.toContain(
      'protocol.allow=never',
    );
  });
});
