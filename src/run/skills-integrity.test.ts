import { existsSync } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { homeLayout } from '@agent-ci/harness/home.js';
import {
  fingerprintSkills,
  purgeSkills,
} from '@agent-ci/harness/skills-integrity.js';
import { spawnHarness } from '@agent-ci/harness/spawn.js';
import type { SpawnSpec } from '@agent-ci/harness/spawn.js';
import { type RunOptions, runAgent } from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const MODELS = `version: 1
routes:
  - id: fake-echo
    model: fake-echo
    harness: fake
    family: fake
    providerModel: echo
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
`;

async function setup(): Promise<{ options: RunOptions; homeRoot: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-skills-int-'));
  const cwd = path.join(dir, 'work');
  const skills = path.join(dir, 'skills', 'demo');
  await mkdir(cwd);
  await mkdir(skills, { recursive: true });
  await writeFile(
    path.join(skills, 'SKILL.md'),
    '---\nname: demo\ndescription: d\n---\nBody\n',
  );
  await writeFile(path.join(dir, 'models.yaml'), MODELS);
  const homeRoot = path.join(dir, 'home');
  return {
    homeRoot,
    options: {
      model: 'fake-echo',
      prompt: 'Summarize.',
      cwd,
      outDir: path.join(dir, 'out'),
      outputContract: 'report',
      useCase: 'generic-prompt',
      targetRepo: 'local/scratch',
      mode: 'read-only',
      allowPool: false,
      seedLogin: false,
      timeoutMs: 60_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      modelsPath: path.join(dir, 'models.yaml'),
      env: { PATH: process.env.PATH },
      skillsDir: path.join(dir, 'skills'),
      homeRoot,
    },
  };
}

/** Runs the real fake harness after optionally editing a skill from "inside" the run. */
function spawnWith(tamper: boolean) {
  return async (spec: SpawnSpec) => {
    if (tamper) {
      await appendFile(
        path.join(spec.env.HOME ?? '', '.agents', 'skills', 'demo', 'SKILL.md'),
        'allowed-tools: Bash\n',
      );
    }
    return await spawnHarness(spec);
  };
}

describe('installed-skill integrity', () => {
  it('fails closed and purges the skills when a run changes them (kept home)', async () => {
    const { options, homeRoot } = await setup();
    const summary = await runAgent(options, {
      harness: { spawn: spawnWith(true) },
    });
    if (!summary.ok) throw new Error(summary.message);
    expect(summary.value.error?.code).toBe('E_HOME_ROOT');
    expect(summary.value.result.status).toBe('failed');
    const layout = homeLayout(homeRoot);
    // Nothing modified survives in the kept home root.
    expect(await readdir(layout.skillsDir)).toEqual([]);
    expect(existsSync(path.join(layout.home, '.claude', 'skills'))).toBe(false);
  });

  it('leaves unchanged skills in place (control)', async () => {
    const { options, homeRoot } = await setup();
    const summary = await runAgent(options, {
      harness: { spawn: spawnWith(false) },
    });
    if (!summary.ok) throw new Error(summary.message);
    expect(summary.value.error).toBeUndefined();
    expect(summary.value.result.ok).toBe(true);
    expect(await readdir(homeLayout(homeRoot).skillsDir)).toEqual(['demo']);
  });

  it('fingerprints content, modes and links, and purges to an empty tree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-skills-fp-'));
    const layout = homeLayout(root);
    await mkdir(path.join(layout.skillsDir, 'a'), { recursive: true });
    await writeFile(path.join(layout.skillsDir, 'a', 'SKILL.md'), 'x');
    const first = await fingerprintSkills(layout);
    expect(first.ok).toBe(true);
    expect(await fingerprintSkills(layout)).toEqual(first);
    await writeFile(path.join(layout.skillsDir, 'a', 'SKILL.md'), 'y');
    const changed = await fingerprintSkills(layout);
    expect(changed.ok && first.ok && changed.value !== first.value).toBe(true);
    await purgeSkills(layout);
    expect(await readdir(layout.skillsDir)).toEqual([]);
  });
});

describe('purge never follows a redirected parent (gate C1)', () => {
  for (const parent of ['.agents', '.claude']) {
    it(`keeps an external directory when the run redirects home/${parent}`, async () => {
      const { options, homeRoot } = await setup();
      const external = path.join(path.dirname(homeRoot), `external-${parent}`);
      await mkdir(path.join(external, 'skills'), { recursive: true });
      const sentinel = path.join(external, 'skills', 'keep.md');
      await writeFile(sentinel, 'unrelated\n');
      const summary = await runAgent(options, {
        harness: {
          spawn: async (spec: SpawnSpec) => {
            const target = path.join(spec.env.HOME ?? '', parent);
            await rm(target, { recursive: true, force: true });
            await symlink(external, target);
            return await spawnHarness(spec);
          },
        },
      });
      if (!summary.ok) throw new Error(summary.message);
      expect(summary.value.error?.code).toBe('E_HOME_ROOT');
      // The external directory and its contents survive...
      expect(existsSync(sentinel)).toBe(true);
      // ...and the redirecting link itself was removed from the home.
      const layout = homeLayout(homeRoot);
      const info = await lstat(path.join(layout.home, parent)).catch(
        () => null,
      );
      expect(info === null || !info.isSymbolicLink()).toBe(true);
    });
  }

  it('purges through real directories and unlinks a redirected ancestor directly', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'agent-ci-skills-purge-'),
    );
    const layout = homeLayout(path.join(root, 'home-root'));
    const external = path.join(root, 'external');
    await mkdir(path.join(external, 'skills', 'x'), { recursive: true });
    await writeFile(path.join(external, 'skills', 'x', 'SKILL.md'), 'keep');
    await mkdir(layout.home, { recursive: true });
    await symlink(external, path.join(layout.home, '.agents'));
    await mkdir(path.join(layout.home, '.claude'), { recursive: true });
    await symlink(external, path.join(layout.home, '.claude', 'skills'));
    // The fingerprint does not follow the links either.
    const print = await fingerprintSkills(layout);
    expect(print.ok).toBe(true);
    await purgeSkills(layout);
    expect(existsSync(path.join(external, 'skills', 'x', 'SKILL.md'))).toBe(
      true,
    );
    expect(
      (await lstat(path.join(layout.home, '.agents'))).isSymbolicLink(),
    ).toBe(false);
    expect(existsSync(path.join(layout.home, '.claude', 'skills'))).toBe(false);
    expect(await readdir(layout.skillsDir)).toEqual([]);
  });
});
