import path from 'node:path';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import { appendGithubPath } from '@agent-ci/commands/github.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import {
  codexSandboxSmoke,
  type InstallDeps,
  installHarness,
  type ProcessRunner,
} from '@agent-ci/harness/install.js';
import { HARNESS_IDS, type HarnessId } from '@agent-ci/routing/schema.js';

const USAGE = `agent-ci harness — install and smoke-check harness CLIs (CI runners).

  agent-ci harness install --harness <ids> --prefix <dir> [--github-path]
      Install pinned CLIs (comma-separated: claude,codex,opencode,cursor;
      fake is built in) into <dir>/bin and check each with --version.
      --github-path adds <dir>/bin to $GITHUB_PATH for later steps.

  agent-ci harness smoke --harness codex [--command <path>] [--report-only]
      Codex sandbox smoke check on this host, without a model or credential:
      a read runs, a workspace write is denied by default, and allowed in
      workspace-write mode. Fails unless every check passes (--report-only
      reports without failing).`;

function harnessList(value: string | undefined): HarnessId[] {
  const ids = required(value, '--harness')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!(HARNESS_IDS as readonly string[]).includes(id)) {
      throw new CliError(
        'E_INVALID_INPUT',
        `--harness must list: ${HARNESS_IDS.join(', ')}`,
      );
    }
  }
  return [...new Set(ids)] as HarnessId[];
}

export function createHarnessCommand(
  deps: InstallDeps & { readonly run?: ProcessRunner } = {},
): CommandSpec {
  return {
    name: 'harness',
    summary: 'Install or smoke-check harness CLIs on a runner',
    usage: USAGE,
    async run(argv, context: CommandContext) {
      const [action, ...rest] = argv;
      if (action === 'install') {
        const flags = parseFlags(
          rest,
          {
            harness: { type: 'string' },
            prefix: { type: 'string' },
            'github-path': { type: 'boolean' },
          },
          USAGE,
        );
        const prefix = path.resolve(
          context.cwd,
          required(flags.prefix, '--prefix'),
        );
        const installed = [];
        for (const harness of harnessList(flags.harness)) {
          context.log(`agent-ci harness: installing ${harness}`);
          const result = await installHarness(harness, prefix, {
            ...deps,
            env: context.env,
          });
          if (!result.ok) throw CliError.fromFailure(result);
          context.log(`agent-ci harness: ${harness} ${result.value.reported}`);
          installed.push(result.value);
        }
        const binDir = path.join(prefix, 'bin');
        if (flags['github-path'] === true) {
          await appendGithubPath(context.env, binDir);
        }
        return { prefix, binDir, installed };
      }
      if (action === 'smoke') {
        const flags = parseFlags(
          rest,
          {
            harness: { type: 'string' },
            command: { type: 'string' },
            'report-only': { type: 'boolean' },
          },
          USAGE,
        );
        if (flags.harness !== 'codex') {
          throw new CliError(
            'E_INVALID_INPUT',
            'only --harness codex has a sandbox smoke check',
          );
        }
        const checks = await codexSandboxSmoke(flags.command ?? 'codex', {
          ...(deps.run === undefined ? {} : { run: deps.run }),
          ...(context.env.PATH === undefined ? {} : { path: context.env.PATH }),
        });
        for (const check of checks) {
          context.log(
            `agent-ci harness smoke: ${check.name} ${check.passed ? 'passed' : 'FAILED'} (exit ${check.exitCode ?? 'none'}): ${check.detail}`,
          );
        }
        const passed = checks.every((check) => check.passed);
        if (!passed && flags['report-only'] !== true) {
          throw new CliError(
            'E_HARNESS_FAILED',
            `codex sandbox smoke check failed: ${checks
              .filter((check) => !check.passed)
              .map((check) => check.name)
              .join(', ')}`,
          );
        }
        return { harness: 'codex', passed, platform: process.platform, checks };
      }
      throw new CliError(
        'E_INVALID_INPUT',
        'use: harness install | harness smoke',
        {
          hint: USAGE,
        },
      );
    },
  };
}

export const harnessCommand = createHarnessCommand();
