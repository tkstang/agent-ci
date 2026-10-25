import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  copyIsolationProblem,
  createAttemptWorkspace,
  isolationSupport,
  promoteChanges,
} from '@agent-ci/run/attempt-workspace.js';
import { detectChangedFiles } from '@agent-ci/run/changed-files.js';
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
      reason: 'link is a symlink that does not resolve inside the copy',
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

/** A finished copy of `repo`. */
async function copyOf(repo: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-qual-home-'));
  const copy = await createAttemptWorkspace({
    boundaryRoot: repo,
    cwd: repo,
    outDir: path.join(path.dirname(repo), 'out'),
    homeRoot: home,
    attempt: 1,
  });
  if (!copy.ok) throw new Error(copy.message);
  return copy.value;
}

describe('copy qualification (phase gate H1)', () => {
  it('rejects a link under the copied .git that reaches the original', async () => {
    const repo = await scratchRepo();
    await symlink(
      path.join(repo, 'README.md'),
      path.join(repo, '.git', 'link'),
    );
    const copy = await copyOf(repo);
    expect(await copyIsolationProblem(copy.root)).toBe(
      '.git/link is a symlink that does not resolve inside the copy',
    );
    await copy.dispose();
  });

  it('rejects a link to an ancestor of the original (copy/up/repo/README.md would reach it)', async () => {
    const repo = await scratchRepo();
    await symlink(path.dirname(repo), path.join(repo, 'up'));
    const copy = await copyOf(repo);
    // Without the rule a write through here lands in the original:
    expect(
      await readFile(path.join(copy.root, 'up', 'repo', 'README.md'), 'utf8'),
    ).toBe('# Scratch\n');
    expect(await copyIsolationProblem(copy.root)).toBe(
      'up is a symlink that does not resolve inside the copy',
    );
    await copy.dispose();
  });

  it('rejects git metadata that points outside the copy', async () => {
    const repo = await scratchRepo();
    git(repo, 'config', 'core.worktree', repo);
    const copy = await copyOf(repo);
    expect(await copyIsolationProblem(copy.root)).toBe(
      '.git/config points git outside the copy',
    );
    await copy.dispose();
    const sub = await scratchRepo();
    await mkdir(path.join(sub, 'mod'));
    await writeFile(
      path.join(sub, 'mod', '.git'),
      `gitdir: ${path.join(sub, '.git')}\n`,
    );
    const subCopy = await copyOf(sub);
    expect(await copyIsolationProblem(subCopy.root)).toBe(
      'mod/.git points git outside the copy',
    );
    await subCopy.dispose();
  });

  it('accepts honest in-tree links, and writes through them never change the original', async () => {
    const repo = await scratchRepo();
    await mkdir(path.join(repo, 'sub'));
    await writeFile(path.join(repo, 'sub', 'x.txt'), 'original\n');
    await symlink('README.md', path.join(repo, 'rel'));
    await symlink('sub', path.join(repo, 'dir-link'));
    await symlink('missing', path.join(repo, 'dangling'));
    const copy = await copyOf(repo);
    expect(await copyIsolationProblem(copy.root)).toBeUndefined();
    await writeFile(path.join(copy.root, 'rel'), 'changed through the copy\n');
    await writeFile(path.join(copy.root, 'dir-link', 'x.txt'), 'changed\n');
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe(
      '# Scratch\n',
    );
    expect(await readFile(path.join(repo, 'sub', 'x.txt'), 'utf8')).toBe(
      'original\n',
    );
    await copy.dispose();
  });

  it('a non-qualifying copy runs one in-place attempt that is never retried', async () => {
    const repo = await scratchRepo();
    await symlink(
      path.join(repo, 'README.md'),
      path.join(repo, '.git', 'link'),
    );
    const summary = await runAgent(await runOptions(repo));
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const events = await logEvents(summary.value.logPath);
    expect(
      events.filter((e) => e.event === 'attempt.isolation').at(-1),
    ).toMatchObject({
      mode: 'single-attempt',
      reason: '.git/link is a symlink that does not resolve inside the copy',
    });
    expect(summary.value.attempts).toBe(1);
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe(
      '# Scratch\n',
    );
  });
});

