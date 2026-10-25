import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { optional, parseFlags, required } from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { writeOwnedFile } from '@agent-ci/files.js';
import { DEFAULT_BRANCH_PREFIX } from '@agent-ci/publish/static-branch.js';
import {
  isPresetName,
  PATH_POLICIES,
  PRESET_NAMES,
  PRESETS,
  presetPrompt,
} from '@agent-ci/use-cases/presets.js';

const USAGE = `agent-ci preset — the use-case wrappers (docs-update, instructions-update, tools-update).

  agent-ci preset list
      Each preset's run identity, kind, contract, OAT packs and path policy.

  agent-ci preset prompt --out <file> [--preset <name>] [--prompt-env <VAR>]
                         --target-repo <owner/name> --base <branch>
                         [--branch <name>] [--use-case <id>]
      Write the run prompt: the preset's own prompt (agent presets only), or
      the custom prompt held in environment variable <VAR>. Exactly one of the
      two must be non-empty, so a workflow can pass both inputs unconditionally.
      --branch names the static branch in the prompt (default
      agent-ci/<use-case>; --use-case defaults to the preset's).`;

export const presetCommand: CommandSpec = {
  name: 'preset',
  summary: 'List use-case presets or write a run prompt',
  usage: USAGE,
  async run(argv, context) {
    const [action, ...rest] = argv;
    if (action === 'list') {
      parseFlags(rest, {}, USAGE);
      return {
        presets: PRESET_NAMES.map((name) => {
          const preset = PRESETS[name];
          return {
            name,
            useCase: preset.useCase,
            kind: preset.kind,
            outputContract: preset.outputContract,
            mode: preset.mode,
            skillsOatPacks: preset.skillsOatPacks,
            defaultBranch: `${DEFAULT_BRANCH_PREFIX}${preset.useCase}`,
          };
        }),
        pathPolicies: PATH_POLICIES,
      };
    }
    if (action !== 'prompt') {
      throw new CliError(
        'E_INVALID_INPUT',
        'use: preset list | preset prompt',
        {
          hint: USAGE,
        },
      );
    }
    const parsed = parseFlags(
      rest,
      {
        preset: { type: 'string' },
        'prompt-env': { type: 'string' },
        'target-repo': { type: 'string' },
        base: { type: 'string' },
        branch: { type: 'string' },
        'use-case': { type: 'string' },
        out: { type: 'string' },
      },
      USAGE,
    );
    const presetName = optional(parsed.preset);
    const envName = optional(parsed['prompt-env']);
    if (envName !== undefined && !/^[A-Z][A-Z0-9_]*$/u.test(envName)) {
      throw new CliError(
        'E_INVALID_INPUT',
        '--prompt-env must name an environment variable',
      );
    }
    const custom =
      envName === undefined ? undefined : optional(context.env[envName]);
    if ((presetName === undefined) === (custom === undefined)) {
      throw new CliError(
        'E_INVALID_INPUT',
        'set exactly one of a preset or a custom prompt',
        {
          hint: 'run-agent.yml takes either the preset input or the prompt input.',
        },
      );
    }
    const out = path.resolve(context.cwd, required(parsed.out, '--out'));
    let text: string;
    let source: string;
    if (presetName !== undefined) {
      if (!isPresetName(presetName)) {
        throw new CliError(
          'E_INVALID_INPUT',
          `--preset must be one of: ${PRESET_NAMES.join(', ')}`,
        );
      }
      const useCase =
        optional(parsed['use-case']) ?? PRESETS[presetName].useCase;
      const prompt = presetPrompt(presetName, {
        targetRepo: required(parsed['target-repo'], '--target-repo'),
        baseBranch: required(parsed.base, '--base'),
        staticBranch:
          optional(parsed.branch) ?? `${DEFAULT_BRANCH_PREFIX}${useCase}`,
      });
      if (!prompt.ok) throw CliError.fromFailure(prompt);
      text = prompt.value;
      source = `preset:${presetName}`;
    } else {
      text = custom ?? '';
      source = `env:${envName ?? ''}`;
    }
    await mkdir(path.dirname(out), { recursive: true });
    await writeOwnedFile(out, text, 0o644);
    context.log(`agent-ci preset: wrote the ${source} prompt to ${out}`);
    return { out, source, bytes: Buffer.byteLength(text, 'utf8') };
  },
};
