import { execFileSync } from 'node:child_process';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
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
  it('reads files through the contents API at each side SHA and refuses non-files', async () => {
    const github = new FakeGithub()
      .on('GET', `${API}/contents/src/a.ts`, (request) =>
        request.path.endsWith(`ref=${HEAD}`)
          ? {
              body: {
                type: 'file',
                size: 6,
                encoding: 'base64',
                content: Buffer.from('head!\n').toString('base64'),
              },
            }
          : {
              body: {
                type: 'file',
                size: 5,
                encoding: 'base64',
                content: Buffer.from('base\n').toString('base64'),
              },
            },
      )
      .on('GET', `${API}/contents/src/link.ts`, {
        body: { type: 'symlink', target: '/etc/passwd', size: 11 },
      })
      .on('GET', `${API}/contents/src/big.ts`, {
        body: {
          type: 'file',
          size: 3,
          encoding: 'none',
          content: '',
          sha: 'c'.repeat(40),
        },
      })
      .on('GET', `${API}/git/blobs/${'c'.repeat(40)}`, {
        body: {
          encoding: 'base64',
          content: Buffer.from('big').toString('base64'),
        },
      })
      .on('GET', `${API}/contents/src/lie.ts`, {
        body: {
          type: 'file',
          size: 1,
          encoding: 'base64',
          content: Buffer.from('longer').toString('base64'),
        },
      });
    const texts = await fetchSources({
      github: github.client(),
      repository: 'tkstang/app',
      shas: { RIGHT: HEAD, LEFT: MERGE },
      wanted: [
        { side: 'RIGHT', path: 'src/a.ts' },
        { side: 'LEFT', path: 'src/a.ts' },
        { side: 'RIGHT', path: 'src/link.ts' },
        { side: 'RIGHT', path: 'src/big.ts' },
        { side: 'RIGHT', path: 'src/lie.ts' },
        { side: 'RIGHT', path: 'src/missing.ts' },
      ],
    });
    const read = mapReader(texts);
    expect(read('RIGHT', 'src/a.ts')).toBe('head!\n');
    expect(read('LEFT', 'src/a.ts')).toBe('base\n');
    expect(read('RIGHT', 'src/link.ts')).toBeNull();
    expect(read('RIGHT', 'src/big.ts')).toBe('big');
    expect(read('RIGHT', 'src/lie.ts')).toBeNull();
    expect(read('RIGHT', 'src/missing.ts')).toBeNull();
    // Only GETs: the reader never writes.
    expect(github.requests.every((r) => r.method === 'GET')).toBe(true);
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
