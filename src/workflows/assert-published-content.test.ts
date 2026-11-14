import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import { describe, expect, it } from 'vitest';

function fixture(change?: readonly [string, string]) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-ci-content-proof-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  git('init', '-q', '-b', 'main');
  const files: Record<string, string> = {
    'agent-ci-command-fixture.mjs': 'export function answer() { return 42; }\n',
    'agent-ci-command-conflict.txt': 'base wording\nfeature wording\n',
    'agent-ci-command-base-only.txt': 'base addition\n',
    'agent-ci-skill-order.txt': 'first\nsecond\n',
  };
  if (change !== undefined) files[change[0]] = change[1];
  for (const [file, content] of Object.entries(files))
    writeFileSync(path.join(cwd, file), content);
  git('add', '.');
  git('commit', '-qm', 'test: published fixture');
  const sha = git('rev-parse', 'HEAD');
  const execute = (finalSha = sha) =>
    run(['selftest-content', '--sha', finalSha], {
      cwd,
      env: {},
      log: () => {},
    });
  return { cwd, git, sha, execute };
}

describe('published consumer content assertion command', () => {
  it('reads the requested commit even when HEAD and the worktree differ, without executing fixture code', async () => {
    const { cwd, git, execute } = fixture([
      'agent-ci-command-fixture.mjs',
      'throw new Error("must never execute");\nexport function answer() { return 42; }\n',
    ]);
    writeFileSync(
      path.join(cwd, 'agent-ci-command-base-only.txt'),
      'wrong HEAD\n',
    );
    git('commit', '-qam', 'test: later revision');
    writeFileSync(
      path.join(cwd, 'agent-ci-skill-order.txt'),
      'wrong worktree\n',
    );
    const result = await execute();
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      ok: true,
      command: 'selftest-content',
      data: { valid: true },
    });
  });

  it.each([
    [
      'fixture edit',
      'agent-ci-command-fixture.mjs',
      'export function answer() { return 0; }\n',
    ],
    ['base wording', 'agent-ci-command-conflict.txt', 'feature wording\n'],
    ['feature wording', 'agent-ci-command-conflict.txt', 'base wording\n'],
    [
      'opening conflict marker',
      'agent-ci-command-conflict.txt',
      '<<<<<<< HEAD\nbase wording\nfeature wording\n',
    ],
    [
      'separator conflict marker',
      'agent-ci-command-conflict.txt',
      'base wording\n=======\nfeature wording\n',
    ],
    [
      'closing conflict marker',
      'agent-ci-command-conflict.txt',
      'base wording\nfeature wording\n>>>>>>> topic\n',
    ],
    ['exact base addition', 'agent-ci-command-base-only.txt', 'base addition'],
    ['skill execution order', 'agent-ci-skill-order.txt', 'second\nfirst\n'],
  ])('rejects broken %s', async (_contract, file, content) => {
    const { execute } = fixture([file, content]);
    const result = await execute();
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_FAILED',
    });
  });

  it('fails when the requested commit does not contain a fixture file', async () => {
    const { git, execute } = fixture();
    git('rm', 'agent-ci-command-base-only.txt');
    git('commit', '-qm', 'test: missing fixture');
    expect((await execute(git('rev-parse', 'HEAD'))).envelope).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_FAILED',
    });
  });
});

it.each(['', 'HEAD', '--version', 'a'.repeat(39)])(
  'rejects invalid commit input %j before reading files',
  async (sha) => {
    const result = await run(['selftest-content', '--sha', sha], {
      cwd: '/not-a-repository',
      env: {},
      log: () => {},
    });
    expect(result.envelope).toMatchObject({
      ok: false,
      code: 'E_INVALID_INPUT',
    });
  },
);
