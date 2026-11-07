import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it } from 'vitest';

const COMMAND = fileURLToPath(new URL('./prove.ts', import.meta.url));
const TSX = fileURLToPath(import.meta.resolve('tsx/cli'));
const ENTRY = '.github/workflows/agent-ci-artifact-conformance.yml';
const FILES = [
  ENTRY,
  '.github/workflows/agent-ci-artifact-conformance-nested.yml',
  '.github/workflows/agent-ci-artifact-conformance-leaf.yml',
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pinned-proof-'));
  roots.push(root);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '--quiet']);
  await mkdir(path.join(root, '.github/workflows'), { recursive: true });
  for (const file of FILES)
    await writeFile(path.join(root, file), await readFile(file));
  git(['add', '.github']);
  git([
    '-c',
    'user.name=Synthetic Test',
    '-c',
    'user.email=synthetic@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'test: synthetic graph',
  ]);
  return { root, git, sha: git(['rev-parse', 'HEAD']) };
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [TSX, COMMAND, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

it('proves the pinned commit despite a changed worktree and disabled Git replacement objects', async () => {
  const { root, sha, git } = await repository();
  await writeFile(path.join(root, ENTRY), 'untrusted-worktree-sentinel');
  git(['add', ENTRY]);
  git([
    '-c',
    'user.name=Synthetic Test',
    '-c',
    'user.email=synthetic@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'test: changed graph',
  ]);
  git(['replace', sha, git(['rev-parse', 'HEAD'])]);
  const result = run(root, [sha]);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const proof = JSON.parse(result.stdout);
  expect(proof).toMatchObject({
    ok: true,
    sourceSha: sha,
    productionQualified: false,
  });
  expect(proof.assignments).toHaveLength(8);
  expect(
    proof.workflowDigests.map((entry: { path: string }) => entry.path),
  ).toEqual(FILES);
  expect(result.stdout).not.toContain('untrusted-worktree-sentinel');
});

it('refuses movable refs, non-commit objects and additional arguments with one closed error', async () => {
  const { root, sha, git } = await repository();
  const blob = git(['rev-parse', `${sha}:${ENTRY}`]);
  for (const args of [
    [],
    ['HEAD'],
    [sha.slice(0, 7)],
    [blob],
    [sha, 'extra'],
  ]) {
    const result = run(root, args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('{"ok":false,"code":"E_CONFORMANCE_GRAPH"}\n');
    expect(result.stderr).toBe('');
  }
});

it('refuses an exact commit with an incomplete graph without leaking Git diagnostics', async () => {
  const { root, git } = await repository();
  git(['rm', ENTRY]);
  git([
    '-c',
    'user.name=Synthetic Test',
    '-c',
    'user.email=synthetic@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'test: incomplete graph',
  ]);
  const result = run(root, [git(['rev-parse', 'HEAD'])]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"code":"E_CONFORMANCE_GRAPH"}\n');
  expect(result.stderr).toBe('');
});
