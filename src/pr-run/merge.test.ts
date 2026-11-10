import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computePrMerge } from '@agent-ci/pr-run/merge.js';
import { createGit } from '@agent-ci/publish/git.js';
import { describe, expect, it } from 'vitest';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();
}

async function branches(binary = false, prefix = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pr-merge-'));
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(
    path.join(root, 'file.txt'),
    binary ? 'old\0data' : `${prefix}old\n`,
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'checkout', '-qb', 'topic');
  await writeFile(
    path.join(root, 'file.txt'),
    binary ? 'topic\0data' : `${prefix}topic\n`,
  );
  git(root, 'commit', '-qam', 'topic');
  const headSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  await writeFile(
    path.join(root, 'file.txt'),
    binary ? 'base\0data' : `${prefix}base\n`,
  );
  git(root, 'commit', '-qam', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'topic');
  return {
    root,
    headSha,
    baseSha,
    run: createGit(root, { PATH: process.env.PATH }),
  };
}

describe('computePrMerge', () => {
  it('computes textual conflicts without changing the checkout, index or HEAD', async () => {
    const fixture = await branches();
    const before = git(fixture.root, 'write-tree');
    const merged = await computePrMerge(fixture.run, fixture);
    expect(merged).toMatchObject({
      ok: true,
      value: { mergeParent: fixture.baseSha, conflictedPaths: ['file.txt'] },
    });
    expect(git(fixture.root, 'rev-parse', 'HEAD')).toBe(fixture.headSha);
    expect(git(fixture.root, 'write-tree')).toBe(before);
    expect(await readFile(path.join(fixture.root, 'file.txt'), 'utf8')).toBe(
      'topic\n',
    );
    expect(git(fixture.root, 'status', '--porcelain')).toBe('');
  });

  it('does not merge clean base updates into an unrelated task', async () => {
    const fixture = await branches();
    const original = git(fixture.root, 'rev-parse', `${fixture.headSha}^`);
    const result = await computePrMerge(fixture.run, {
      headSha: fixture.headSha,
      baseSha: original,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        tree: git(fixture.root, 'rev-parse', `${fixture.headSha}^{tree}`),
        mergeParent: null,
        conflictedPaths: [],
      },
    });
  });

  it('refuses binary conflicts rather than silently keeping one side', async () => {
    const fixture = await branches(true);
    expect(await computePrMerge(fixture.run, fixture)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_FAILED',
    });
  });

  it('refuses oversized conflict blobs before a bounded read can hide their markers', async () => {
    const fixture = await branches(false, `${'a'.repeat(10 * 1024 * 1024)}\n`);
    expect(await computePrMerge(fixture.run, fixture)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_FAILED',
    });
  });

  it('does not execute a configured external merge driver', async () => {
    const fixture = await branches();
    const marker = path.join(fixture.root, 'driver-ran');
    git(fixture.root, 'config', 'merge.evil.driver', `touch '${marker}'`);
    git(fixture.root, 'config', 'merge.default', 'evil');
    const merged = await computePrMerge(fixture.run, fixture);
    expect(merged).toMatchObject({ ok: false, code: 'E_PR_RUN_FAILED' });
    expect(
      await access(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});
