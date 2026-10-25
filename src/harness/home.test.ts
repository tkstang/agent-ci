import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createHomeRoot,
  homeLayout,
  loginStorePaths,
  type PipeRunner,
  seedLogin,
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
      '{"placeholder":"synthetic"}',
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
});
