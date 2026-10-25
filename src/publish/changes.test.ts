import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildChangeSet,
  isSafeRepoPath,
  parseChangeSet,
} from '@agent-ci/publish/changes.js';
import { type RunOptions, runAgent } from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const SECRET = 'synthetic-credential-value-0042';

async function root(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-ci-changes-')));
}

describe('buildChangeSet', () => {
  it('captures writes (with mode), links and deletions in path order', async () => {
    const dir = await root();
    await mkdir(path.join(dir, 'bin'));
    await writeFile(path.join(dir, 'bin', 'tool'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    await writeFile(path.join(dir, 'a.md'), 'hello');
    await symlink('a.md', path.join(dir, 'link'));
    const set = await buildChangeSet({
      root: dir,
      files: ['link', 'gone.txt', 'bin/tool', 'a.md'],
      baseSha: 'a'.repeat(40),
      secrets: [SECRET],
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.files).toEqual([
      {
        path: 'a.md',
        action: 'write',
        mode: '100644',
        size: 5,
        sha256: createHash('sha256').update('hello').digest('hex'),
        contentBase64: Buffer.from('hello').toString('base64'),
      },
      expect.objectContaining({ path: 'bin/tool', mode: '100755' }),
      { path: 'gone.txt', action: 'delete' },
      { path: 'link', action: 'symlink', target: 'a.md' },
    ]);
    const reparsed = parseChangeSet(JSON.stringify(set.value));
    expect(reparsed.ok && reparsed.value).toEqual(set.value);
  });

  it('refuses a file or link that carries a credential value', async () => {
    const dir = await root();
    await writeFile(path.join(dir, 'leak.txt'), `x ${SECRET} y`);
    await symlink(SECRET, path.join(dir, 'leak-link'));
    for (const file of ['leak.txt', 'leak-link']) {
      const set = await buildChangeSet({
        root: dir,
        files: [file],
        baseSha: null,
        secrets: [SECRET],
      });
      expect(set.ok ? 'ok' : set.code).toBe('E_SECRET_COPY');
      expect(JSON.stringify(set)).not.toContain(SECRET);
    }
  });

  it('refuses paths through symlinked directories, directories and oversized files', async () => {
    const dir = await root();
    const outside = await root();
    await writeFile(path.join(outside, 'x.txt'), 'outside');
    await symlink(outside, path.join(dir, 'docs'));
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'big.bin'), Buffer.alloc(32));
    const cases: [string[], Record<string, number>?][] = [
      [['docs/x.txt']],
      [['sub']],
      [['big.bin'], { maxFileBytes: 16, maxTotalBytes: 100, maxFiles: 10 }],
      [['../escape']],
      [['a', 'b'], { maxFileBytes: 16, maxTotalBytes: 100, maxFiles: 1 }],
    ];
    for (const [files, limits] of cases) {
      const set = await buildChangeSet({
        root: dir,
        files,
        baseSha: null,
        secrets: [],
        ...(limits === undefined
          ? {}
          : {
              limits: limits as {
                maxFileBytes: number;
                maxTotalBytes: number;
                maxFiles: number;
              },
            }),
      });
      expect(set.ok ? 'ok' : set.code).toBe('E_CHANGE_SET');
    }
  });
});

const entry = (content: string, overrides: Record<string, unknown> = {}) => ({
  path: 'a.txt',
  action: 'write',
  mode: '100644',
  size: Buffer.byteLength(content),
  sha256: createHash('sha256').update(content).digest('hex'),
  contentBase64: Buffer.from(content).toString('base64'),
  ...overrides,
});
const doc = (files: unknown[]) =>
  JSON.stringify({ version: 1, baseSha: null, files });

describe('parseChangeSet', () => {
  it('rejects tampered, duplicated, unsafe or unknown entries', () => {
    const bad = [
      doc([entry('hi', { sha256: 'f'.repeat(64) })]),
      doc([entry('hi', { size: 3 })]),
      doc([entry('hi', { contentBase64: 'aGk' })]),
      doc([entry('hi'), entry('hi', { path: 'A.TXT' })]),
      doc([entry('hi', { path: '.git/config' })]),
      doc([entry('hi', { path: 'x/../y' })]),
      doc([entry('hi', { mode: '120000' })]),
      doc([{ ...entry('hi'), extra: true }]),
      doc([{ path: 'a', action: 'chmod' }]),
      'not json',
    ];
    for (const text of bad) {
      const parsed = parseChangeSet(text);
      expect(parsed.ok ? 'ok' : parsed.code).toBe('E_CHANGE_SET');
    }
    expect(parseChangeSet(doc([entry('hi')])).ok).toBe(true);
  });

  it('accepts only safe repository paths', () => {
    for (const ok of ['a', 'a/b.txt', '.github/x', 'dir/.gitignore']) {
      expect(isSafeRepoPath(ok)).toBe(true);
    }
    for (const bad of [
      '',
      '/a',
      'a/',
      'a//b',
      './a',
      'a/../b',
      '.git/x',
      'x/.GIT/y',
      'a\\b',
    ]) {
      expect(isSafeRepoPath(bad)).toBe(false);
    }
  });
});

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
  - id: fake-edit-commit
    model: fake-edit-commit
    harness: fake
    family: fake
    providerModel: edit-commit
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-edit-secret
    model: fake-edit-secret
    harness: fake
    family: fake
    providerModel: edit-secret
    credentials: [CURSOR_API_KEY]
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
  )
    .toString()
    .trim();

