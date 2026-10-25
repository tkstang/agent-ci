import { mkdir } from 'node:fs/promises';
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
  RunMode,
} from '@agent-ci/harness/types.js';

/**
 * The job config written to the isolated `XDG_CONFIG_HOME/opencode`. A
 * non-interactive `opencode run` rejects any permission it would have to ask
 * for; these deny rules also stop edits and shell in read-only mode. Project
 * config in the target repository is disabled
 * (`OPENCODE_DISABLE_PROJECT_CONFIG`), so a repository cannot widen them.
 * Tool denials are not a network boundary.
 */
/**
 * Read-only deny rules, verified live on opencode v2.0.27 (2026-10-25,
 * research `opencode-readonly-probe-2026-10-25.md`): without them a
 * non-interactive run wrote a file and ran `touch` through its `shell` tool
 * even without `--auto`; with them neither tool was offered. v2 names the tool
 * `shell` but `bash: deny` also removed it, so both keys are denied.
 *
 * `question` and `execute` are denied too (live check 2026-10-25, research
 * `opencode-question-subagent-probe-2026-10-25.md`): `execute` is OpenCode's
 * code-mode runtime, and in a read-only run it still reached the network
 * (`fetch` returned HTTP 200) and exposed `tools.opencode.worktree_create`.
 * With these rules a read-only run offers only glob, grep, read, skill and
 * subagent, and subagents inherit the same set.
 */
export const READ_ONLY_PERMISSION = {
  edit: 'deny',
  bash: 'deny',
  shell: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  question: 'deny',
  execute: 'deny',
} as const;

/**
 * Edit runs keep the network tools denied. `question` is denied in both
 * modes: a run has no one to answer it (stdin is closed), so asking can only
 * stall until the deadline. Subagents inherit these rules (live check
 * 2026-10-25, research `opencode-question-subagent-probe-2026-10-25.md`).
 */
export const EDIT_PERMISSION = {
  webfetch: 'deny',
  websearch: 'deny',
  question: 'deny',
} as const;

export function opencodeConfig(mode: RunMode): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    permission: mode === 'read-only' ? READ_ONLY_PERMISSION : EDIT_PERMISSION,
  };
}

/**
 * OpenCode: `opencode run --standalone -m provider/model --format json
 * [--auto] <prompt>`. `--standalone` avoids the shared background service;
 * stdin must be closed or `run` hangs (probe 2026-10-24).
 */
export function opencodeArgs(
  providerModel: string,
  mode: RunMode,
  prompt: string,
): string[] {
  return [
    'run',
    '--standalone',
    '-m',
    providerModel,
    '--format',
    'json',
    ...(mode === 'edit' ? ['--auto'] : []),
    prompt,
  ];
}

interface OpencodeEvent {
  readonly type?: string;
  readonly sessionID?: string;
  readonly part?: {
    readonly text?: string;
    readonly cost?: unknown;
    readonly tokens?: {
      readonly input?: unknown;
      readonly output?: unknown;
      readonly cache?: { readonly read?: unknown; readonly write?: unknown };
    };
  };
  readonly error?: { readonly type?: string; readonly message?: string };
}

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  defaultCommand: 'opencode',
  versionArgs: ['--version'],
  async prepare(request) {
    const configHome = request.home.env.XDG_CONFIG_HOME;
    if (configHome === undefined)
      throw new Error('home root lacks XDG_CONFIG_HOME');
    const dir = path.join(configHome, 'opencode');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Never follow a link at an agent-ci-owned path.
    await writeOwnedFile(
      path.join(dir, 'opencode.json'),
      `${JSON.stringify(opencodeConfig(request.mode), null, 2)}\n`,
    );
    return {
      command: 'opencode',
      args: opencodeArgs(
        request.route.providerModel,
        request.mode,
        request.prompt,
      ),
      env: buildChildEnv({
        parentEnv: request.parentEnv,
        route: request.route,
        homeEnv: request.home.env,
        settings: {
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        },
      }),
    };
  },
  async interpret(output): Promise<HarnessOutcome> {
    const parsed: OpencodeEvent[] = [];
    for (const line of output.stdout.split('\n')) {
      if (line.trim() === '') continue;
      try {
        parsed.push(JSON.parse(line) as OpencodeEvent);
      } catch {
        // ignore non-JSON lines
      }
    }
    const sessionId = parsed.find(
      (event) => event.sessionID !== undefined,
    )?.sessionID;
    const session = sessionId === undefined ? {} : { sessionId };
    // The probe saw no usage event; count step_finish tokens when present.
    const steps = parsed.filter(
      (event) => event.type === 'step_finish' && event.part?.tokens,
    );
    const sum = (pick: (event: OpencodeEvent) => unknown) => {
      const values = steps
        .map((event) => num(pick(event)))
        .filter((v) => v !== undefined);
      return values.length === 0
        ? undefined
        : values.reduce((a, b) => a + b, 0);
    };
    const usage = compactUsage({
      inputTokens: sum((event) => event.part?.tokens?.input),
      outputTokens: sum((event) => event.part?.tokens?.output),
      cacheReadTokens: sum((event) => event.part?.tokens?.cache?.read),
      cacheWriteTokens: sum((event) => event.part?.tokens?.cache?.write),
      costUsd: sum((event) => event.part?.cost),
    });
    const error = parsed.findLast((event) => event.type === 'error');
    const text = parsed
      .filter(
        (event) =>
          event.type === 'text' && typeof event.part?.text === 'string',
      )
      .map((event) => event.part?.text ?? '')
      .join('');
    if (output.exitCode !== 0 || error !== undefined || text.trim() === '') {
      const diagnostic = [
        error?.error?.type ?? '',
        error?.error?.message ?? '',
        output.stderr,
      ]
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
            ? `opencode exited with ${output.exitCode} and no text`
            : diagnostic,
        ),
      };
    }
    return { ok: true, finalText: text, usage, ...session };
  },
};
