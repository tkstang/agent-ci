#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { COMMANDS } from '@agent-ci/commands/registry.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { CliError, isCliError } from '@agent-ci/errors.js';

/**
 * Agent-first CLI contract:
 *  - exactly ONE JSON envelope on stdout (machine surface),
 *  - all diagnostics on stderr,
 *  - `E_*` codes + numeric exit codes (1 = user, 2 = system),
 *  - no interactivity; flags only,
 *  - NO_COLOR-safe (we emit no color at all).
 *
 * Usage: agent-ci <command> [flags] [--json]   (agent-ci --help lists commands)
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

export type Envelope = OkEnvelope | ErrEnvelope;

function usage(commands: readonly CommandSpec[]): string {
  const width = Math.max(4, ...commands.map((spec) => spec.name.length));
  const lines = commands.map(
    (spec) => `  ${spec.name.padEnd(width)}  ${spec.summary}`,
  );
  return [
    'agent-ci — run a model through Claude Code, Codex, OpenCode or Cursor.',
    '',
    'Usage: agent-ci <command> [flags]',
    '',
    'Commands:',
    ...lines,
    '',
    'Run `agent-ci <command> --help` for command flags.',
    'Emits one JSON envelope on stdout; logs go to stderr.',
  ].join('\n');
}

function defaultContext(): CommandContext {
  return {
    env: process.env,
    cwd: process.cwd(),
    log: (message) => process.stderr.write(`${message}\n`),
  };
}

function errEnvelope(command: string, err: CliError): ErrEnvelope {
  return {
    ok: false,
    command,
    code: err.code,
    message: err.message,
    ...(err.hint === undefined ? {} : { hint: err.hint }),
  };
}

/** Core, testable run: returns an envelope + exit code, never touches stdout. */
export async function run(
  argv: readonly string[],
  context: CommandContext = defaultContext(),
  commands: readonly CommandSpec[] = COMMANDS,
): Promise<{ envelope: Envelope; exitCode: number }> {
  // `--json` is the house agent-first flag; output is always one JSON
  // envelope, so it is accepted anywhere and ignored.
  const [name, ...rest] = argv.filter((arg) => arg !== '--json');
  const command = name ?? 'help';
  try {
    if (name === undefined || name === '-h' || name === '--help') {
      context.log(usage(commands));
      return {
        envelope: {
          ok: true,
          command: 'help',
          data: { commands: commands.map((spec) => spec.name) },
        },
        exitCode: 0,
      };
    }
    const spec = commands.find((candidate) => candidate.name === name);
    if (spec === undefined) {
      throw new CliError('E_INVALID_INPUT', `unknown command: ${name}`, {
        hint: 'Run agent-ci --help to list commands.',
      });
    }
    const wantsHelp = rest.includes('--help') || rest.includes('-h');
    const bareHelp = rest[0] === '--help' || rest[0] === '-h';
    if (wantsHelp && (spec.ownsHelp !== true || bareHelp)) {
      context.log(spec.usage);
      return {
        envelope: { ok: true, command, data: { help: true } },
        exitCode: 0,
      };
    }
    const data = await spec.run(rest, context);
    return { envelope: { ok: true, command, data }, exitCode: 0 };
  } catch (err) {
    if (isCliError(err)) {
      return { envelope: errEnvelope(command, err), exitCode: err.exitCode };
    }
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
