import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import {
  oneOf,
  optional,
  parseFlags,
  poolOptIn,
  positiveInt,
} from '@agent-ci/commands/flags.js';
import { appendGithubOutput } from '@agent-ci/commands/github.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { loadModelsFile } from '@agent-ci/routing/resolve.js';
import { isWithin, resolvePhysical } from '@agent-ci/run/workspace.js';
import { resolveTarget } from '@agent-ci/targets/resolve.js';
import {
  MAX_TARGETS,
  parseTargetsFile,
  type TargetsFile,
} from '@agent-ci/targets/schema.js';
import { selectTargets } from '@agent-ci/targets/select.js';
import { PRESET_NAMES, PRESETS } from '@agent-ci/use-cases/presets.js';

const USAGE = `agent-ci targets — multi-repository fan-out targets.

  agent-ci targets validate [--file targets.yaml] [--root <dir>] [--models <path>]
                            [--allow-pool | --allow-pool-value <true|false>]
      Check targets.yaml: schema, unique ids and repositories, allowedOwners,
      and that every agent target's model resolves under the routing policy
      for each preset it takes part in.

  agent-ci targets matrix --preset <docs-update|instructions-update|tools-update>
                          [--file targets.yaml] [--root <dir>]
                          [--target all|<id>|<owner/name>] [--reset <true|false>]
                          [--base <branch>] [--model <name>]
                          [--max-targets <n>] [--allow-pool-value <true|false>]
                          [--models <path>] [--github-output]
      Emit the bounded GitHub Actions matrix ({"include": [...]}) for one
      preset: one entry per target, every field a reusable-workflow input.
      --reset (replace the static branch content whoever made its head,
      history kept) needs one selected target. --base and --model override
      every selected target. At most ${MAX_TARGETS} targets.
      --allow-pool-value true lets a pool route resolve (in CI only on a
      self-hosted runner, never a Claude model).
      --github-output writes matrix and count.

  agent-ci targets resolve [--repository <owner/name>] [--ref <ref>] [--base <branch>]
                           [--comment-pr <n>] [--event-ref <sha>] [--event-base <branch>]
                           [--event-pr <n>] [--github-output]
      Resolve one run's target once (no checkout): the repository (default
      $GITHUB_REPOSITORY), whether it is another repository, the commit
      every job checks out, the publish base and the PR to comment on.
      The calling repository is read with GITHUB_TOKEN; another repository
      only with AGENT_CI_TARGET_TOKEN (refused when missing), and its
      checkout needs AGENT_CI_TARGET_READ_TOKEN unless it is public; that
      token is refused when it is the write token, a scoped classic token or
      can write repository contents (its other permissions cannot be
      checked). Event values (--event-*) apply only to the calling repository.
      --github-output writes repository, cross, sha, base, comment_pr and
      default_branch.

--root confines --file to a directory (the caller checkout in workflows).`;

const MAX_FILE_BYTES = 256 * 1024;

async function readTargets(
  flags: { file?: string | undefined; root?: string | undefined },
  context: CommandContext,
): Promise<TargetsFile> {
  const root = path.resolve(context.cwd, optional(flags.root) ?? '.');
  const file = path.resolve(root, optional(flags.file) ?? 'targets.yaml');
  let real: string;
  let realRoot: string;
  try {
    real = (await resolvePhysical(file)).real;
    realRoot = (await resolvePhysical(root)).real;
  } catch {
    throw new CliError(
      'E_TARGETS_CONFIG',
      `cannot resolve the targets file ${file}`,
    );
  }
  if (!isWithin(realRoot, real)) {
    throw new CliError(
      'E_TARGETS_CONFIG',
      `the targets file ${file} resolves outside ${root}`,
    );
  }
  let text: string;
  try {
    const handle = await open(
      real,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        throw new CliError(
          'E_TARGETS_CONFIG',
          `the targets file must be a regular file under ${MAX_FILE_BYTES} bytes`,
        );
      }
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      'E_TARGETS_CONFIG',
      `cannot read the targets file ${file}`,
    );
  }
  const parsed = parseTargetsFile(text);
  if (!parsed.ok) throw CliError.fromFailure(parsed);
  return parsed.value;
}

async function models(value: string | undefined, context: CommandContext) {
  const loaded = await loadModelsFile(
    value === undefined
      ? DEFAULT_MODELS_PATH
      : path.resolve(context.cwd, value),
  );
  if (!loaded.ok) throw CliError.fromFailure(loaded);
  return loaded.value;
}

async function validate(argv: readonly string[], context: CommandContext) {
  const flags = parseFlags(
    argv,
    {
      file: { type: 'string' },
      root: { type: 'string' },
      models: { type: 'string' },
      'allow-pool': { type: 'boolean' },
      'allow-pool-value': { type: 'string' },
    },
    USAGE,
  );
  const allowPool = poolOptIn(flags);
  const file = await readTargets(flags, context);
  const table = await models(flags.models, context);
  const presets: Record<string, number> = {};
  for (const preset of PRESET_NAMES) {
    const takesPart = file.targets.some(
      (target) =>
        target.useCases === undefined || target.useCases.includes(preset),
    );
    if (!takesPart) {
      presets[preset] = 0;
      continue;
    }
    const selected = selectTargets(file, {
      preset,
      allowPool,
      models: table,
      env: context.env,
    });
    if (!selected.ok) throw CliError.fromFailure(selected);
    presets[preset] = selected.value.length;
  }
  return {
    valid: true,
    targets: file.targets.map((target) => ({
      id: target.id,
      repository: target.repository,
    })),
    presets,
  };
}

