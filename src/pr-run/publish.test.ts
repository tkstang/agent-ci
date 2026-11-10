import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildPrRunTree, publishPrRun } from '@agent-ci/pr-run/publish.js';
import type { PrRunRequest } from '@agent-ci/pr-run/request.js';
import type { ChangeSet } from '@agent-ci/publish/changes.js';
import { createGit, type GitRunner } from '@agent-ci/publish/git.js';
import type { RunOutputs } from '@agent-ci/publish/publish.js';
import { GithubClient } from '@agent-ci/review/github.js';
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

function write(file: string, content: string): ChangeSet['files'][number] {
  return {
    path: file,
    action: 'write',
    mode: '100644',
    size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    contentBase64: Buffer.from(content).toString('base64'),
  };
}

async function fixture(conflict = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pr-publish-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main', seed);
  await writeFile(path.join(seed, 'file.txt'), 'initial\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'initial');
  const initial = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-qb', 'topic');
  await writeFile(path.join(seed, 'file.txt'), 'topic\n');
  git(seed, 'commit', '-qam', 'topic');
  const headSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'topic');
  let baseSha = initial;
  if (conflict) {
    git(seed, 'checkout', '-q', 'main');
    await writeFile(path.join(seed, 'file.txt'), 'base\n');
    await writeFile(
      path.join(seed, 'base-only.txt'),
      'preserved base update\n',
    );
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'base');
    baseSha = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', '-q', 'origin', 'main');
    git(seed, 'checkout', '-q', 'topic');
  }
  git(root, 'clone', '-q', remote, checkout);
  git(checkout, 'checkout', '-q', 'topic');
  const request: PrRunRequest = {
    version: 1,
    repository: 'owner/repo',
    prNumber: 1,
    commentId: 2,
    actor: 'maintainer',
    headSha,
    headRef: 'topic',
    baseSha,
    baseRef: 'main',
    prompt: 'Fix the review comments and conflicts.',
    context: '',
    prUrl: 'https://github.com/owner/repo/pull/1',
  };
  const state = {
    headSha,
    baseSha,
    open: true,
    fork: false,
    permission: 'write',
  };
  const comments: string[] = [];
  const github = new GithubClient(async (call) => {
    let body: unknown;
    if (call.method === 'GET' && call.path === '/repos/owner/repo/pulls/1') {
      body = {
        number: 1,
        state: state.open ? 'open' : 'closed',
        head: {
          sha: state.headSha,
          ref: 'topic',
          repo: { full_name: state.fork ? 'other/repo' : 'owner/repo' },
        },
        base: {
          sha: state.baseSha,
          ref: 'main',
          repo: { full_name: 'owner/repo' },
        },
      };
    } else if (call.method === 'GET' && call.path === '/repos/owner/repo') {
      body = { default_branch: 'main' };
    } else if (
      call.method === 'GET' &&
      call.path === '/repos/owner/repo/collaborators/maintainer/permission'
    ) {
      body = { permission: state.permission };
    } else if (
      call.method === 'POST' &&
      call.path === '/repos/owner/repo/issues/1/comments'
    ) {
      comments.push((call.body as { body: string }).body);
      body = {
        html_url: 'https://github.com/owner/repo/pull/1#issuecomment-3',
      };
    } else {
      throw new Error(
        `unexpected external request ${call.method} ${call.path}`,
      );
    }
    return { status: 200, text: JSON.stringify(body), header: () => null };
  });
  const runner = createGit(checkout, { PATH: process.env.PATH });
  const outputs = (
    files: ChangeSet['files'] | null = [write('file.txt', 'resolved\n')],
  ): RunOutputs => ({
    dir: path.join(root, 'unused-result'),
    result: {
      ok: true,
      status: files === null ? 'no-op' : 'changed',
      useCase: 'pr-comment',
      targetRepo: 'owner/repo',
      outputContract: 'changes',
      summary: 'Addressed the requested feedback.',
      changedFiles: files?.map((entry) => entry.path) ?? [],
      artifacts: [],
      materializedArtifacts: [],
      errors: [],
    },
    changeSet: files === null ? null : { version: 1, baseSha: headSha, files },
  });
  return {
    root,
    remote,
    seed,
    checkout,
    initial,
    request,
    state,
    github,
    comments,
    runner,
    outputs,
  };
}

