import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '@agent-ci/config.js';
import { CliError, isCliError } from '@agent-ci/errors.js';
import { isSuccess } from '@agent-ci/result.js';

/**
 * Agent-first CLI contract:
 *  - exactly ONE JSON envelope on stdout (machine surface),
 *  - all diagnostics on stderr,
 *  - `E_*` codes + numeric exit codes (1 = user, 2 = system),
 *  - no interactivity; flags only,
 *  - NO_COLOR-safe (we emit no color at all).
 *
 * Usage:
 *   single --config '{"name":"my-app"}'
 *   single --config-file ./config.json
 *   echo '{"name":"my-app"}' | single --stdin
 */

interface OkEnvelope {
  readonly ok: true;
  readonly command: string;
  readonly data: unknown;
}

interface ErrEnvelope {
  readonly ok: false;
  readonly command: string;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

type Envelope = OkEnvelope | ErrEnvelope;

interface Flags {
  readonly help: boolean;
  readonly config: string | undefined;
  readonly configFile: string | undefined;
  readonly stdin: boolean;
}

const USAGE = `single — parse and validate a config envelope.

Options:
  --config <json>        Inline JSON config string.
  --config-file <path>   Read JSON config from a file.
  --stdin                Read JSON config from stdin.
  -h, --help             Show this help.

Emits one JSON envelope on stdout; logs to stderr.`;

/** A logger that ALWAYS writes to stderr — stdout is reserved for the envelope. */
function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseFlags(argv: readonly string[]): Flags {
  let help = false;
  let config: string | undefined;
  let configFile: string | undefined;
  let stdin = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--config': {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new CliError('E_INVALID_INPUT', '--config requires a value');
        }
        config = next;
        i += 1;
        break;
      }
      case '--config-file': {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new CliError(
            'E_INVALID_INPUT',
            '--config-file requires a value',
          );
        }
        configFile = next;
        i += 1;
        break;
      }
      case '--stdin':
        stdin = true;
        break;
      default:
        throw new CliError('E_INVALID_INPUT', `unknown argument: ${arg}`, {
          hint: 'Run with --help to see supported flags.',
        });
    }
  }

  return { help, config, configFile, stdin };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveInput(flags: Flags): Promise<string> {
  if (flags.config !== undefined) {
    return flags.config;
  }
  if (flags.configFile !== undefined) {
    try {
      return await readFile(flags.configFile, 'utf8');
    } catch {
      throw new CliError(
        'E_INVALID_INPUT',
        `could not read file: ${flags.configFile}`,
        {
          hint: 'Check the path exists and is readable.',
        },
      );
    }
  }
  if (flags.stdin) {
    return readStdin();
  }
  throw new CliError('E_INVALID_INPUT', 'no input provided', {
    hint: 'Pass one of --config, --config-file, or --stdin.',
  });
}

/** Core, testable run: returns an envelope + exit code, never touches process. */
export async function run(
  argv: readonly string[],
): Promise<{ envelope: Envelope; exitCode: number }> {
  const command = 'parse-config';
  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      logStderr(USAGE);
      return {
        envelope: { ok: true, command, data: { help: true } },
        exitCode: 0,
      };
    }

    const input = await resolveInput(flags);
    const result = parseConfig(input);

    if (isSuccess(result)) {
      return {
        envelope: { ok: true, command, data: result.value },
        exitCode: 0,
      };
    }

    const errEnvelope: ErrEnvelope = {
      ok: false,
      command,
      code: result.code,
      message: result.message,
      ...(result.hint === undefined ? {} : { hint: result.hint }),
    };
    return { envelope: errEnvelope, exitCode: 1 };
  } catch (err) {
    if (isCliError(err)) {
      const errEnvelope: ErrEnvelope = {
        ok: false,
        command,
        code: err.code,
        message: err.message,
        ...(err.hint === undefined ? {} : { hint: err.hint }),
      };
      return { envelope: errEnvelope, exitCode: err.exitCode };
    }
    // Unexpected: map to a system-level envelope (exit 2).
    const message = err instanceof Error ? err.message : String(err);
    return {
      envelope: { ok: false, command, code: 'E_UNEXPECTED', message },
      exitCode: 2,
    };
  }
}

/** The boundary: emit exactly one envelope on stdout and set the exit code. */
async function main(): Promise<void> {
  const { envelope, exitCode } = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode;
}

/**
 * realpath-based entrypoint guard: run `main()` only when this file is the
 * process entry, not when imported (e.g. by tests). Normalizes symlinks so a
 * `pnpm`/`npm` bin shim still matches.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void main();
}
