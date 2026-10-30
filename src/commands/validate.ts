import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { validateRunResult } from '@agent-ci/contracts/run-result.js';
import { CliError } from '@agent-ci/errors.js';

const USAGE = `agent-ci validate — validate a run-result.json against its contract.

Flags:
  --file <path>            The run-result.json to check (required).
  --contract <name>        report | changes | issues | verdict (default: the
                           file's outputContract, else inferred).
  --verdict-items <json>   Trusted verdict items for the verdict contract.`;

export const validateCommand: CommandSpec = {
  name: 'validate',
  summary: 'Validate a run-result.json against its output contract',
  usage: USAGE,
  async run(argv, context) {
    const flags = parseFlags(
      argv,
      {
        file: { type: 'string' },
        contract: { type: 'string' },
        'verdict-items': { type: 'string' },
      },
      USAGE,
    );
    const file = path.resolve(context.cwd, required(flags.file, '--file'));
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new CliError('E_INVALID_INPUT', `could not read JSON from ${file}`);
    }
    const declared =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>).outputContract
        : undefined;
    const contract =
      flags.contract ?? (typeof declared === 'string' ? declared : undefined);
    const result = validateRunResult(value, {
      outputContract: contract,
      verdictItems: flags['verdict-items'],
    });
    if (!result.ok) throw CliError.fromFailure(result);
    return {
      file,
      valid: true,
      outputContract: result.value.outputContract,
      status: result.value.status,
      ok: result.value.ok,
    };
  },
};
