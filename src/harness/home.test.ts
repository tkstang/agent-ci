import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createHomeRoot,
  homeLayout,
  type ExportRunner,
  loginStorePaths,
  type PipeRunner,
  readLoginSecrets,
  seedLogin,
  writeOwnedFile,
  seedSkills,
} from '@agent-ci/harness/home.js';
import { describe, expect, it } from 'vitest';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('home root', () => {
  it('creates the isolated layout under a fresh private root', async () => {
    const created = await createHomeRoot();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const layout = created.value;
    for (const dir of [...Object.values(layout.env), layout.skillsDir]) {
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect(dir.startsWith(layout.root)).toBe(true);
    }
    expect(layout.env.HOME).toBe(path.join(layout.root, 'home'));
  });

  it('rejects relative and symlinked roots', async () => {
    expect(await createHomeRoot('relative/root')).toMatchObject({
      code: 'E_HOME_ROOT',
    });
    const base = await tempDir('agent-ci-home-link-');
    await mkdir(path.join(base, 'real'));
    await symlink(path.join(base, 'real'), path.join(base, 'link'));
    expect(await createHomeRoot(path.join(base, 'link'))).toMatchObject({
      code: 'E_HOME_ROOT',
    });
  });
});

describe('seeding the home root', () => {
  it('seeds installed skills into the canonical tree and the Claude view', async () => {
    const source = await tempDir('agent-ci-skills-');
    await mkdir(path.join(source, 'demo-skill'));
    await writeFile(path.join(source, 'demo-skill', 'SKILL.md'), '# demo\n');
    const created = await createHomeRoot();
    if (!created.ok) throw new Error(created.message);
    const seeded = await seedSkills(created.value, source);
    expect(seeded.ok).toBe(true);
    for (const target of [
      path.join(created.value.skillsDir, 'demo-skill', 'SKILL.md'),
      path.join(
        created.value.home,
        '.claude',
        'skills',
        'demo-skill',
        'SKILL.md',
      ),
    ]) {
      expect(await readFile(target, 'utf8')).toBe('# demo\n');
    }
  });

  it('seeds an opted-in codex login file with private permissions', async () => {
    const realHome = await tempDir('agent-ci-real-home-');
    await mkdir(path.join(realHome, '.codex'));
    await writeFile(
      path.join(realHome, '.codex', 'auth.json'),
      '{"tokens":{"access_token":"synthetic-codex-token-01"},"auth_mode":"chatgpt"}',
      { mode: 0o600 },
    );
    const created = await createHomeRoot();
    if (!created.ok) throw new Error(created.message);
    const seeded = await seedLogin(created.value, {
      harness: 'codex',
      parentEnv: { HOME: realHome, PATH: '/usr/bin:/bin' },
    });
    expect(seeded.ok).toBe(true);
    expect(seeded.ok && seeded.value.secrets).toEqual([
      'synthetic-codex-token-01',
    ]);
    const target = path.join(created.value.env.CODEX_HOME ?? '', 'auth.json');
    expect(await readFile(target, 'utf8')).toBe(
      '{"tokens":{"access_token":"synthetic-codex-token-01"},"auth_mode":"chatgpt"}',
    );
    expect((await stat(target)).mode & 0o077).toBe(0);
  });

  it('pipes opencode export into an import that targets only the isolated home', async () => {
    const calls: Parameters<PipeRunner>[] = [];
    const pipe: PipeRunner = async (...args) => {
      calls.push(args);
      return {
        fromExit: 0,
        toExit: 0,
        transferred: JSON.stringify([
          { access: 'synthetic-opencode-access-0001', label: 'Personal' },
        ]),
      };
    };
    const layout = homeLayout('/tmp/agent-ci-home-pipe');
    const seeded = await seedLogin(layout, {
      harness: 'opencode',
      parentEnv: { HOME: '/Users/operator', PATH: '/usr/bin' },
      pipe,
    });
    expect(seeded.ok).toBe(true);
    expect(seeded.ok && seeded.value.secrets).toEqual([
      'synthetic-opencode-access-0001',
    ]);
    const [from, to] = calls[0] ?? [];
    expect(from).toMatchObject({
      args: ['auth', 'export'],
      env: { HOME: '/Users/operator' },
    });
    expect(to).toMatchObject({
      args: ['auth', 'import', '--standalone'],
      env: { ...layout.env, PATH: '/usr/bin' },
    });
  });

  it('refuses login seeding under CI and for key-only harnesses', async () => {
    const layout = homeLayout('/tmp/agent-ci-home-refuse');
    for (const flag of ['CI', 'GITHUB_ACTIONS']) {
      expect(
        await seedLogin(layout, {
          harness: 'codex',
          parentEnv: { [flag]: '1' },
        }),
      ).toMatchObject({ code: 'E_SEED_REFUSED' });
    }
    expect(
      await seedLogin(layout, { harness: 'cursor', parentEnv: {} }),
    ).toMatchObject({ code: 'E_SEED_UNSUPPORTED' });
  });

  it('reports a missing login file as unsupported, not as success', async () => {
    const realHome = await tempDir('agent-ci-empty-home-');
    const created = await createHomeRoot();
    if (!created.ok) throw new Error(created.message);
    expect(
      await seedLogin(created.value, {
        harness: 'claude',
        parentEnv: { HOME: realHome },
      }),
    ).toMatchObject({ code: 'E_SEED_UNSUPPORTED' });
  });

  it('starts every run in a kept root without the previous login, and reseeds cleanly', async () => {
    const realHome = await tempDir('agent-ci-real-home-');
    await mkdir(path.join(realHome, '.codex'));
    await writeFile(
      path.join(realHome, '.codex', 'auth.json'),
      '{"placeholder":"synthetic-kept-root-0020"}',
    );
    const root = await tempDir('agent-ci-kept-root-');
    const parentEnv = { HOME: realHome, PATH: '/usr/bin:/bin' };
    const first = await createHomeRoot(root);
    if (!first.ok) throw new Error(first.message);
    expect(
      (await seedLogin(first.value, { harness: 'codex', parentEnv })).ok,
    ).toBe(true);
    // Simulate other harnesses' stores left behind by earlier runs.
    const stores = loginStorePaths(first.value);
    for (const file of stores) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'synthetic');
    }
    const second = await createHomeRoot(root);
    if (!second.ok) throw new Error(second.message);
    for (const file of stores) expect(existsSync(file), file).toBe(false);
    expect(
      (await seedLogin(second.value, { harness: 'codex', parentEnv })).ok,
    ).toBe(true);
  });

  it('reports a login already in the root accurately instead of blaming the source', async () => {
    const realHome = await tempDir('agent-ci-real-home-');
    await mkdir(path.join(realHome, '.codex'));
    await writeFile(path.join(realHome, '.codex', 'auth.json'), '{}');
    const created = await createHomeRoot();
    if (!created.ok) throw new Error(created.message);
    await writeFile(
      path.join(created.value.env.CODEX_HOME ?? '', 'auth.json'),
      '{}',
    );
    const seeded = await seedLogin(created.value, {
      harness: 'codex',
      parentEnv: { HOME: realHome },
    });
    expect(seeded).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
    expect(!seeded.ok && seeded.message).toContain(
      'already present in the home root',
    );
  });

  it('reads token values from the current login stores, exporting OpenCode only for login routes', async () => {
    const created = await createHomeRoot();
    if (!created.ok) throw new Error(created.message);
    await writeFile(
      path.join(created.value.env.CODEX_HOME ?? '', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'synthetic-file-token-0017' } }),
    );
    const calls: string[][] = [];
    const exportRunner: ExportRunner = async (_command, args, env) => {
      calls.push([...args, env.XDG_DATA_HOME ?? '']);
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ access: 'synthetic-export-token-0017' }]),
      };
    };
    const withStore = await readLoginSecrets(created.value, {
      harness: 'opencode',
      parentEnv: { PATH: '/usr/bin' },
      includeOpencodeStore: true,
      exportRunner,
    });
    expect(withStore.ok && withStore.value.toSorted()).toEqual([
      'synthetic-export-token-0017',
      'synthetic-file-token-0017',
    ]);
    expect(calls).toEqual([
      ['auth', 'export', '--standalone', created.value.env.XDG_DATA_HOME ?? ''],
    ]);
    const fileOnly = await readLoginSecrets(created.value, {
      harness: 'opencode',
      parentEnv: {},
      includeOpencodeStore: false,
      exportRunner,
    });
    expect(fileOnly).toEqual({
      ok: true,
      value: ['synthetic-file-token-0017'],
    });
    expect(calls).toHaveLength(1);
  });
});

