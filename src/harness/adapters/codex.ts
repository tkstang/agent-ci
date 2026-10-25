import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  compactUsage,
  num,
} from '@agent-ci/harness/adapters/result-envelope.js';
import { classifyFailure, truncate } from '@agent-ci/harness/classify.js';
import { buildChildEnv } from '@agent-ci/harness/env.js';
import { writeOwnedFile } from '@agent-ci/harness/home.js';
import type {
  HarnessAdapter,
  HarnessOutcome,
  HarnessRequest,
} from '@agent-ci/harness/types.js';
import type { Route } from '@agent-ci/routing/schema.js';

/** Provider id agent-ci writes into the isolated CODEX_HOME. */
export const CODEX_PROVIDER_ID = 'agent_ci';
const LAST_MESSAGE_FILE = 'codex-last-message.txt';
const SCHEMA_FILE = 'codex-output-schema.json';

/**
 * The isolated `CODEX_HOME/config.toml`. A route with `baseUrl` gets a
 * Responses-API provider whose key comes from the route's first credential
 * (`env_key`), as the 2026-10-25 probe verified against the local proxy.
 * Without `baseUrl` the file is empty and Codex uses its built-in provider
 * with the route's credential.
 */
export function codexConfigToml(route: Route): string {
  if (route.baseUrl === undefined) return '';
  const envKey = route.credentials[0];
  return [
    `model_provider = ${JSON.stringify(CODEX_PROVIDER_ID)}`,
    '',
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "agent-ci route"',
    `base_url = ${JSON.stringify(route.baseUrl)}`,
    'wire_api = "responses"',
    ...(envKey === undefined ? [] : [`env_key = ${JSON.stringify(envKey)}`]),
    'supports_websockets = false',
    '',
  ].join('\n');
}

/**
 * Codex: `codex exec -m M --json -o <file> -s <sandbox> ... -- <prompt>`.
 * read-only: `-s read-only`; edit: `-s workspace-write`.
 */
export function codexArgs(
  request: HarnessRequest,
  files: { lastMessage: string; schema?: string },
): string[] {
  const args = [
    'exec',
    '-m',
    request.route.providerModel,
    '--json',
    '-o',
    files.lastMessage,
    '-s',
    request.mode === 'read-only' ? 'read-only' : 'workspace-write',
    '--skip-git-repo-check',
    '--color',
    'never',
  ];
  if (request.route.effort !== undefined) {
    args.push(
      '-c',
      `model_reasoning_effort=${JSON.stringify(request.route.effort)}`,
    );
  }
  if (files.schema !== undefined) args.push('--output-schema', files.schema);
  args.push('--', request.prompt);
  return args;
}

interface CodexEvent {
  readonly type?: string;
  readonly thread_id?: string;
  readonly message?: string;
  readonly error?: { readonly message?: string };
  readonly usage?: Record<string, unknown>;
  readonly item?: { readonly type?: string; readonly text?: string };
}

function events(stdout: string): CodexEvent[] {
  const parsed: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      parsed.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // ignore non-JSON lines
    }
  }
  return parsed;
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  defaultCommand: 'codex',
  versionArgs: ['--version'],
  async prepare(request) {
    const codexHome = request.home.env.CODEX_HOME;
    if (codexHome === undefined) throw new Error('home root lacks CODEX_HOME');
    // Never follow a link at an agent-ci-owned path.
    await writeOwnedFile(
      path.join(codexHome, 'config.toml'),
      codexConfigToml(request.route),
    );
    const lastMessage = path.join(request.scratchDir, LAST_MESSAGE_FILE);
    await rm(lastMessage, { force: true });
    let schema: string | undefined;
    if (
      request.jsonSchema !== undefined &&
      request.route.structuredOutput === 'output-schema'
    ) {
      schema = path.join(request.scratchDir, SCHEMA_FILE);
      await writeFile(schema, JSON.stringify(request.jsonSchema));
    }
    return {
      command: 'codex',
      args: codexArgs(
        request,
        schema === undefined ? { lastMessage } : { lastMessage, schema },
      ),
      env: buildChildEnv({
        parentEnv: request.parentEnv,
        route: request.route,
        homeEnv: request.home.env,
      }),
    };
  },
  async interpret(output, request): Promise<HarnessOutcome> {
    const parsed = events(output.stdout);
    const thread = parsed.find((event) => event.type === 'thread.started');
    const session =
      thread?.thread_id === undefined ? {} : { sessionId: thread.thread_id };
    const completed = parsed.findLast(
      (event) => event.type === 'turn.completed',
    );
    const usage =
      completed?.usage === undefined
        ? null
        : compactUsage({
            inputTokens: num(completed.usage.input_tokens),
            outputTokens: num(completed.usage.output_tokens),
            cacheReadTokens: num(completed.usage.cached_input_tokens),
            cacheWriteTokens: num(completed.usage.cache_write_input_tokens),
          });
    const failedTurn = parsed.findLast((event) => event.type === 'turn.failed');
    if (
      output.exitCode !== 0 ||
      failedTurn !== undefined ||
      completed === undefined
    ) {
      const lastError =
        failedTurn?.error?.message ??
        parsed.findLast((event) => event.type === 'error')?.message ??
        '';
      const stderr = output.stderr
        .split('\n')
        .filter(
          (line) => !line.startsWith('Reading additional input from stdin'),
        )
        .join('\n');
      const diagnostic = [lastError, stderr]
        .filter((part) => part.trim() !== '')
        .join('\n');
      const { code, retryable } = classifyFailure(diagnostic);
      return {
        ok: false,
        code,
        retryable,
        usage,
        ...session,
        message: truncate(
          diagnostic === ''
            ? `codex exited with ${output.exitCode}`
            : diagnostic,
        ),
      };
    }
    let finalText: string | undefined;
    try {
      finalText = await readFile(
        path.join(request.scratchDir, LAST_MESSAGE_FILE),
        'utf8',
      );
    } catch {
      finalText = parsed.findLast(
        (event) => event.item?.type === 'agent_message',
      )?.item?.text;
    }
    if (finalText === undefined) {
      return {
        ok: false,
        code: 'E_HARNESS_FAILED',
        retryable: false,
        usage,
        ...session,
        message: 'codex produced no final message',
      };
    }
    let structured: unknown;
    if (
      request.jsonSchema !== undefined &&
      request.route.structuredOutput === 'output-schema'
    ) {
      try {
        structured = JSON.parse(finalText);
      } catch {
        structured = undefined;
      }
    }
    return {
      ok: true,
      finalText,
      usage,
      ...session,
      ...(structured === undefined ? {} : { structured }),
    };
  },
};