describe('PR head publishing', () => {
  it('pushes one child commit onto the existing branch without touching its checkout or running hooks', async () => {
    const f = await fixture();
    const marker = path.join(f.root, 'hook-ran');
    const hookDir = path.join(f.checkout, '.git', 'hooks');
    await mkdir(hookDir, { recursive: true });
    await writeFile(
      path.join(hookDir, 'pre-push'),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o755 },
    );
    const published = await publishPrRun({
      git: f.runner,
      github: f.github,
      request: f.request,
      outputs: f.outputs(),
    });
    expect(published).toMatchObject({ ok: true, value: { status: 'changed' } });
    if (!published.ok || published.value.commit === null) return;
    const commit = published.value.commit;
    expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(commit);
    expect(git(f.remote, 'show', '-s', '--format=%P', commit)).toBe(
      f.request.headSha,
    );
    expect(git(f.remote, 'show', `${commit}:file.txt`)).toBe('resolved');
    expect(git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.request.headSha);
    expect(git(f.checkout, 'status', '--porcelain')).toBe('');
    expect(
      await access(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]).toContain(commit);
  });

  it('recomputes a conflicting merge and preserves base-only changes and both parents', async () => {
    const f = await fixture(true);
    const outputs = f.outputs();
    const verified = await buildPrRunTree(f.runner, f.request, outputs);
    const published = await publishPrRun({
      git: f.runner,
      github: f.github,
      request: f.request,
      outputs,
    });
    expect(verified.ok).toBe(true);
    expect(published).toMatchObject({ ok: true, value: { status: 'changed' } });
    if (!published.ok || published.value.commit === null || !verified.ok)
      return;
    const commit = published.value.commit;
    expect(git(f.remote, 'show', '-s', '--format=%P', commit)).toBe(
      `${f.request.headSha} ${f.request.baseSha}`,
    );
    expect(git(f.remote, 'show', `${commit}:file.txt`)).toBe('resolved');
    expect(git(f.remote, 'show', `${commit}:base-only.txt`)).toBe(
      'preserved base update',
    );
    expect(git(f.remote, 'rev-parse', `${commit}^{tree}`)).toBe(
      verified.value.tree,
    );
  });

  it('refuses an unresolved merge before verification or publication', async () => {
    const f = await fixture(true);
    const outputs = f.outputs(null);
    expect(await buildPrRunTree(f.runner, f.request, outputs)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_FAILED',
    });
    expect(
      await publishPrRun({
        git: f.runner,
        github: f.github,
        request: f.request,
        outputs,
      }),
    ).toMatchObject({ ok: false, code: 'E_PR_RUN_FAILED' });
    expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(
      f.request.headSha,
    );
    expect(f.comments).toHaveLength(0);
  });

  it.each(['head', 'base', 'closed', 'fork'] as const)(
    'refuses a changed PR identity: %s',
    async (change) => {
      const f = await fixture();
      if (change === 'head') f.state.headSha = f.initial;
      if (change === 'base') f.state.baseSha = f.request.headSha;
      if (change === 'closed') f.state.open = false;
      if (change === 'fork') f.state.fork = true;
      const result = await publishPrRun({
        git: f.runner,
        github: f.github,
        request: f.request,
        outputs: f.outputs(),
      });
      expect(result).toMatchObject({ ok: false, code: 'E_PR_RUN_STALE_HEAD' });
      expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(
        f.request.headSha,
      );
      expect(f.comments).toHaveLength(0);
    },
  );

  it.each(['forward', 'rewind'] as const)(
    'uses an exact lease against a concurrent %s after its final remote check',
    async (direction) => {
      const f = await fixture();
      let concurrent = '';
      const raced: GitRunner = async (args, options) => {
        if (args[0] === 'push') {
          if (direction === 'forward') {
            git(f.seed, 'commit', '--allow-empty', '-qm', 'concurrent');
            concurrent = git(f.seed, 'rev-parse', 'HEAD');
            git(f.seed, 'push', '-q', 'origin', 'topic');
          } else {
            concurrent = f.initial;
            git(f.remote, 'update-ref', 'refs/heads/topic', concurrent);
          }
        }
        return f.runner(args, options);
      };
      const result = await publishPrRun({
        git: raced,
        github: f.github,
        request: f.request,
        outputs: f.outputs(),
      });
      expect(result).toMatchObject({ ok: false, code: 'E_PR_RUN_STALE_HEAD' });
      expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(concurrent);
      expect(f.comments).toHaveLength(0);
    },
  );

  it.each(['.github/workflows/evil.yml', '.gitmodules'])(
    'refuses privileged file changes: %s',
    async (file) => {
      const f = await fixture();
      const outputs = f.outputs([write(file, 'malicious\n')]);
      expect(await buildPrRunTree(f.runner, f.request, outputs)).toMatchObject({
        ok: false,
        code: 'E_PATH_POLICY',
      });
      expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(
        f.request.headSha,
      );
    },
  );

  it('also refuses workflow changes introduced by the recomputed merge baseline', async () => {
    const f = await fixture(true);
    git(f.seed, 'checkout', '-q', 'main');
    await mkdir(path.join(f.seed, '.github', 'workflows'), { recursive: true });
    await writeFile(
      path.join(f.seed, '.github', 'workflows', 'new.yml'),
      'name: base workflow\n',
    );
    git(f.seed, 'add', '.');
    git(f.seed, 'commit', '-qm', 'base workflow');
    git(f.seed, 'push', '-q', 'origin', 'main');
    f.request.baseSha = git(f.seed, 'rev-parse', 'HEAD');
    f.state.baseSha = f.request.baseSha;
    git(f.checkout, 'fetch', '-q', 'origin', 'main');
    expect(
      await buildPrRunTree(f.runner, f.request, f.outputs()),
    ).toMatchObject({ ok: false, code: 'E_PATH_POLICY' });
    expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(
      f.request.headSha,
    );
  });

  it('reports a successful no-op without creating a commit', async () => {
    const f = await fixture();
    const result = await publishPrRun({
      git: f.runner,
      github: f.github,
      request: f.request,
      outputs: f.outputs(null),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'no-op', commit: null },
    });
    expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(
      f.request.headSha,
    );
    expect(f.comments).toHaveLength(1);
  });

  it('reports a failed run without publishing any of its files', async () => {
    const f = await fixture();
    const outputs = f.outputs();
    outputs.result.ok = false;
    outputs.result.status = 'failed';
    outputs.result.errors = ['verification did not succeed'];
    const result = await publishPrRun({
      git: f.runner,
      github: f.github,
      request: f.request,
      outputs,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'failed', commit: null },
    });
    expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(
      f.request.headSha,
    );
    expect(f.comments[0]).toContain('failed');
    expect(f.comments[0]).toContain('verification did not succeed');
  });

  it('refuses publication if the requester lost write access after the gate', async () => {
    const f = await fixture();
    const revoked: GitRunner = async (args, options) => {
      const result = await f.runner(args, options);
      if (args[0] === 'commit-tree') f.state.permission = 'read';
      return result;
    };
    const result = await publishPrRun({
      git: revoked,
      github: f.github,
      request: f.request,
      outputs: f.outputs(),
    });
    expect(result).toMatchObject({ ok: false, code: 'E_PR_RUN_REQUEST' });
    expect(git(f.remote, 'rev-parse', 'refs/heads/topic')).toBe(
      f.request.headSha,
    );
    expect(f.comments).toHaveLength(0);
  });

  it('rejects artifacts from another task or base before rebuilding files', async () => {
    const f = await fixture();
    const wrongTask = f.outputs();
    wrongTask.result.targetRepo = 'other/repo';
    expect(await buildPrRunTree(f.runner, f.request, wrongTask)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_FAILED',
    });
    const valid = f.outputs();
    const wrongBase = {
      ...valid,
      changeSet:
        valid.changeSet === null
          ? null
          : { ...valid.changeSet, baseSha: f.initial },
    };
    expect(await buildPrRunTree(f.runner, f.request, wrongBase)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_STALE_HEAD',
    });
  });
});
