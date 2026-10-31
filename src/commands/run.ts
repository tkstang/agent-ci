import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  nonNegativeInt,
  oneOf,
  optional,
  parseFlags,
  poolOptIn,
  positiveInt,
} from '@agent-ci/commands/flags.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { OUTPUT_CONTRACTS } from '@agent-ci/contracts/run-result.js';
import { CliError } from '@agent-ci/errors.js';
import { RUN_MODES } from '@agent-ci/harness/types.js';
import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { HARNESS_IDS } from '@agent-ci/routing/schema.js';
import { type RunDeps, runAgent } from '@agent-ci/run/execute.js';

const USAGE = `agent-ci run — run one prompt through the routed harness.

Writes <out>/run-result.json (validated RunResult), <out>/run-log.jsonl and
<out>/prompt.md. The harness runs in an isolated home root with stdin closed
and only the route's named credential in its environment.

Model selection:
  --model <key>              Qualified model from models.yaml.
  --harness <id>             Pin a harness: claude | codex | opencode | cursor | fake.
  --route <id>               Pick an exact route (the only way to use a paid
                             route or skip the fallback rules).
  --allow-pool               Allow a proxy-pool route (in CI only on a
                             self-hosted runner).
  --allow-pool-value <true|false>
                             The same as a value (workflow inputs).
  --seed-login               Seed your existing harness login into the
                             isolated home for login routes (local only).
  --models <path>            Routing table (default: packaged models.yaml).

Prompt and contract:
  --prompt <text> | --prompt-file <path>   The configured prompt (one required).
  --contract <name>          report | changes | issues | verdict (default report).
  --verdict-items <json>     Trusted items for the verdict contract.
  --use-case <name>          Run identity (default generic-prompt).
  --target-repo <owner/repo> Run identity (default: the cwd directory name).
  --target-path <path>       Target path; repeatable (default .).

Execution:
  --cwd <dir>                Workspace (default: current directory).
  --out <dir>                Output directory (default <cwd>/.agent-ci).
  --mode <mode>              read-only | edit (default read-only).
  --skills-dir <dir>         Seed these skills into the isolated home.
  --home-root <dir>          Keep the home root here (default: a temp root,
                             removed after the run).
  --timeout-minutes <n>      Deadline for a seeded login transfer and all
                             attempts (default 30).
  --max-attempts <n>         Attempts for transient failures (default 2).
  --retry-delay-seconds <n>  Delay between attempts (default 30).
  --credential-from-env      Take the route's single credential from
                             AGENT_CI_CREDENTIAL (workflows map exactly one
                             secret there); empty means none.

Edit runs that may retry run each attempt in a fresh copy of the repository
and promote only the successful attempt's changes. An edit run that changed
files also writes <out>/changes.json for agent-ci publish.`;

const FLAGS = {
  model: { type: 'string' },
  harness: { type: 'string' },
  route: { type: 'string' },
  'allow-pool': { type: 'boolean' },
  'allow-pool-value': { type: 'string' },
  'seed-login': { type: 'boolean' },
  models: { type: 'string' },
  prompt: { type: 'string' },
  'prompt-file': { type: 'string' },
  contract: { type: 'string' },
  'verdict-items': { type: 'string' },
  'use-case': { type: 'string' },
  'target-repo': { type: 'string' },
  'target-path': { type: 'string', multiple: true },
  cwd: { type: 'string' },
  out: { type: 'string' },
  mode: { type: 'string' },
  'skills-dir': { type: 'string' },
  'home-root': { type: 'string' },
  'timeout-minutes': { type: 'string' },
  'max-attempts': { type: 'string' },
  'retry-delay-seconds': { type: 'string' },
  'credential-from-env': { type: 'boolean' },
} as const;

async function promptFrom(
  flags: { prompt?: string | undefined; 'prompt-file'?: string | undefined },
  context: CommandContext,
): Promise<string> {
  if ((flags.prompt === undefined) === (flags['prompt-file'] === undefined)) {
    throw new CliError(
      'E_INVALID_INPUT',
      'pass exactly one of --prompt or --prompt-file',
    );
  }
  if (flags.prompt !== undefined) return flags.prompt;
  const file = path.resolve(context.cwd, flags['prompt-file'] ?? '');
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new CliError('E_INVALID_INPUT', `could not read prompt file ${file}`);
  }
}

export function createRunCommand(deps: RunDeps = {}): CommandSpec {
  return {
    name: 'run',
    summary:
      'Run a prompt through the routed harness and write run-result.json',
    usage: USAGE,
    async run(argv, context) {
      const parsed = parseFlags(argv, FLAGS, USAGE);
      // Empty values (unset workflow inputs) behave like absent flags.
      const flags = {
        ...parsed,
        model: optional(parsed.model),
        harness: optional(parsed.harness),
        route: optional(parsed.route),
      };
      if (flags.model === undefined && flags.route === undefined) {
        throw new CliError('E_INVALID_INPUT', 'pass --model or --route', {
          hint: 'Run agent-ci models to list qualified models.',
        });
      }
      const cwd = path.resolve(context.cwd, flags.cwd ?? '.');
      const prompt = await promptFrom(flags, context);
      const resolvePath = (value: string | undefined) =>
        value === undefined ? undefined : path.resolve(context.cwd, value);
      const summary = await runAgent(
        {
          model: flags.model,
          harness: oneOf(flags.harness, '--harness', HARNESS_IDS),
          routeId: flags.route,
          prompt,
          cwd,
          // Raw: resolved once, physically, against the workspace by runAgent.
          outDir: flags.out ?? '.agent-ci',
          outputContract:
            oneOf(flags.contract, '--contract', OUTPUT_CONTRACTS, 'report') ??
            'report',
          verdictItems: flags['verdict-items'],
          useCase: flags['use-case'] ?? 'generic-prompt',
          targetRepo: flags['target-repo'] ?? path.basename(cwd),
          ...(flags['target-path'] === undefined
            ? {}
            : { targetPaths: flags['target-path'] }),
          mode:
            oneOf(flags.mode, '--mode', RUN_MODES, 'read-only') ?? 'read-only',
          allowPool: poolOptIn(flags),
          seedLogin: flags['seed-login'] === true,
          skillsDir: resolvePath(flags['skills-dir']),
          homeRoot: resolvePath(flags['home-root']),
          timeoutMs:
            positiveInt(flags['timeout-minutes'], '--timeout-minutes', 30) *
            60_000,
          maxAttempts: positiveInt(flags['max-attempts'], '--max-attempts', 2),
          retryDelayMs:
            nonNegativeInt(
              flags['retry-delay-seconds'],
              '--retry-delay-seconds',
              30,
            ) * 1_000,
          modelsPath: resolvePath(flags.models) ?? DEFAULT_MODELS_PATH,
          env: context.env,
          credentialFromEnv: flags['credential-from-env'] === true,
        },
        deps,
      );
      if (!summary.ok) throw CliError.fromFailure(summary);
      const { result, error, ...rest } = summary.value;
      context.log(
        `agent-ci run: ${result.status} (${rest.route.id}); result at ${rest.resultPath}`,
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
        outputContract: result.outputContract,
        ...rest,
      };
    },
  };
}

export const runCommand = createRunCommand();