describe('kept home root validation', () => {
  async function keptRoot() {
    const base = await realpath(await tempDir('agent-ci-kept-validate-'));
    const root = path.join(base, 'root');
    const workspace = path.join(base, 'workspace');
    await mkdir(path.join(root, 'home'), { recursive: true });
    await mkdir(workspace);
    return { base, root, workspace };
  }

  it('refuses a layout directory that links into the workspace and leaves its target untouched', async () => {
    const { root, workspace } = await keptRoot();
    const redirected = path.join(workspace, 'redirected-login');
    await mkdir(redirected);
    await writeFile(path.join(redirected, 'auth.json'), 'workspace file');
    await symlink(redirected, path.join(root, 'home', '.codex'));
    expect(
      await createHomeRoot(root, { workspaceRoot: workspace }),
    ).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
    // The old code cleared this "login store" through the link.
    expect(await readFile(path.join(redirected, 'auth.json'), 'utf8')).toBe(
      'workspace file',
    );
  });

  it('refuses links that leave the root at credential locations', async () => {
    const cases: ((root: string, base: string) => Promise<void>)[] = [
      // A login file borrowed from outside the root.
      async (root, base) => {
        await writeFile(path.join(base, 'operator-auth.json'), '{}');
        await mkdir(path.join(root, 'home', '.codex'), { recursive: true });
        await symlink(
          path.join(base, 'operator-auth.json'),
          path.join(root, 'home', '.codex', 'auth.json'),
        );
      },
      // An ancestor of XDG_DATA_HOME/opencode redirected outside the root.
      async (root, base) => {
        await mkdir(path.join(base, 'operator-local'));
        await symlink(
          path.join(base, 'operator-local'),
          path.join(root, 'home', '.local'),
        );
      },
      // A skills directory linked outside the root.
      async (root, base) => {
        await mkdir(path.join(base, 'operator-skills'));
        await mkdir(path.join(root, 'home', '.agents'), { recursive: true });
        await symlink(
          path.join(base, 'operator-skills'),
          path.join(root, 'home', '.agents', 'skills'),
        );
      },
    ];
    for (const plant of cases) {
      const { base, root } = await keptRoot();
      await plant(root, base);
      expect(await createHomeRoot(root)).toMatchObject({
        ok: false,
        code: 'E_HOME_ROOT',
      });
    }
  });

  it('accepts cache links that leave the root, but never one into the workspace', async () => {
    const { base, root, workspace } = await keptRoot();
    // Like Cursor's uv cache: a virtualenv interpreter linked to a system Python.
    const venvBin = path.join(root, 'home', '.cache', 'uv', 'env', 'bin');
    await mkdir(venvBin, { recursive: true });
    await writeFile(path.join(base, 'system-python'), '');
    await symlink(
      path.join(base, 'system-python'),
      path.join(venvBin, 'python'),
    );
    expect((await createHomeRoot(root, { workspaceRoot: workspace })).ok).toBe(
      true,
    );
    await symlink(workspace, path.join(venvBin, 'into-workspace'));
    expect(
      await createHomeRoot(root, { workspaceRoot: workspace }),
    ).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
  });

  it('accepts links that stay inside the root (provider skill views)', async () => {
    const { root, workspace } = await keptRoot();
    await mkdir(path.join(root, 'home', '.agents', 'skills', 'demo'), {
      recursive: true,
    });
    await mkdir(path.join(root, 'home', '.claude', 'skills'), {
      recursive: true,
    });
    await symlink(
      path.join(root, 'home', '.agents', 'skills', 'demo'),
      path.join(root, 'home', '.claude', 'skills', 'demo'),
    );
    expect((await createHomeRoot(root, { workspaceRoot: workspace })).ok).toBe(
      true,
    );
  });

  it('maps a file in place of a layout directory and a dangling ancestor to E_HOME_ROOT', async () => {
    const { base, root } = await keptRoot();
    await writeFile(path.join(root, 'home', '.codex'), 'not a directory');
    expect(await createHomeRoot(root)).toMatchObject({
      ok: false,
      code: 'E_HOME_ROOT',
    });
    await symlink(path.join(base, 'missing'), path.join(base, 'dangling'));
    expect(
      await createHomeRoot(path.join(base, 'dangling', 'h')),
    ).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
  });

  it('writes owned files without following a link', async () => {
    const { base, root } = await keptRoot();
    const target = path.join(base, 'elsewhere.txt');
    await writeFile(target, 'original');
    const file = path.join(root, 'owned.txt');
    await symlink(target, file);
    await writeOwnedFile(file, 'agent-ci');
    expect(await readFile(target, 'utf8')).toBe('original');
    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('agent-ci');
  });

  it('fails the guard instead of reading an oversized login store', async () => {
    const created = await createHomeRoot();
    if (!created.ok) throw new Error(created.message);
    await writeFile(
      path.join(created.value.env.CODEX_HOME ?? '', 'auth.json'),
      `{"pad":"${'x'.repeat(1024 * 1024)}"}`,
    );
    expect(
      await readLoginSecrets(created.value, {
        harness: 'codex',
        parentEnv: {},
        includeOpencodeStore: false,
      }),
    ).toMatchObject({ ok: false, code: 'E_SECRET_GUARD' });
  });

  it('reads stores without following links or blocking on a FIFO', async () => {
    const created = await createHomeRoot();
    if (!created.ok) throw new Error(created.message);
    const store = path.join(created.value.env.CODEX_HOME ?? '', 'auth.json');
    const read = () =>
      readLoginSecrets(created.value, {
        harness: 'codex',
        parentEnv: {},
        includeOpencodeStore: false,
      });
    // A FIFO would block a plain read forever; the guard must fail fast.
    execFileSync('mkfifo', [store]);
    const started = Date.now();
    expect(await read()).toMatchObject({ ok: false, code: 'E_SECRET_GUARD' });
    expect(Date.now() - started).toBeLessThan(2_000);
    await rm(store);
    // A link to a readable JSON file is refused, not followed.
    const elsewhere = path.join(created.value.root, 'elsewhere.json');
    await writeFile(
      elsewhere,
      '{"tokens":{"placeholder":"synthetic-link-0030"}}',
    );
    await symlink(elsewhere, store);
    expect(await read()).toMatchObject({ ok: false, code: 'E_SECRET_GUARD' });
  });

  it('refuses a kept root that contains the workspace before creating anything', async () => {
    const { root } = await keptRoot();
    const workspace = path.join(root, 'home');
    await mkdir(path.join(workspace, '.codex'), { recursive: true });
    await writeFile(
      path.join(workspace, '.codex', 'auth.json'),
      'workspace-owned',
    );
    expect(
      await createHomeRoot(root, { workspaceRoot: workspace }),
    ).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
    expect(
      await readFile(path.join(workspace, '.codex', 'auth.json'), 'utf8'),
    ).toBe('workspace-owned');
    expect(existsSync(path.join(workspace, '.claude'))).toBe(false);
  });
});