/**
 * An absorbed submodule at `sub` with a committed `s.txt`: `sub/.git` is a
 * relative `gitdir:` file and the module's git directory lives under
 * `.git/modules/sub`, with `core.worktree` in its `config.worktree`.
 */
async function withSubmodule(repo: string, worktree: string): Promise<void> {
  const gitDir = path.join(repo, '.git', 'modules', 'sub');
  const sub = path.join(repo, 'sub');
  await mkdir(path.dirname(gitDir), { recursive: true });
  git(repo, 'init', '-q', '--separate-git-dir', gitDir, sub);
  await writeFile(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
  git(sub, 'config', 'extensions.worktreeConfig', 'true');
  git(sub, 'config', '--worktree', 'core.worktree', worktree);
  await writeFile(path.join(sub, 's.txt'), 'sub committed\n');
  git(sub, 'add', 's.txt');
  git(sub, 'commit', '-qm', 'sub');
}

describe('git-authoritative copy qualification (phase gate round 2 H1)', () => {
  it('refuses config.worktree core.worktree pointing at the original', async () => {
    const repo = await scratchRepo();
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(repo, 'config', '--worktree', 'core.worktree', repo);
    const copy = await copyOf(repo);
    // The vector is live: git run in the copy works on the original.
    expect(git(copy.root, 'rev-parse', '--show-toplevel').trim()).toBe(repo);
    expect(await copyIsolationProblem(copy.root)).toBe(
      '.git/config.worktree points git outside the copy',
    );
    await copy.dispose();
  });

  it('refuses a submodule whose config.worktree points at the original', async () => {
    const repo = await scratchRepo();
    await withSubmodule(repo, path.join(repo, 'sub'));
    const copy = await copyOf(repo);
    expect(
      git(path.join(copy.root, 'sub'), 'rev-parse', '--show-toplevel').trim(),
    ).toBe(path.join(repo, 'sub'));
    expect(await copyIsolationProblem(copy.root)).toBe(
      '.git/modules/sub/config.worktree points git outside the copy',
    );
    await copy.dispose();
  });

  it('trusts git, not the file screen: an outside or failed git answer is refused', async () => {
    const repo = await scratchRepo();
    const copy = await copyOf(repo);
    const bin = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-qual-git-'));
    // Stand-ins for a git whose own answer escapes, or that cannot answer;
    // every other git call goes to the real git.
    const stub = async (name: string, flag: string, answer: string) => {
      const file = path.join(bin, name);
      await writeFile(
        file,
        `#!/bin/sh\nfor a in "$@"; do [ "$a" = ${flag} ] && { ${answer}; }; done\nexec git "$@"\n`,
      );
      await chmod(file, 0o755);
      return file;
    };
    expect(
      await copyIsolationProblem(
        copy.root,
        await stub(
          'escapes',
          '--show-toplevel',
          `printf '%s\\n' ${repo} ${repo}/.git .git; exit 0`,
        ),
      ),
    ).toBe(`git resolves . in the copy to ${repo}, outside the copy`);
    expect(
      await copyIsolationProblem(
        copy.root,
        await stub('fails', 'rev-parse', 'exit 128'),
      ),
    ).toBe('git cannot locate the repository at . in the copy');
    await copy.dispose();
  });

  it('refuses a git directory whose effective config names an outside work tree', async () => {
    const sub = await scratchRepo();
    await withSubmodule(sub, '../../../sub');
    const modules = path.join(sub, '.git', 'modules', 'sub');
    // Included after the honest value, so it wins; the file screen reads
    // config.worktree without includes and sees only the honest value.
    await writeFile(
      path.join(modules, 'extra.cfg'),
      `[core]\n\tworktree = ${path.join(sub, 'sub')}\n`,
    );
    git(
      sub,
      'config',
      '--file',
      path.join(modules, 'config.worktree'),
      'include.path',
      'extra.cfg',
    );
    const subCopy = await copyOf(sub);
    expect(await copyIsolationProblem(subCopy.root)).toBe(
      `git directory .git/modules/sub in the copy points git at ${path.join(sub, 'sub')}, outside the copy`,
    );
    await subCopy.dispose();
  });

  it('qualifies an honest repository and submodule; git rm and checkout in the copy leave the original alone', async () => {
    const repo = await scratchRepo();
    await withSubmodule(repo, '../../../sub');
    await writeFile(path.join(repo, 'notes.txt'), 'dirty\n');
    await writeFile(path.join(repo, 'sub', 's.txt'), 'sub dirty\n');
    const copy = await copyOf(repo);
    expect(await copyIsolationProblem(copy.root)).toBeUndefined();
    const copySub = path.join(copy.root, 'sub');
    git(copy.root, 'rm', '-q', 'README.md');
    git(copy.root, 'checkout', '-q', '--', 'notes.txt');
    git(copySub, 'checkout', '-q', '--', 's.txt');
    git(copySub, 'rm', '-q', 's.txt');
    expect(await readFile(path.join(copy.root, 'notes.txt'), 'utf8')).toBe(
      'committed\n',
    );
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe(
      '# Scratch\n',
    );
    expect(await readFile(path.join(repo, 'notes.txt'), 'utf8')).toBe(
      'dirty\n',
    );
    expect(await readFile(path.join(repo, 'sub', 's.txt'), 'utf8')).toBe(
      'sub dirty\n',
    );
    expect(git(repo, 'status', '--porcelain')).toContain(' M notes.txt');
    expect(git(repo, 'ls-files')).toContain('README.md');
    await copy.dispose();
  });

  it("agent-ci's own git calls in a copy are pinned to it even if its config redirects", async () => {
    const repo = await scratchRepo();
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(repo, 'config', '--worktree', 'core.worktree', repo);
    const copy = await copyOf(repo);
    await writeFile(path.join(copy.root, 'copy-only.txt'), 'new\n');
    await writeFile(path.join(repo, 'orig-only.txt'), 'new\n');
    const pin = { gitDir: path.join(copy.root, '.git'), workTree: copy.root };
    const pinned = await detectChangedFiles(copy.root, [], 'git', pin);
    expect(pinned).toEqual({ ok: true, value: ['copy-only.txt'] });
    const unpinned = await detectChangedFiles(copy.root);
    expect(unpinned.ok && unpinned.value).toContain('orig-only.txt');
    await copy.dispose();
  });
});

describe('git directories outside .git and submodule children (phase review r5)', () => {
  it('refuses a nested git directory whose core.worktree names the original', async () => {
    const repo = await scratchRepo();
    const tool = path.join(repo, 'fixtures', 'tool.git');
    await mkdir(path.dirname(tool));
    git(repo, 'init', '-q', '--bare', tool);
    git(tool, 'config', 'core.bare', 'false');
    git(tool, 'config', 'core.worktree', repo);
    const copy = await copyOf(repo);
    const copyTool = path.join(copy.root, 'fixtures', 'tool.git');
    // The vector is live: git run from inside that directory in the copy
    // works on the original.
    expect(git(copyTool, 'rev-parse', '--show-toplevel').trim()).toBe(repo);
    expect(await copyIsolationProblem(copy.root)).toBe(
      'fixtures/tool.git/config points git outside the copy',
    );
    await copy.dispose();
  });

  it('qualifies a nested bare git directory without core.worktree', async () => {
    const repo = await scratchRepo();
    const tool = path.join(repo, 'fixtures', 'tool.git');
    await mkdir(path.dirname(tool));
    git(repo, 'init', '-q', '--bare', tool);
    const copy = await copyOf(repo);
    expect(await copyIsolationProblem(copy.root)).toBeUndefined();
    expect(() =>
      git(
        path.join(copy.root, 'fixtures', 'tool.git'),
        'rm',
        '-q',
        'README.md',
      ),
    ).toThrow();
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe(
      '# Scratch\n',
    );
    await copy.dispose();
  });

  it("a submodule's own filter driver never runs in agent-ci's status", async () => {
    const repo = await scratchRepo();
    await withSubmodule(repo, '../../../sub');
    git(repo, 'add', 'sub');
    git(repo, 'commit', '-qm', 'gitlink');
    const modules = path.join(repo, '.git', 'modules', 'sub');
    const marker = path.join(path.dirname(repo), 'filter-ran');
    git(
      repo,
      'config',
      '--file',
      path.join(modules, 'config'),
      'filter.evil.clean',
      `touch ${marker}; cat`,
    );
    await mkdir(path.join(modules, 'info'), { recursive: true });
    await writeFile(
      path.join(modules, 'info', 'attributes'),
      '* filter=evil\n',
    );
    // Same size, so a content comparison (and the clean filter) is needed.
    await writeFile(path.join(repo, 'sub', 's.txt'), 'sub CHANGED!!\n');
    const changes = await detectChangedFiles(repo);
    expect(changes).toEqual({ ok: true, value: [] });
    await expect(lstat(marker)).rejects.toThrow();
    // Plain git does run it (the control).
    git(path.join(repo, 'sub'), 'status', '--porcelain');
    expect((await lstat(marker)).isFile()).toBe(true);
  });

  it('a redirected sub/.git in a copy does not refresh the original module; a moved submodule commit is still reported', async () => {
    const repo = await scratchRepo();
    await withSubmodule(repo, '../../../sub');
    git(repo, 'add', 'sub');
    git(repo, 'commit', '-qm', 'gitlink');
    const copy = await copyOf(repo);
    expect(await copyIsolationProblem(copy.root)).toBeUndefined();
    const index = path.join(repo, '.git', 'modules', 'sub', 'index');
    const before = (await lstat(index)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Agent-made, mid-run: point the copy's submodule at the original's.
    await writeFile(
      path.join(copy.root, 'sub', '.git'),
      `gitdir: ${path.join(repo, '.git', 'modules', 'sub')}\n`,
    );
    const pin = { gitDir: path.join(copy.root, '.git'), workTree: copy.root };
    const changes = await detectChangedFiles(copy.root, [], 'git', pin);
    expect(changes).toEqual({ ok: true, value: [] });
    expect((await lstat(index)).mtimeMs).toBe(before);
    await copy.dispose();

    // A new commit in the submodule moves its gitlink: still reported.
    await writeFile(path.join(repo, 'sub', 'n.txt'), 'n\n');
    git(path.join(repo, 'sub'), 'add', 'n.txt');
    git(path.join(repo, 'sub'), 'commit', '-qm', 'n');
    const moved = await detectChangedFiles(repo);
    expect(moved).toEqual({ ok: true, value: ['sub'] });
  });
});

describe('git directory candidates with linked metadata (phase gate g2 M1)', () => {
  /** `fixtures/tool.git` sharing the repository's objects through a link. */
  async function linkedTool(repo: string, worktree: string): Promise<string> {
    const tool = path.join(repo, 'fixtures', 'tool.git');
    await mkdir(path.dirname(tool));
    git(repo, 'init', '-q', '--bare', tool);
    await rm(path.join(tool, 'objects'), { recursive: true });
    await symlink('../../.git/objects', path.join(tool, 'objects'));
    git(tool, 'config', 'core.bare', 'false');
    git(tool, 'config', 'core.worktree', worktree);
    git(tool, 'read-tree', git(repo, 'rev-parse', 'HEAD').trim());
    return tool;
  }

  it('refuses a nested git directory with an objects link whose core.worktree names the original', async () => {
    const repo = await scratchRepo();
    await linkedTool(repo, repo);
    await writeFile(path.join(repo, 'README.md'), 'original dirty\n');
    const copy = await copyOf(repo);
    const copyTool = path.join(copy.root, 'fixtures', 'tool.git');
    // The vector is live: git from inside it in the copy works on the original.
    expect(git(copyTool, 'rev-parse', '--show-toplevel').trim()).toBe(repo);
    expect(await copyIsolationProblem(copy.root)).toBe(
      'fixtures/tool.git/config points git outside the copy',
    );
    await copy.dispose();
  });

  it('accepts the same layout with core.worktree inside the copy; git there leaves the original alone', async () => {
    const repo = await scratchRepo();
    await linkedTool(repo, '../..');
    await writeFile(path.join(repo, 'README.md'), 'original dirty\n');
    const copy = await copyOf(repo);
    await writeFile(path.join(copy.root, 'README.md'), 'copy dirty\n');
    expect(await copyIsolationProblem(copy.root)).toBeUndefined();
    git(
      path.join(copy.root, 'fixtures', 'tool.git'),
      'checkout',
      '--',
      ':/README.md',
    );
    expect(await readFile(path.join(copy.root, 'README.md'), 'utf8')).toBe(
      '# Scratch\n',
    );
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe(
      'original dirty\n',
    );
    await copy.dispose();
  });

  it('refuses a candidate git cannot answer for', async () => {
    const repo = await scratchRepo();
    await mkdir(path.join(repo, 'odd'));
    await writeFile(path.join(repo, 'odd', 'HEAD'), 'not a ref\n');
    await writeFile(path.join(repo, 'odd', 'config'), '[core]\n');
    const copy = await copyOf(repo);
    expect(await copyIsolationProblem(copy.root)).toBe(
      'git cannot read the git directory odd in the copy',
    );
    await copy.dispose();
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

  it('refuses an agent-made dir-to-link replacement before writing anything (phase gate round 2 L)', async () => {
    const { copy, repo } = await pair();
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, 'src', 'x'), 'original x');
    await writeFile(path.join(repo, 'src', 'y'), 'original y');
    await mkdir(path.join(copy, 'lib'));
    await writeFile(path.join(copy, 'lib', 'x'), 'agent x');
    await symlink('lib', path.join(copy, 'src'));
    const promoted = await promoteChanges(copy, repo, [
      'lib/x',
      'src',
      'src/x',
      'src/y',
    ]);
    expect(promoted.ok ? 'ok' : promoted.message).toBe(
      "could not promote the attempt's changes: src is a directory in the workspace",
    );
    expect(await readFile(path.join(repo, 'src', 'x'), 'utf8')).toBe(
      'original x',
    );
    expect(await readFile(path.join(repo, 'src', 'y'), 'utf8')).toBe(
      'original y',
    );
    expect((await readdir(repo)).toSorted()).toEqual(['src']);
  });

  it('never reads a changed path through a link the attempt created', async () => {
    const { copy, repo } = await pair();
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, 'src', 'x'), 'original x');
    await mkdir(path.join(copy, 'lib'));
    await writeFile(path.join(copy, 'lib', 'x'), 'agent x');
    await symlink('lib', path.join(copy, 'src'));
    const promoted = await promoteChanges(copy, repo, ['src/x']);
    expect(promoted.ok ? 'ok' : promoted.code).toBe('E_WORKSPACE_STATUS');
    expect(await readFile(path.join(repo, 'src', 'x'), 'utf8')).toBe(
      'original x',
    );
  });

  it('turns a file or workspace link into a directory only by deleting it first', async () => {
    const { copy, repo } = await pair();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-outside-'));
    await writeFile(path.join(repo, 'a'), 'file');
    await symlink(outside, path.join(repo, 'docs'));
    await writeFile(path.join(repo, 'gone.txt'), 'old');
    await mkdir(path.join(copy, 'a'));
    await writeFile(path.join(copy, 'a', 'b'), 'b');
    await mkdir(path.join(copy, 'docs'));
    await writeFile(path.join(copy, 'docs', 'x.txt'), 'x');
    const promoted = await promoteChanges(copy, repo, [
      'a',
      'a/b',
      'docs',
      'docs/x.txt',
      'gone.txt',
    ]);
    expect(promoted.ok).toBe(true);
    expect(await readFile(path.join(repo, 'a', 'b'), 'utf8')).toBe('b');
    expect((await lstat(path.join(repo, 'docs'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(repo, 'docs', 'x.txt'), 'utf8')).toBe('x');
    await expect(lstat(path.join(repo, 'gone.txt'))).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses unsafe paths', async () => {
    const { copy, repo } = await pair();
    for (const bad of ['../x', '/etc/x', '.git/config', 'a/../b', 'sub/']) {
      const promoted = await promoteChanges(copy, repo, [bad]);
      expect(promoted.ok ? 'ok' : promoted.code).toBe('E_WORKSPACE_STATUS');
    }
  });
});
