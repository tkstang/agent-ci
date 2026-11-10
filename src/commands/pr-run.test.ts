import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import type { PrRunRequest } from '@agent-ci/pr-run/request.js';
import { digestResultDir } from '@agent-ci/publish/digest.js';
import { describe, expect, it } from 'vitest';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pr-command-'));
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  git(cwd, 'init', '-q', '-b', 'topic');
  await writeFile(path.join(cwd, 'README.md'), '# test\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'test: seed');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const request: PrRunRequest = {
    version: 1,
    repository: 'test/repo',
    prNumber: 7,
    commentId: 42,
    actor: 'maintainer',
    headSha: head,
    headRef: 'topic',
    baseSha: head,
    baseRef: 'main',
    prompt:
      'Use $fix-ci and then $address-feedback; leave PHP $response unchanged.',
    context: 'Untrusted review observation.',
    prUrl: 'https://github.com/test/repo/pull/7',
  };
  const requestDir = path.join(root, 'request');
  await mkdir(requestDir);
  await writeFile(
    path.join(requestDir, 'request.json'),
    JSON.stringify(request),
  );
  const digest = await digestResultDir(requestDir);
  if (!digest.ok) throw new Error(digest.message);
  const context = {
    cwd,
    env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'test/repo' },
    log: () => {},
  };
  const flags = [
    '--request-dir',
    requestDir,
    '--request-digest',
    digest.value,
    '--cwd',
    cwd,
  ];
  return { root, cwd, requestDir, context, flags, head };
}

describe('pr-run command artifact and execution boundary', () => {
  it('executes the pinned PR task and independently materializes the same resulting files', async () => {
    const f = await fixture();
    const out = path.join(f.root, 'result');
    const executed = await run(
      [
        'pr-run',
        'execute',
        ...f.flags,
        '--route',
        'fake-edit',
        '--out',
        out,
        '--home-root',
        path.join(f.root, 'home'),
        '--max-attempts',
        '1',
      ],
      f.context,
    );
    expect(executed.envelope).toMatchObject({
      ok: true,
      data: { status: 'changed', headSha: f.head },
    });
    const content = await readFile(
      path.join(f.cwd, 'agent-ci-fake-edit.md'),
      'utf8',
    );
    const prompt = await readFile(path.join(out, 'prompt.md'), 'utf8');
    expect(prompt).toContain(
      'Use $fix-ci and then $address-feedback; leave PHP $response unchanged.',
    );
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.head);
    git(f.cwd, 'clean', '-fd');
    const digest = await digestResultDir(out);
    if (!digest.ok) throw new Error(digest.message);
    const restored = await run(
      [
        'pr-run',
        'materialize',
        ...f.flags,
        '--result-dir',
        out,
        '--result-digest',
        digest.value,
      ],
      f.context,
    );
    expect(restored.envelope).toMatchObject({
      ok: true,
      data: { status: 'ready' },
    });
    expect(
      await readFile(path.join(f.cwd, 'agent-ci-fake-edit.md'), 'utf8'),
    ).toBe(content);
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it('refuses a modified request before editing the checkout', async () => {
    const f = await fixture();
    await writeFile(path.join(f.requestDir, 'request.json'), '{}');
    const result = await run(
      [
        'pr-run',
        'execute',
        ...f.flags,
        '--route',
        'fake-edit',
        '--out',
        path.join(f.root, 'out'),
        '--home-root',
        path.join(f.root, 'home'),
      ],
      f.context,
    );
    expect(result.envelope).toMatchObject({ ok: false, code: 'E_PUBLISH' });
    expect(git(f.cwd, 'status', '--porcelain')).toBe('');
  });

  it('refuses to run on a different head or a checkout with tracked setup edits', async () => {
    for (const mode of ['different-head', 'dirty']) {
      const f = await fixture();
      await writeFile(path.join(f.cwd, 'README.md'), '# changed\n');
      if (mode === 'different-head') {
        git(f.cwd, 'add', '.');
        git(f.cwd, 'commit', '-qm', 'test: another head');
      }
      const result = await run(
        [
          'pr-run',
          'execute',
          ...f.flags,
          '--route',
          'fake-edit',
          '--out',
          path.join(f.root, 'out'),
          '--home-root',
          path.join(f.root, 'home'),
        ],
        f.context,
      );
      expect(result.envelope, mode).toMatchObject({
        ok: false,
        code: 'E_PR_RUN_REQUEST',
      });
    }
  });
});
