import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import { installSkills } from '@agent-ci/skills/install.js';
import { describe, expect, it } from 'vitest';

const SYNTHETIC = 'synthetic-parent-credential-0123';

/** A stand-in OAT CLI that writes what `oat` would into $HOME. */
async function fakeOat(dir: string, extra = ''): Promise<string> {
  const bin = path.join(dir, 'oat');
  await writeFile(
    bin,
    `#!/bin/sh
env | cut -d= -f1 | sort > "$HOME/../oat-env-names.txt"
case "$1" in
  init) mkdir -p "$HOME/.agents/skills" ;;
  tools) mkdir -p "$HOME/.agents/skills/$3-skill" && printf -- '---\\nname: %s-skill\\n---\\n' "$3" > "$HOME/.agents/skills/$3-skill/SKILL.md" ;;
  sync)
    mkdir -p "$HOME/.claude/skills"
    for d in "$HOME"/.agents/skills/*; do n=$(basename "$d"); ln -sfn "../../.agents/skills/$n" "$HOME/.claude/skills/$n"; done
    ${extra}
    ;;
esac
echo '{}'
`,
    { mode: 0o755 },
  );
  return bin;
}

async function workspaceAndRoot(): Promise<{
  base: string;
  ws: string;
  root: string;
}> {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'agent-ci-skills-')),
  );
  const ws = path.join(base, 'ws');
  await mkdir(ws);
  execFileSync('git', ['init', '-q'], { cwd: ws });
  return { base, ws, root: path.join(base, 'home-root') };
}

describe('installSkills', () => {
  it('installs OAT packs at user scope inside the root with a credential-free environment', async () => {
    const { base, ws, root } = await workspaceAndRoot();
    const oat = await fakeOat(base);
    const installed = await installSkills({
      homeRoot: root,
      workspace: ws,
      oatPacks: ['core', 'docs'],
      oatCommand: [oat],
      env: { PATH: process.env.PATH, CURSOR_API_KEY: SYNTHETIC, HOME: '/real' },
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.views).toEqual({
      '.agents/skills': ['core-skill', 'docs-skill'],
      '.claude/skills': ['core-skill', 'docs-skill'],
    });
    expect(
      await readlink(
        path.join(root, 'home', '.claude', 'skills', 'core-skill'),
      ),
    ).toBe('../../.agents/skills/core-skill');
    const names = await readFile(path.join(root, 'oat-env-names.txt'), 'utf8');
    expect(names).not.toContain('CURSOR_API_KEY');
    expect(names).toContain('XDG_CONFIG_HOME');
  });

  it('copies a skills directory into the canonical tree and the Claude view', async () => {
    const { base, ws, root } = await workspaceAndRoot();
    const source = path.join(base, 'skills');
    await mkdir(path.join(source, 'probe'), { recursive: true });
    await writeFile(
      path.join(source, 'probe', 'SKILL.md'),
      '---\nname: probe\n---\n',
    );
    const installed = await installSkills({
      homeRoot: root,
      workspace: ws,
      oatPacks: [],
      sourceDir: source,
      env: { PATH: process.env.PATH },
    });
    expect(installed.ok && installed.value.views).toEqual({
      '.agents/skills': ['probe'],
      '.claude/skills': ['probe'],
    });
  });

  it('refuses a home root inside the workspace and a link into the workspace', async () => {
    const { base, ws, root } = await workspaceAndRoot();
    const inside = await installSkills({
      homeRoot: path.join(ws, '.home'),
      workspace: ws,
      oatPacks: ['core'],
      oatCommand: [await fakeOat(base)],
      env: { PATH: process.env.PATH },
    });
    expect(inside.ok ? 'ok' : inside.code).toBe('E_HOME_ROOT');
    const evil = await installSkills({
      homeRoot: root,
      workspace: ws,
      oatPacks: ['core'],
      oatCommand: [
        await fakeOat(base, `ln -s "${ws}" "$HOME/.claude/skills/evil"`),
      ],
      env: { PATH: process.env.PATH },
    });
    expect(evil.ok ? 'ok' : evil.code).toBe('E_HOME_ROOT');
  });

  it('rejects bad pack names and an empty request; the CLI needs both paths', async () => {
    const { ws, root } = await workspaceAndRoot();
    for (const oatPacks of [['Core; rm'], []]) {
      const result = await installSkills({
        homeRoot: root,
        workspace: ws,
        oatPacks,
        env: {},
      });
      expect(result.ok ? 'ok' : result.code).toBe('E_INVALID_INPUT');
    }
    const cli = await run(['skills', 'install', '--home-root', root], {
      cwd: ws,
      env: {},
      log: () => undefined,
    });
    expect(cli.envelope).toMatchObject({ ok: false, code: 'E_INVALID_INPUT' });
  });
});
