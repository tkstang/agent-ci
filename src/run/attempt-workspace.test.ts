import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createAttemptWorkspace,
  isolationSupport,
  promoteChanges,
} from '@agent-ci/run/attempt-workspace.js';
import { type RunOptions, runAgent } from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const MODELS = `version: 1
routes:
  - id: fake-edit
    model: fake-edit
    harness: fake
    family: fake
    providerModel: edit
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-flaky-edit
    model: fake-flaky-edit
    harness: fake
    family: fake
    providerModel: flaky-edit
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();

async function scratchRepo(): Promise<string> {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'agent-ci-iso-')),
  );
  const repo = path.join(dir, 'repo');
  await mkdir(repo);
  await writeFile(path.join(repo, 'README.md'), '# Scratch\n');
  await writeFile(path.join(repo, 'notes.txt'), 'committed\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  return repo;
}

async function runOptions(
  cwd: string,
  overrides: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const modelsPath = path.join(path.dirname(cwd), 'models.yaml');
  await writeFile(modelsPath, MODELS);
  return {
    model: 'fake-flaky-edit',
    prompt: 'Edit the workspace.',
    cwd,
    outDir: path.join(path.dirname(cwd), 'out'),
    outputContract: 'changes',
    useCase: 'generic-prompt',
    targetRepo: 'local/scratch',
    mode: 'edit',
    allowPool: false,
    seedLogin: false,
    timeoutMs: 60_000,
    maxAttempts: 2,
    retryDelayMs: 0,
    modelsPath,
    env: { PATH: process.env.PATH },
    ...overrides,
  };
}

async function attemptDirs(): Promise<string[]> {
  return (await readdir(os.tmpdir())).filter((name) =>
    name.startsWith('agent-ci-attempt-'),
  );
}

async function logEvents(logPath: string): Promise<Record<string, unknown>[]> {
  return (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('edit-mode retries run in isolated attempt workspaces', () => {
  it('keeps a failed attempt’s partial edits out of the retry and the result', async () => {
    const repo = await scratchRepo();
    // Pre-existing dirt the run must leave alone.
    await writeFile(path.join(repo, 'notes.txt'), 'operator edit\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');
    const summary = await runAgent(await runOptions(repo));
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error).toBeUndefined();
    expect(summary.value.attempts).toBe(2);
    expect(summary.value.result).toMatchObject({
      ok: true,
      status: 'changed',
      changedFiles: ['agent-ci-fake-edit.md'],
    });
    // The first attempt wrote fake-partial.txt in its own copy only.
    await expect(lstat(path.join(repo, 'fake-partial.txt'))).rejects.toThrow();
    expect(
      await readFile(path.join(repo, 'agent-ci-fake-edit.md'), 'utf8'),
    ).toContain('fake harness');
    expect(await readFile(path.join(repo, 'notes.txt'), 'utf8')).toBe(
      'operator edit\n',
    );
    expect(await readFile(path.join(repo, 'scratch.txt'), 'utf8')).toBe(
      'untracked\n',
    );
    const events = await logEvents(summary.value.logPath);
    expect(events.find((e) => e.event === 'attempt.isolation')).toMatchObject({
      mode: 'copy',
    });
    const attempts = events.filter((e) => e.event === 'attempt');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      ok: false,
      retryable: true,
      workspace: 'isolated-copy',
    });
    expect(attempts[1]).toMatchObject({
      ok: true,
      workspace: 'isolated-copy',
      promotedFiles: 1,
    });
    expect(await attemptDirs()).toEqual([]);
  });

  it('runs a single attempt when the workspace is not a git repository', async () => {
    const dir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'agent-ci-iso-nogit-')),
    );
    const workspace = path.join(dir, 'ws');
    await mkdir(workspace);
    const summary = await runAgent(await runOptions(workspace));
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.attempts).toBe(1);
    expect(summary.value.error?.code).toBe('E_HARNESS_FAILED');
    const events = await logEvents(summary.value.logPath);
    expect(events.find((e) => e.event === 'attempt.isolation')).toMatchObject({
      mode: 'single-attempt',
      reason: 'the workspace is not a git repository',
    });
  });

  it('runs a single attempt in a linked worktree (shared git directory)', async () => {
    const repo = await scratchRepo();
    const worktree = path.join(path.dirname(repo), 'linked');
    git(repo, 'worktree', 'add', '-q', worktree);
    expect(await isolationSupport(worktree, true)).toMatchObject({
      mode: 'unavailable',
    });
    const summary = await runAgent(await runOptions(worktree));
    expect(summary.ok && summary.value.attempts).toBe(1);
  });

  it('keeps retries in place for read-only runs and single-attempt edits', async () => {
    const repo = await scratchRepo();
    const summary = await runAgent(await runOptions(repo, { maxAttempts: 1 }));
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const events = await logEvents(summary.value.logPath);
    expect(events.some((e) => e.event === 'attempt.isolation')).toBe(false);
  });
});

describe('absolute links into the repository', () => {
  it('keep an unchanged committed link out of the changes and the workspace untouched (review probe)', async () => {
    const repo = await scratchRepo();
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await symlink(path.join(repo, 'a.txt'), path.join(repo, 'abs-link'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'link');
    const summary = await runAgent(
      await runOptions(repo, { model: 'fake-edit' }),
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const events = await logEvents(summary.value.logPath);
    expect(events.find((e) => e.event === 'attempt.isolation')).toMatchObject({
      mode: 'single-attempt',
      reason:
        'abs-link is a symlink a copy cannot isolate (absolute into the repository, or climbing out of it)',
    });
    expect(await readlink(path.join(repo, 'abs-link'))).toBe(
      path.join(repo, 'a.txt'),
    );
    expect(git(repo, 'status', '--porcelain')).not.toContain('abs-link');
    expect(summary.value.result.changedFiles).toEqual([
      'agent-ci-fake-edit.md',
    ]);
  });

  it('a relative link that climbs to / and back into the repository disables copy isolation (review L1)', async () => {
    const repo = await scratchRepo();
    await writeFile(path.join(repo, 'b.txt'), 'b\n');
    const depth = repo.split('/').filter(Boolean).length;
    const climbing = `${'../'.repeat(depth + 2)}${repo.slice(1)}/b.txt`;
    await mkdir(path.join(repo, 'deep'));
    await symlink(climbing, path.join(repo, 'deep', 'climb'));
    // From the original it lands on the repository's own file.
    expect(await readFile(path.join(repo, 'deep', 'climb'), 'utf8')).toBe(
      'b\n',
    );
    expect(await isolationSupport(repo, true)).toMatchObject({
      mode: 'unavailable',
      reason: expect.stringContaining('deep/climb'),
    });
  });

  it('a chained link that reaches the original from the copy downgrades to one in-place attempt (review r3 L1)', async () => {
    const repo = await scratchRepo();
    await writeFile(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'b');
    const depth = repo.split('/').filter(Boolean).length + 2;
    const dirs = Array.from({ length: depth }, (_, i) => `d${i}`).join('/');
    await mkdir(path.join(repo, dirs), { recursive: true });
    // l1 resolves to the repository root; `link` climbs from there to / and
    // back down to the original b.txt. Lexically neither leaves the tree.
    await symlink('../'.repeat(depth), path.join(repo, dirs, 'l1'));
    await symlink(
      `${dirs}/l1/${'../'.repeat(depth)}${repo.slice(1)}/b.txt`,
      path.join(repo, 'link'),
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'links');
    // The lexical pre-scan cannot see it...
    expect(await isolationSupport(repo, true)).toEqual({ mode: 'copy' });
    // ...the post-copy physical check does.
    const summary = await runAgent(await runOptions(repo));
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const events = await logEvents(summary.value.logPath);
    const isolation = events.filter((e) => e.event === 'attempt.isolation');
    expect(isolation.at(-1)).toMatchObject({
      mode: 'single-attempt',
      reason:
        'link resolves into the original repository from the attempt copy',
    });
    // flaky-edit fails its first attempt; a downgraded attempt is not retried.
    expect(summary.value.attempts).toBe(1);
    expect(await attemptDirs()).toEqual([]);
  });

  it('any relative link leaving the repository disables copy isolation (fail-safe)', async () => {
    const repo = await scratchRepo();
    await symlink('../sibling/file', path.join(repo, 'up'));
    expect(await isolationSupport(repo, true)).toMatchObject({
      mode: 'unavailable',
    });
  });

  it('isolation stays available for relative and outside links', async () => {
    const repo = await scratchRepo();
    await symlink('README.md', path.join(repo, 'rel-link'));
    await symlink(os.tmpdir(), path.join(repo, 'outside-link'));
    expect(await isolationSupport(repo, true)).toEqual({ mode: 'copy' });
  });
});

describe('createAttemptWorkspace', () => {
  it('copies the repository with links byte-for-byte and skips the output directory', async () => {
    const repo = await scratchRepo();
    await symlink(path.join(repo, 'README.md'), path.join(repo, 'abs-link'));
    await symlink('README.md', path.join(repo, 'rel-link'));
    const out = path.join(repo, '.agent-ci');
    await mkdir(out);
    await writeFile(path.join(out, 'prompt.md'), 'p');
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-iso-home-'));
    const copy = await createAttemptWorkspace({
      boundaryRoot: repo,
      cwd: repo,
      outDir: out,
      homeRoot: home,
      attempt: 1,
    });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    // Byte-for-byte, never retargeted (review p02 M2).
    expect(await readlink(path.join(copy.value.root, 'abs-link'))).toBe(
      path.join(repo, 'README.md'),
    );
    expect(await readlink(path.join(copy.value.root, 'rel-link'))).toBe(
      'README.md',
    );
    await expect(
      lstat(path.join(copy.value.root, '.agent-ci')),
    ).rejects.toThrow();
    expect(copy.value.outDir).toBe(path.join(copy.value.root, '.agent-ci'));
    // Same repository state as the original (the output dir is ignored there).
    expect(git(copy.value.root, 'status', '--porcelain')).toBe(
      git(repo, 'status', '--porcelain', '--', '.', ':!.agent-ci'),
    );
    await copy.value.dispose();
    await expect(lstat(copy.value.root)).rejects.toThrow();
  });

  it('refuses a copy location inside the repository', async () => {
    const repo = await scratchRepo();
    const copy = await createAttemptWorkspace({
      boundaryRoot: repo,
      cwd: repo,
      outDir: path.join(repo, '.agent-ci'),
      homeRoot: path.join(os.tmpdir(), 'nowhere'),
      attempt: 1,
      parentDir: repo,
    });
    expect(copy.ok ? 'ok' : copy.code).toBe('E_WORKSPACE_STATUS');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

async function pair(): Promise<{ copy: string; repo: string }> {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'agent-ci-promote-')),
  );
  const copy = path.join(base, 'copy');
  const repo = path.join(base, 'repo');
  await mkdir(copy);
  await mkdir(repo);
  return { copy, repo };
}

describe('promoteChanges', () => {
  it('writes new and modified files, recreates links and applies deletions', async () => {
    const { copy, repo } = await pair();
    await writeFile(path.join(repo, 'gone.txt'), 'old');
    await writeFile(path.join(repo, 'mod.txt'), 'old');
    await mkdir(path.join(copy, 'dir'));
    await writeFile(path.join(copy, 'dir', 'new.txt'), 'new');
    await writeFile(path.join(copy, 'mod.txt'), 'changed', { mode: 0o755 });
    await symlink('mod.txt', path.join(copy, 'link'));
    const promoted = await promoteChanges(copy, repo, [
      'dir/new.txt',
      'gone.txt',
      'link',
      'mod.txt',
    ]);
    expect(promoted.ok).toBe(true);
    expect(await readFile(path.join(repo, 'dir', 'new.txt'), 'utf8')).toBe(
      'new',
    );
    expect(await readFile(path.join(repo, 'mod.txt'), 'utf8')).toBe('changed');
    expect((await lstat(path.join(repo, 'mod.txt'))).mode & 0o111).not.toBe(0);
    expect(await readlink(path.join(repo, 'link'))).toBe('mod.txt');
    await expect(lstat(path.join(repo, 'gone.txt'))).rejects.toThrow();
  });

  it('never writes through a symlinked directory in the workspace', async () => {
    const { copy, repo } = await pair();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-outside-'));
    await symlink(outside, path.join(repo, 'docs'));
    await mkdir(path.join(copy, 'docs'));
    await writeFile(path.join(copy, 'docs', 'x.txt'), 'x');
    const promoted = await promoteChanges(copy, repo, ['docs/x.txt']);
    expect(promoted.ok ? 'ok' : promoted.code).toBe('E_WORKSPACE_STATUS');
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses to promote a link that points into the attempt copy', async () => {
    const { copy, repo } = await pair();
    await symlink(path.join(copy, 'target.txt'), path.join(copy, 'link'));
    const promoted = await promoteChanges(copy, repo, ['link']);
    expect(promoted.ok ? 'ok' : promoted.code).toBe('E_WORKSPACE_STATUS');
    await expect(lstat(path.join(repo, 'link'))).rejects.toThrow();
  });

  it('refuses unsafe paths', async () => {
    const { copy, repo } = await pair();
    for (const bad of ['../x', '/etc/x', '.git/config', 'a/../b', 'sub/']) {
      const promoted = await promoteChanges(copy, repo, [bad]);
      expect(promoted.ok ? 'ok' : promoted.code).toBe('E_WORKSPACE_STATUS');
    }
  });
});