async function matrix(argv: readonly string[], context: CommandContext) {
  const flags = parseFlags(
    argv,
    {
      file: { type: 'string' },
      root: { type: 'string' },
      preset: { type: 'string' },
      target: { type: 'string' },
      reset: { type: 'string' },
      base: { type: 'string' },
      model: { type: 'string' },
      'allow-pool-value': { type: 'string' },
      'max-targets': { type: 'string' },
      models: { type: 'string' },
      'github-output': { type: 'boolean' },
    },
    USAGE,
  );
  const preset = oneOf(optional(flags.preset), '--preset', PRESET_NAMES);
  if (preset === undefined) {
    throw new CliError('E_INVALID_INPUT', '--preset is required');
  }
  const reset = optional(flags.reset);
  if (reset !== undefined && !['true', 'false'].includes(reset)) {
    throw new CliError('E_INVALID_INPUT', '--reset must be true or false');
  }
  const model = optional(flags.model);
  if (model !== undefined && PRESETS[preset].kind !== 'agent') {
    throw new CliError(
      'E_INVALID_INPUT',
      `--model does not apply to the deterministic ${preset} preset`,
    );
  }
  const file = await readTargets(flags, context);
  const selected = selectTargets(file, {
    preset,
    target: optional(flags.target),
    reset: reset === 'true',
    maxTargets: positiveInt(
      optional(flags['max-targets']),
      '--max-targets',
      MAX_TARGETS,
    ),
    base: optional(flags.base),
    model,
    allowPool: poolOptIn(flags),
    models: await models(flags.models, context),
    env: context.env,
  });
  if (!selected.ok) throw CliError.fromFailure(selected);
  const value = { include: selected.value };
  if (flags['github-output'] === true) {
    await appendGithubOutput(context.env, {
      matrix: JSON.stringify(value),
      count: String(selected.value.length),
    });
  }
  context.log(
    `agent-ci targets: ${selected.value.length} ${preset} target(s): ${selected.value.map((entry) => entry.id).join(', ')}`,
  );
  return { preset, count: selected.value.length, matrix: value };
}

async function resolve(
  argv: readonly string[],
  context: CommandContext,
  fetchImpl: typeof fetch | undefined,
) {
  const flags = parseFlags(
    argv,
    {
      repository: { type: 'string' },
      ref: { type: 'string' },
      base: { type: 'string' },
      'comment-pr': { type: 'string' },
      'event-ref': { type: 'string' },
      'event-base': { type: 'string' },
      'event-pr': { type: 'string' },
      'github-output': { type: 'boolean' },
    },
    USAGE,
  );
  const resolved = await resolveTarget({
    repository: flags.repository,
    callingRepository: context.env.GITHUB_REPOSITORY ?? '',
    ref: flags.ref,
    eventRef: flags['event-ref'],
    base: flags.base,
    eventBase: flags['event-base'],
    commentPr: flags['comment-pr'],
    eventPr: flags['event-pr'],
    githubToken: context.env.GITHUB_TOKEN,
    targetToken: context.env.AGENT_CI_TARGET_TOKEN,
    readToken: context.env.AGENT_CI_TARGET_READ_TOKEN,
    ...(context.env.GITHUB_API_URL
      ? { apiUrl: context.env.GITHUB_API_URL }
      : {}),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  if (!resolved.ok) throw CliError.fromFailure(resolved);
  const target = resolved.value;
  if (flags['github-output'] === true) {
    await appendGithubOutput(context.env, {
      repository: target.repository,
      cross: String(target.cross),
      sha: target.sha,
      base: target.base,
      comment_pr: target.commentPr,
      default_branch: target.defaultBranch,
    });
  }
  context.log(
    `agent-ci targets: ${target.repository}${target.cross ? ' (another repository)' : ''} at ${target.sha}, base ${target.base}`,
  );
  return target;
}

export function createTargetsCommand(
  deps: { readonly fetch?: typeof fetch } = {},
): CommandSpec {
  return {
    name: 'targets',
    summary:
      'Validate targets.yaml, emit a fan-out matrix, resolve a run target',
    usage: USAGE,
    async run(argv, context) {
      const [action, ...rest] = argv;
      switch (action) {
        case 'validate':
          return await validate(rest, context);
        case 'matrix':
          return await matrix(rest, context);
        case 'resolve':
          return await resolve(rest, context, deps.fetch);
        default:
          throw new CliError(
            'E_INVALID_INPUT',
            'use: targets validate | targets matrix | targets resolve',
            { hint: USAGE },
          );
      }
    },
  };
}

export const targetsCommand = createTargetsCommand();
