#!/usr/bin/env node
/**
 * The `run_check` tool bridge for verify-review: a minimal MCP server over
 * stdio (newline-delimited JSON-RPC 2.0) that the reviewer harness starts.
 *
 * It executes nothing. The repository checks already ran on the pull
 * request head in a controlled environment that never held a model
 * credential (the credential-free `verify` job in Actions, or before the
 * harness started locally), and `agent-ci review pass` wrote their results,
 * validated and normalized, to the file named by `--checks`. A `run_check`
 * call returns one recorded result: its evidence id, exit code, whether it
 * timed out or its output was cut, and the tail of its output. Unknown
 * check names are refused; the model cannot run anything else through it.
 * Each served result is appended to the `--calls` log when one is given.
 *
 * Self-contained on purpose (node: imports only, erasable TypeScript) so Node
 * can run the source file directly in tests and `dist/` in production.
 *
 * Usage: checks-mcp --checks <served.json> [--calls <calls.jsonl>]
 */
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

export const CHECKS_MCP_SERVER = 'agent-ci-checks';
export const RUN_CHECK_TOOL = 'run_check';
const SERVER_VERSION = '1';
const FALLBACK_PROTOCOL = '2025-06-18';
/** A request line larger than this is refused (JSON-RPC parse error). */
const MAX_LINE_BYTES = 1024 * 1024;

/** One recorded check as `agent-ci review pass` serves it. */
export interface ServedCheck {
  readonly name: string;
  readonly description: string;
  readonly evidence_id: string;
  readonly command: string;
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  readonly truncated: boolean;
  readonly isolation: string;
  readonly output_tail: string;
}

export interface ServedChecks {
  readonly version: 1;
  readonly head_sha: string;
  readonly checks: readonly ServedCheck[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface RpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The tool list: one tool whose `name` argument is the check allowlist. */
export function toolDefinitions(served: ServedChecks): Json[] {
  const names = served.checks.map((check) => check.name);
  const listing = served.checks
    .map(
      (check) =>
        `${check.name}${check.description === '' ? '' : ` (${check.description})`}`,
    )
    .join('; ');
  return [
    {
      name: RUN_CHECK_TOOL,
      description: `Return the recorded result of one named repository check on this pull request head. agent-ci ran every configured check before this session, in an isolated copy of the checkout with no credentials; nothing runs when you call this. The result carries an evidence_id: cite it in a finding as {"kind": "check", "evidence_id": "<id>"}. Checks: ${listing === '' ? 'none' : listing}.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: names,
            description: 'The check name.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ];
}

/** The text and structured result of one `run_check` call. */
export function callRunCheck(
  served: ServedChecks,
  args: unknown,
): { isError: boolean; text: string; structured?: Record<string, Json> } {
  const name = isRecord(args) ? args.name : undefined;
  const extra = isRecord(args)
    ? Object.keys(args).filter((key) => key !== 'name')
    : [];
  const check =
    typeof name === 'string' && extra.length === 0
      ? served.checks.find((entry) => entry.name === name)
      : undefined;
  if (check === undefined) {
    const names = served.checks.map((entry) => entry.name).join(', ');
    return {
      isError: true,
      text: `run_check refused: name must be one of the configured checks (${names === '' ? 'none' : names}) and no other argument is accepted.`,
    };
  }
  const summary: Record<string, Json> = {
    evidence_id: check.evidence_id,
    name: check.name,
    command: check.command,
    exit_code: check.exit_code,
    timed_out: check.timed_out,
    output_truncated: check.truncated,
    isolation: check.isolation,
    head_sha: served.head_sha,
  };
  return {
    isError: false,
    text: `${JSON.stringify(summary)}\n--- output (tail) ---\n${check.output_tail}`,
    structured: summary,
  };
}

/**
 * Handle one JSON-RPC message. Returns the response to write, or undefined
 * for a notification. `onServed` sees every successful `run_check`.
 */
export function handleMessage(
  served: ServedChecks,
  message: RpcMessage,
  onServed: (check: { name: string; evidence_id: string }) => void = () =>
    undefined,
): Json | undefined {
  const hasId =
    Object.hasOwn(message, 'id') &&
    (typeof message.id === 'string' ||
      typeof message.id === 'number' ||
      message.id === null);
  const id = (hasId ? message.id : null) as Json;
  const reply = (result: Json): Json => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string): Json => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: text },
  });
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return hasId ? fail(-32600, 'invalid request') : undefined;
  }
  // Notifications (no id) never get a response.
  if (!hasId) return undefined;
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return reply({
        protocolVersion:
          typeof requested === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/u.test(requested)
            ? requested
            : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CHECKS_MCP_SERVER, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolDefinitions(served) });
    case 'tools/call': {
      if (params.name !== RUN_CHECK_TOOL) {
        return fail(-32602, `unknown tool: only ${RUN_CHECK_TOOL} exists`);
      }
      const result = callRunCheck(served, params.arguments);
      if (!result.isError && result.structured !== undefined) {
        onServed({
          name: String(result.structured.name),
          evidence_id: String(result.structured.evidence_id),
        });
      }
      return reply({
        content: [{ type: 'text', text: result.text }],
        ...(result.structured === undefined
          ? {}
          : { structuredContent: result.structured }),
        isError: result.isError,
      });
    }
    default:
      return fail(-32601, `method not found: ${message.method}`);
  }
}

/** Parse the served-checks file (written by agent-ci, still checked). */
export function parseServedChecks(text: string): ServedChecks {
  const value = JSON.parse(text) as unknown;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.head_sha !== 'string' ||
    !Array.isArray(value.checks)
  ) {
    throw new Error('invalid served checks file');
  }
  const checks = value.checks.map((entry): ServedCheck => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.description !== 'string' ||
      typeof entry.evidence_id !== 'string' ||
      typeof entry.command !== 'string' ||
      !(entry.exit_code === null || Number.isSafeInteger(entry.exit_code)) ||
      typeof entry.timed_out !== 'boolean' ||
      typeof entry.truncated !== 'boolean' ||
      typeof entry.isolation !== 'string' ||
      typeof entry.output_tail !== 'string'
    ) {
      throw new Error('invalid served check');
    }
    return entry as unknown as ServedCheck;
  });
  return { version: 1, head_sha: value.head_sha, checks };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  const checksPath = argValue('--checks');
  if (checksPath === undefined) {
    process.stderr.write('checks-mcp: --checks <file> is required\n');
    process.exit(2);
  }
  const served = parseServedChecks(readFileSync(checksPath, 'utf8'));
  const callsPath = argValue('--calls');
  const onServed = (check: { name: string; evidence_id: string }): void => {
    if (callsPath === undefined) return;
    try {
      appendFileSync(callsPath, `${JSON.stringify(check)}\n`, { mode: 0o600 });
    } catch {
      // The log is diagnostic; a failed append never breaks the session.
    }
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let response: Json | undefined;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      response = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'request too large' },
      };
    } else {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        message = undefined;
      }
      response = isRecord(message)
        ? handleMessage(served, message, onServed)
        : {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'parse error' },
          };
    }
    if (response !== undefined) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  lines.on('close', () => process.exit(0));
}

// Run only as a program, never when imported (tests import the handlers).
const invoked = process.argv[1] ?? '';
if (/checks-mcp\.(?:ts|js)$/u.test(invoked)) main();
