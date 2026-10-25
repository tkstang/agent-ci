import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
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
