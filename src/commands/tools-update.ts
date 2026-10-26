import path from 'node:path';

import {
  oneOf,
  optional,
  parseFlags,
  positiveInt,
  required,
} from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import {
  runToolsUpdate,
  type ToolsUpdateDeps,
} from '@agent-ci/tools-update/run.js';
import { DEPENDENCY_POLICIES } from '@agent-ci/use-cases/presets.js';

const USAGE = `agent-ci tools-update — deterministic OAT tools update (no model, no credential).

  agent-ci tools-update --out <dir> [--cwd <repo>] [--target-repo <owner/name>]
                        [--oat-cli-version <latest|x.y.z>]
                        [--dependency-policy <skills-only|include-lockfile>]
                        [--timeout-minutes <n>]

Runs the pinned @open-agent-toolkit/cli (pnpm dlx) as
\`oat --cwd <repo> tools update --all --scope project\` with a temporary HOME
and an allowlisted environment, then refuses changes outside the policy
(OAT-managed trees and root .gitignore/.gitattributes; lockfiles only with
include-lockfile). The checkout must start clean. Writes run-result.json,
run-log.jsonl and, when files changed, changes.json to --out (outside the
repository) for agent-ci publish --path-policy tools-update[-lockfile].`;

export function createToolsUpdateCommand(
  deps: ToolsUpdateDeps = {},
): CommandSpec {
  return {
    name: 'tools-update',
    summary: 'Run the deterministic OAT tools update and write its change set',
    usage: USAGE,
    async run(argv, context) {
      const flags = parseFlags(
        argv,
        {
          cwd: { type: 'string' },
          out: { type: 'string' },
          'target-repo': { type: 'string' },
          'oat-cli-version': { type: 'string' },
          'dependency-policy': { type: 'string' },
          'timeout-minutes': { type: 'string' },
        },
        USAGE,
      );
      const cwd = path.resolve(context.cwd, optional(flags.cwd) ?? '.');
      const summary = await runToolsUpdate(
        {
          cwd,
          outDir: path.resolve(context.cwd, required(flags.out, '--out')),
          targetRepo: optional(flags['target-repo']) ?? path.basename(cwd),
          oatCliVersion: optional(flags['oat-cli-version']) ?? 'latest',
          dependencyPolicy:
            oneOf(
              optional(flags['dependency-policy']),
              '--dependency-policy',
              DEPENDENCY_POLICIES,
              'skills-only',
            ) ?? 'skills-only',
          timeoutMs:
            positiveInt(
              optional(flags['timeout-minutes']),
              '--timeout-minutes',
              20,
            ) * 60_000,
          env: context.env,
        },
        deps,
      );
      if (!summary.ok) throw CliError.fromFailure(summary);
      const { result, error, ...rest } = summary.value;
      context.log(
        `agent-ci tools-update: ${result.status}; result at ${rest.resultPath}`,
      );
      if (error !== undefined) {
        throw new CliError(error.code, error.message, {
          hint: `The failed run-result.json and run log are at ${rest.resultPath} and ${rest.logPath}.`,
        });
      }
      return {
        ok: result.ok,
        status: result.status,
        summary: result.summary,
        changedFiles: result.changedFiles,
        ...rest,
      };
    },
  };
}

export const toolsUpdateCommand = createToolsUpdateCommand();
