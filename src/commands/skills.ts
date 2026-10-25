import path from 'node:path';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import type { ProcessRunner } from '@agent-ci/harness/install.js';
import { installSkills } from '@agent-ci/skills/install.js';

const USAGE = `agent-ci skills install — install skills into a home root before a run.

  agent-ci skills install --home-root <dir> --workspace <dir>
                          [--oat-pack <name>]... [--source <dir>]
                          [--oat-command <path>]

Creates (or reuses) the home root, which must not overlap the workspace, then
installs OAT packs at user scope with HOME inside the root (pinned OAT CLI via
npx; --oat-command uses a local oat binary instead) and/or copies the skills
under --source. Pass the same --home-root to agent-ci run. Reports the skill
names found in each provider view (.agents/skills, .claude/skills,
.codex/skills, .cursor/skills, .config/opencode/skills).`;

export function createSkillsCommand(
  deps: { readonly run?: ProcessRunner; readonly git?: string } = {},
): CommandSpec {
  return {
    name: 'skills',
    summary: 'Install skills into a per-job home root',
    usage: USAGE,
    async run(argv, context) {
      const [action, ...rest] = argv;
      if (action !== 'install') {
        throw new CliError('E_INVALID_INPUT', 'use: skills install', {
          hint: USAGE,
        });
      }
      const flags = parseFlags(
        rest,
        {
          'home-root': { type: 'string' },
          workspace: { type: 'string' },
          'oat-pack': { type: 'string', multiple: true },
          source: { type: 'string' },
          'oat-command': { type: 'string' },
        },
        USAGE,
      );
      const resolve = (value: string) => path.resolve(context.cwd, value);
      const installed = await installSkills({
        homeRoot: resolve(required(flags['home-root'], '--home-root')),
        workspace: resolve(required(flags.workspace, '--workspace')),
        oatPacks: flags['oat-pack'] ?? [],
        ...(flags.source === undefined
          ? {}
          : { sourceDir: resolve(flags.source) }),
        ...(flags['oat-command'] === undefined
          ? {}
          : { oatCommand: [flags['oat-command']] }),
        env: context.env,
        ...(deps.run === undefined ? {} : { run: deps.run }),
        ...(deps.git === undefined ? {} : { git: deps.git }),
      });
      if (!installed.ok) throw CliError.fromFailure(installed);
      for (const [view, names] of Object.entries(installed.value.views)) {
        context.log(
          `agent-ci skills: ~/${view}: ${names.join(', ') || '(empty)'}`,
        );
      }
      return installed.value;
    },
  };
}

export const skillsCommand = createSkillsCommand();
