import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  citedSources,
  fetchSources,
  gitSourceReader,
  mapReader,
  readSourceSnapshot,
  referencedSources,
  writeSourceSnapshot,
} from '@agent-ci/review/sources.js';
import { FakeGithub } from '@agent-ci/review/testing/fake-github.js';
import { describe, expect, it } from 'vitest';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const API = '/repos/tkstang/app';

describe('citedSources', () => {
  it('collects finding, evidence and rule paths once, skipping unsafe paths', () => {
    expect(
      citedSources([
        {
          findings: [
            {
              path: 'src/a.ts',
              side: 'RIGHT',
              rule_id: './AGENTS.md#rules',
              evidence: [
                { path: 'src/a.ts', side: 'RIGHT' },
                { path: 'src/b.ts', side: 'LEFT' },
                { path: '../etc/passwd', side: 'RIGHT' },
                { path: 'src/c.ts', side: 'MIDDLE' },
              ],
            },
          ],
        },
        null,
        { findings: 'none' },
      ]),
    ).toEqual([
      { side: 'RIGHT', path: 'src/a.ts' },
      { side: 'LEFT', path: 'src/b.ts' },
      { side: 'RIGHT', path: 'AGENTS.md' },
    ]);
    expect(
      referencedSources({
        operations: [{ references: [{ path: 'src/d.ts', side: 'LEFT' }] }],
      }),
    ).toEqual([{ side: 'LEFT', path: 'src/d.ts' }]);
  });
});

describe('fetchSources', () => {
  it('reads regular files through git trees at each side SHA, like the local git reader', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-api-reader-'));
    const run = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
        {
          cwd: repo,
          encoding: 'utf8',
        },
      ).trim();
    run('init', '-q');
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, 'src', 'a.ts'), 'base\n');
    run('add', '.');
    run('commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'src', 'a.ts'), 'head!\n');
    // An in-repository file symlink (GitHub's contents API would serve the
    // target's text for it) and a symlinked directory.
    await symlink('a.ts', path.join(repo, 'src', 'alias.ts'));
    await symlink('src', path.join(repo, 'linked'));
    run('add', '.');
    run('commit', '-qm', 'head');
    const head = run('rev-parse', 'HEAD');
    const github = new FakeGithub().serveGitDatabase(API, repo);
    const wanted = [
      { side: 'RIGHT', path: 'src/a.ts' },
      { side: 'LEFT', path: 'src/a.ts' },
      { side: 'RIGHT', path: 'src/alias.ts' },
      { side: 'RIGHT', path: 'linked/a.ts' },
      { side: 'RIGHT', path: 'src' },
      { side: 'RIGHT', path: 'src/missing.ts' },
    ] as const;
    const api = mapReader(
      await fetchSources({
        github: github.client(),
        repository: 'tkstang/app',
        shas: { RIGHT: head, LEFT: base },
        wanted,
      }),
    );
    const local = gitSourceReader(repo, { RIGHT: head, LEFT: base });
    for (const { side, path: file } of wanted)
      expect(api(side, file), `${side} ${file}`).toBe(local(side, file));
    expect(api('RIGHT', 'src/a.ts')).toBe('head!\n');
    expect(api('LEFT', 'src/a.ts')).toBe('base\n');
    expect(api('RIGHT', 'src/alias.ts')).toBeNull();
    expect(api('RIGHT', 'linked/a.ts')).toBeNull();
    // Only GETs, and never the contents API.
    expect(github.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(github.requests.some((r) => r.path.includes('/contents/'))).toBe(
      false,
    );
  });

  it('refuses a blob whose bytes disagree with the tree size', async () => {
    const blob = 'c'.repeat(40);
    const github = new FakeGithub()
      .on('GET', `${API}/git/trees/${HEAD}`, {
        body: {
          tree: [
            {
              path: 'lie.ts',
              mode: '100644',
              type: 'blob',
              sha: blob,
              size: 1,
            },
          ],
        },
      })
      .on('GET', `${API}/git/blobs/${blob}`, {
        body: {
          encoding: 'base64',
          content: Buffer.from('longer').toString('base64'),
        },
      });
    const texts = await fetchSources({
      github: github.client(),
      repository: 'tkstang/app',
      shas: { RIGHT: HEAD, LEFT: MERGE },
      wanted: [{ side: 'RIGHT', path: 'lie.ts' }],
    });
    expect(texts.size).toBe(0);
  });

  it('round-trips through a snapshot directory', async () => {
    const dir = path.join(
      await mkdtemp(path.join(os.tmpdir(), 'agent-ci-snapshot-')),
      'sources',
    );
    await writeSourceSnapshot(
      dir,
      new Map([
        ['RIGHT\u0000src/a.ts', 'one\n'],
        ['LEFT\u0000src/b.ts', 'two\n'],
      ]),
    );
    const read = await readSourceSnapshot(dir);
    expect(read('RIGHT', 'src/a.ts')).toBe('one\n');
    expect(read('LEFT', 'src/b.ts')).toBe('two\n');
    expect(read('LEFT', 'src/a.ts')).toBeNull();
  });
});

describe('gitSourceReader', () => {
  it('reads regular blobs at each side SHA and never a symlink target', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-git-reader-'));
    const run = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
        { cwd: repo, encoding: 'utf8' },
      ).trim();
    run('init', '-q');
    await writeFile(path.join(repo, 'a.ts'), 'base\n');
    run('add', '.');
    run('commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'a.ts'), 'head\n');
    await symlink('/etc/hosts', path.join(repo, 'hosts.ts'));
    run('add', '.');
    run('commit', '-qm', 'head');
    const head = run('rev-parse', 'HEAD');
    const read = gitSourceReader(repo, { RIGHT: head, LEFT: base });
    expect(read('RIGHT', 'a.ts')).toBe('head\n');
    expect(read('LEFT', 'a.ts')).toBe('base\n');
    expect(read('RIGHT', 'hosts.ts')).toBeNull();
    expect(read('LEFT', 'hosts.ts')).toBeNull();
    expect(read('RIGHT', '../a.ts')).toBeNull();
  });
});
