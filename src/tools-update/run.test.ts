import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createToolsUpdateCommand } from '@agent-ci/commands/tools-update.js';
import type { ProcessRunner } from '@agent-ci/harness/install.js';
import { checkChangeSet, readRunOutputs } from '@agent-ci/publish/publish.js';
import {
  oatCliArgs,
  runToolsUpdate,
  type ToolsUpdateOptions,
} from '@agent-ci/tools-update/run.js';
import { describe, expect, it } from 'vitest';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();

async function repo(): Promise<{ root: string; out: string; base: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-tools-'));
  const root = path.join(base, 'repo');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'README.md'), 'hi\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return { root, out: path.join(base, 'out'), base };
}

interface Call {
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

/** A fake pnpm: `--version` answers, `tools update` writes the given files. */
function fakePnpm(
  writes: Record<string, string>,
  overrides: { version?: string; versionExit?: number; commit?: boolean } = {},
): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (_command, args, spawnOptions) => {
    calls.push({ args, cwd: spawnOptions.cwd, env: spawnOptions.env });
    if (args.includes('--version')) {
      return {
        exitCode: overrides.versionExit ?? 0,
        stdout: `${overrides.version ?? '0.3.33'}\n`,
        stderr: overrides.versionExit === undefined ? '' : 'not found',
      };
    }
    const root = args[args.indexOf('--cwd') + 1] ?? '';
    for (const [file, content] of Object.entries(writes)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    if (overrides.commit === true) {
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'sneaky');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function options(
  root: string,
  out: string,
  extra: Partial<ToolsUpdateOptions> = {},
): ToolsUpdateOptions {
  return {
    cwd: root,
    outDir: out,
    targetRepo: 'octo/widgets',
    oatCliVersion: '0.3.33',
    dependencyPolicy: 'skills-only',
    timeoutMs: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: '/home/operator',
      GITHUB_TOKEN: 'synthetic-github-token-value-01',
      NPM_TOKEN: 'synthetic-npm-token-value-02',
    },
    ...extra,
  };
}

describe('runToolsUpdate', () => {
  it('runs the pinned CLI in an isolated environment and publishes changes inside the policy', async () => {
    const { root, out } = await repo();
    const fake = fakePnpm({
      '.oat/tools.json': '{"v":2}\n',
      '.agents/skills/oat-x/SKILL.md': 'skill\n',
      '.gitignore': 'node_modules\n',
    });
    const summary = await runToolsUpdate(options(root, out), {
      run: fake.run,
    });
    if (!summary.ok) throw new Error(summary.message);
    expect(summary.value.error).toBeUndefined();
    expect(summary.value.result).toMatchObject({
      ok: true,
      status: 'changed',
      useCase: 'oat-tools-update',
      targetRepo: 'octo/widgets',
      changedFiles: [
        '.agents/skills/oat-x/SKILL.md',
        '.gitignore',
        '.oat/tools.json',
      ],
      outputContract: 'changes',
    });
    // Pinned dlx argv; project scope only; run from a temp dir, not the repo.
    expect(fake.calls.map((call) => call.args)).toEqual([
      oatCliArgs('0.3.33', ['--version']),
      oatCliArgs('0.3.33', [
        '--cwd',
        await realpath(root),
        'tools',
        'update',
        '--all',
        '--scope',
        'project',
      ]),
    ]);
    for (const call of fake.calls) {
      expect(call.env.HOME).not.toBe('/home/operator');
      expect(call.env.HOME).toBe(call.cwd);
      expect(call.env.GITHUB_TOKEN).toBeUndefined();
      expect(call.env.NPM_TOKEN).toBeUndefined();
      expect(call.env.PATH).toBe(process.env.PATH);
    }
    // The temporary home is gone afterwards.
    await expect(stat(fake.calls[0]?.cwd ?? '')).rejects.toThrow();
    // The publish job accepts the hand-off as is.
    const outputs = await readRunOutputs(out);
    if (!outputs.ok) throw new Error(outputs.message);
    expect(outputs.value.changeSet?.files.map((entry) => entry.path)).toEqual(
      summary.value.result.changedFiles,
    );
    expect(
      checkChangeSet(
        outputs.value.result,
        outputs.value.changeSet ?? { version: 1, baseSha: null, files: [] },
        false,
      ).ok,
    ).toBe(true);
    expect(outputs.value.changeSet?.baseSha).toBe(
      git(root, 'rev-parse', 'HEAD'),
    );
  });

  it('reports no-op without a change set', async () => {
    const { root, out } = await repo();
    const summary = await runToolsUpdate(options(root, out), {
      run: fakePnpm({}).run,
    });
    expect(summary.ok && summary.value.result.status).toBe('no-op');
    expect(summary.ok && summary.value.changesPath).toBeNull();
  });

  it('fails closed on changes outside the dependency policy', async () => {
    const { root, out } = await repo();
    const refused = await runToolsUpdate(options(root, out), {
      run: fakePnpm({
        '.oat/a.json': '{}',
        'pnpm-lock.yaml': 'x',
        'src/x.ts': 'x',
      }).run,
    });
    if (!refused.ok) throw new Error(refused.message);
    expect(refused.value.error?.code).toBe('E_PATH_POLICY');
    expect(refused.value.error?.message).toContain('pnpm-lock.yaml, src/x.ts');
    expect(refused.value.result.status).toBe('failed');
    expect(refused.value.changesPath).toBeNull();
    await expect(stat(path.join(out, 'changes.json'))).rejects.toThrow();

    const lockfile = await repo();
    const allowed = await runToolsUpdate(
      options(lockfile.root, lockfile.out, {
        dependencyPolicy: 'include-lockfile',
      }),
      { run: fakePnpm({ 'pnpm-lock.yaml': 'x' }).run },
    );
    expect(allowed.ok && allowed.value.result.status).toBe('changed');
  });

  it('refuses a dirty checkout, an output inside the repository and a loose version before running anything', async () => {
    const dirty = await repo();
    await writeFile(path.join(dirty.root, 'README.md'), 'edited\n');
    const fake = fakePnpm({});
    const results = [
      await runToolsUpdate(options(dirty.root, dirty.out), { run: fake.run }),
    ];
    const clean = await repo();
    results.push(
      await runToolsUpdate(
        options(clean.root, path.join(clean.root, '.agent-ci')),
        { run: fake.run },
      ),
      await runToolsUpdate(
        options(clean.root, clean.out, { oatCliVersion: 'file:../evil' }),
        { run: fake.run },
      ),
    );
    expect(results.map((result) => (result.ok ? 'ok' : result.code))).toEqual([
      'E_WORKSPACE_STATUS',
      'E_OUTPUT_PATH',
      'E_INVALID_INPUT',
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it('writes a failed result when the CLI cannot be resolved or HEAD moves', async () => {
    const unresolved = await repo();
    const missing = await runToolsUpdate(
      options(unresolved.root, unresolved.out),
      {
        run: fakePnpm({}, { versionExit: 1 }).run,
      },
    );
    expect(missing.ok && missing.value.error?.code).toBe('E_TOOLS_UPDATE');
    const written = JSON.parse(
      await readFile(path.join(unresolved.out, 'run-result.json'), 'utf8'),
    ) as { status: string; errors: string[] };
    expect(written.status).toBe('failed');
    expect(written.errors[0]).toMatch(/^E_TOOLS_UPDATE: /u);

    const moved = await repo();
    const committed = await runToolsUpdate(options(moved.root, moved.out), {
      run: fakePnpm({ '.oat/a.json': '{}' }, { commit: true }).run,
    });
    expect(committed.ok && committed.value.error?.code).toBe(
      'E_WORKSPACE_STATUS',
    );
  });
});

const context = (cwd: string) => ({
  cwd,
  env: { PATH: process.env.PATH },
  log: () => undefined,
});

describe('agent-ci tools-update', () => {
  it('returns the result, or the run error code after writing the failed result', async () => {
    const ok = await repo();
    const command = createToolsUpdateCommand({
      run: fakePnpm({ '.oat/a.json': '{}\n' }).run,
    });
    const data = (await command.run(
      [
        '--cwd',
        ok.root,
        '--out',
        ok.out,
        '--target-repo',
        'octo/widgets',
        '--oat-cli-version',
        '',
        '--dependency-policy',
        '',
      ],
      context(ok.base),
    )) as { status: string; changesPath: string };
    expect(data.status).toBe('changed');
    expect(data.changesPath).toBe(
      path.join(await realpath(ok.out), 'changes.json'),
    );

    const bad = await repo();
    const failing = createToolsUpdateCommand({
      run: fakePnpm({ 'src/x.ts': 'x' }).run,
    });
    await expect(
      failing.run(['--cwd', bad.root, '--out', bad.out], context(bad.base)),
    ).rejects.toMatchObject({ code: 'E_PATH_POLICY' });
    await expect(
      failing.run(
        ['--cwd', bad.root, '--out', bad.out, '--dependency-policy', 'all'],
        context(bad.base),
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });
});