async function editRun(
  model: string,
  overrides: Partial<RunOptions> = {},
): Promise<{ repo: string; out: string; options: RunOptions }> {
  const base = await root();
  const repo = path.join(base, 'repo');
  await mkdir(repo);
  await writeFile(path.join(repo, 'README.md'), '# r\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const modelsPath = path.join(base, 'models.yaml');
  await writeFile(modelsPath, MODELS);
  const out = path.join(base, 'out');
  return {
    repo,
    out,
    options: {
      model,
      prompt: 'Edit.',
      cwd: repo,
      outDir: out,
      outputContract: 'changes',
      useCase: 'generic-prompt',
      targetRepo: 'local/scratch',
      mode: 'edit',
      allowPool: false,
      seedLogin: false,
      timeoutMs: 60_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      modelsPath,
      env: { PATH: process.env.PATH },
      ...overrides,
    },
  };
}

describe('agent-ci run writes changes.json for edit runs', () => {
  it('captures the detected change against the starting commit', async () => {
    const { repo, out, options } = await editRun('fake-edit');
    const summary = await runAgent(options);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.result.status).toBe('changed');
    expect(summary.value.changesPath).toBe(path.join(out, 'changes.json'));
    const set = parseChangeSet(
      await readFile(path.join(out, 'changes.json'), 'utf8'),
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(set.value.files.map((file) => file.path)).toEqual([
      'agent-ci-fake-edit.md',
    ]);
  });

  it('withholds a change set whose files carry the route credential', async () => {
    const { out, options } = await editRun('fake-edit-secret', {
      env: { PATH: process.env.PATH, CURSOR_API_KEY: SECRET },
    });
    const summary = await runAgent(options);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error?.code).toBe('E_SECRET_COPY');
    expect(summary.value.changesPath).toBeNull();
    expect(summary.value.result.status).toBe('failed');
    await expect(readFile(path.join(out, 'changes.json'))).rejects.toThrow();
    const written =
      (await readFile(summary.value.resultPath, 'utf8')) +
      (await readFile(summary.value.logPath, 'utf8'));
    expect(written).not.toContain(SECRET);
  });

  it('refuses a run that moved HEAD (commits are not published)', async () => {
    const { out, options } = await editRun('fake-edit-commit');
    const summary = await runAgent(options);
    expect(summary.ok && summary.value.error?.code).toBe('E_WORKSPACE_STATUS');
    await expect(readFile(path.join(out, 'changes.json'))).rejects.toThrow();
  });

  it('removes a stale change set left by an earlier run', async () => {
    const { out, options } = await editRun('fake-edit', { mode: 'read-only' });
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'changes.json'), '{"stale":true}');
    const summary = await runAgent(options);
    expect(summary.ok && summary.value.changesPath).toBeNull();
    await expect(readFile(path.join(out, 'changes.json'))).rejects.toThrow();
  });
});
