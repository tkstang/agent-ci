import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { BASE_ENV_ALLOWLIST } from '@agent-ci/harness/env.js';
import {
  createHomeRoot,
  seedSkills,
  validateHomeTree,
} from '@agent-ci/harness/home.js';
import {
  defaultProcessRunner,
  type ProcessRunner,
} from '@agent-ci/harness/install.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import { findWorkspaceRoot } from '@agent-ci/run/workspace.js';

/**
 * Install skills into a per-job (or per-run) home root before the agent
 * runs, so isolation and skill discovery share one mechanism: the harness
 * later runs with HOME and its config homes inside the same root.
 *
 * OAT packs are installed at user scope by the OAT CLI with HOME pointed at
 * the root (canonical `~/.agents/skills` plus provider views such as
 * `~/.claude/skills`); a plain skills directory can be copied as well.
 */

/** The OAT CLI, pinned (the version qualified locally on 2026-10-25). */
export const OAT_CLI = ['npx', '--yes', '@open-agent-toolkit/cli@0.3.33'];

/** OAT providers enabled for user-scope sync (OAT has no OpenCode provider). */
export const OAT_PROVIDERS = 'claude,codex,cursor';

/** Provider views listed after install, relative to HOME. */
export const SKILL_VIEWS = [
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.cursor/skills',
  '.config/opencode/skills',
] as const;

const PACK = /^[a-z][a-z-]*$/u;
const OAT_TIMEOUT_MS = 5 * 60_000;

export interface InstallSkillsOptions {
  readonly homeRoot: string;
  /** The workspace the agent will run in; the root must be disjoint from it. */
  readonly workspace: string;
  readonly oatPacks: readonly string[];
  readonly sourceDir?: string;
  /** OAT CLI command and leading args (default: pinned `npx`). */
  readonly oatCommand?: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run?: ProcessRunner;
  readonly git?: string;
}

export interface InstalledSkills {
  readonly homeRoot: string;
  readonly home: string;
  readonly oatPacks: readonly string[];
  /** Skill names per view (relative to HOME); absent views are omitted. */
  readonly views: Readonly<Record<string, readonly string[]>>;
}

async function listView(dir: string): Promise<string[] | undefined> {
  try {
    return (await readdir(dir)).toSorted();
  } catch {
    return undefined;
  }
}

export async function installSkills(
  options: InstallSkillsOptions,
): Promise<Result<InstalledSkills>> {
  const badPack = options.oatPacks.find((pack) => !PACK.test(pack));
  if (badPack !== undefined) {
    return failure('E_INVALID_INPUT', `invalid OAT pack name ${badPack}`);
  }
  if (options.oatPacks.length === 0 && options.sourceDir === undefined) {
    return failure(
      'E_INVALID_INPUT',
      'nothing to install: pass --oat-pack and/or --source',
    );
  }
  const boundary = await findWorkspaceRoot(options.workspace, options.git);
  if (!boundary.ok) return boundary;
  const home = await createHomeRoot(options.homeRoot, {
    workspaceRoot: boundary.value.root,
  });
  if (!home.ok) return home;
  const layout = home.value;

  if (options.sourceDir !== undefined) {
    const seeded = await seedSkills(layout, options.sourceDir);
    if (!seeded.ok) return seeded;
  }

  if (options.oatPacks.length > 0) {
    const run = options.run ?? defaultProcessRunner;
    const [command, ...prefix] = options.oatCommand ?? OAT_CLI;
    if (command === undefined) {
      return failure('E_INVALID_INPUT', 'empty OAT command');
    }
    // No credential or config home from the parent: allowlisted base
    // variables plus the root's own HOME and XDG directories.
    const env: Record<string, string> = {};
    for (const name of BASE_ENV_ALLOWLIST) {
      const value = options.env[name];
      if (value !== undefined) env[name] = value;
    }
    Object.assign(env, layout.env, {
      NO_COLOR: '1',
      npm_config_update_notifier: 'false',
    });
    const steps: string[][] = [
      ['init', '--scope', 'user', '--no-project-guidance', '--no-hook'],
      ...options.oatPacks.map((pack) => [
        'tools',
        'install',
        pack,
        '--scope',
        'user',
        '--no-sync',
        '--no-project-guidance',
      ]),
      ['providers', 'set', '--scope', 'user', '--enabled', OAT_PROVIDERS],
      ['sync', '--scope', 'user'],
    ];
    for (const step of steps) {
      const result = await run(command, [...prefix, ...step, '--json'], {
        cwd: layout.home,
        env,
        timeoutMs: OAT_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return failure(
          'E_HOME_ROOT',
          `oat ${step.slice(0, 3).join(' ')} failed (exit ${result.exitCode ?? 'none'}): ${result.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`,
        );
      }
    }
  }

  // The installer wrote into the root: links must stay inside it and out of
  // the workspace before a harness trusts this home.
  const valid = await validateHomeTree(layout.root, boundary.value.root);
  if (!valid.ok) return valid;

  const views: Record<string, readonly string[]> = {};
  for (const view of SKILL_VIEWS) {
    const names = await listView(path.join(layout.home, view));
    if (names !== undefined) views[view] = names;
  }
  return success({
    homeRoot: layout.root,
    home: layout.home,
    oatPacks: options.oatPacks,
    views,
  });
}
