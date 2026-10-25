import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  compactUsage,
  interpretResultEnvelope,
  num,
} from '@agent-ci/harness/adapters/result-envelope.js';
import { buildChildEnv, UnsafeWorkspaceError } from '@agent-ci/harness/env.js';
import type { HarnessAdapter, RunMode } from '@agent-ci/harness/types.js';
import { findWorkspaceRoot } from '@agent-ci/run/workspace.js';

/**
 * Project files whose hooks the Cursor agent runs on its own. The agent's
 * hook loader reads enterprise, team, user and project `hooks.json` plus
 * Claude-format user and project settings, and nothing turns project
 * loading off (agent 2026.10.22-27dcf5f; live probe 2026-10-25: a project
 * `beforeReadFile` hook ran during a read-only `--mode ask` run, research
 * `read-only-execution-probe-2026-10-25.md`).
 */
export const CURSOR_PROJECT_HOOK_FILES = [
  '.cursor/hooks.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
] as const;

/** Why `file` would make Cursor execute repository hooks, or undefined. */
async function hookRisk(
  dir: string,
  file: string,
): Promise<string | undefined> {
  const full = path.join(dir, file);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `${full} cannot be inspected`;
  }
  if (file === '.cursor/hooks.json') return `${full} defines Cursor hooks`;
  if (!info.isFile()) return `${full} is not a regular file`;
  try {
    const parsed = JSON.parse(await readFile(full, 'utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      !Object.hasOwn(parsed, 'hooks')
    ) {
      return undefined;
    }
    return `${full} declares hooks`;
  } catch {
    return `${full} is not valid JSON (it may declare hooks)`;
  }
}

/**
 * Refuse a workspace (its directory and its repository root) that carries
 * hooks Cursor would execute, before the agent starts.
 */
export async function assertNoCursorProjectHooks(cwd: string): Promise<void> {
  const dirs = new Set([path.resolve(cwd)]);
  const root = await findWorkspaceRoot(cwd);
  if (root.ok) dirs.add(root.value.root);
  for (const dir of dirs) {
    for (const file of CURSOR_PROJECT_HOOK_FILES) {
      const risk = await hookRisk(dir, file);
      if (risk !== undefined) {
        throw new UnsafeWorkspaceError(
          `refusing to run Cursor: ${risk}, and the Cursor agent runs project hooks even in read-only runs`,
        );
      }
    }
  }
}

/**
 * Cursor: `agent -p --trust --output-format json --model M <mode> <prompt>`.
 * read-only: `--mode ask` (Q&A, no edits) and no `--force`; edit: `--force`.
 * The API key travels only as `CURSOR_API_KEY` in the environment, never as
 * `--api-key`, which would put it in argv.
 */
export function cursorArgs(
  providerModel: string,
  mode: RunMode,
  prompt: string,
): string[] {
  return [
    '-p',
    '--trust',
    '--output-format',
    'json',
    '--model',
    providerModel,
    ...(mode === 'read-only' ? ['--mode', 'ask'] : ['--force']),
    prompt,
  ];
}

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',
  defaultCommand: 'agent',
  versionArgs: ['--version'],
  async prepare(request) {
    await assertNoCursorProjectHooks(request.cwd);
    return {
      command: 'agent',
      args: cursorArgs(
        request.route.providerModel,
        request.mode,
        request.prompt,
      ),
      env: buildChildEnv({
        parentEnv: request.parentEnv,
        route: request.route,
        homeEnv: request.home.env,
        settings: { NO_OPEN_BROWSER: '1' },
      }),
    };
  },
  async interpret(output) {
    return interpretResultEnvelope(output, {
      harness: 'cursor',
      usage: (envelope) => {
        const usage = envelope.usage as Record<string, unknown> | undefined;
        return compactUsage({
          inputTokens: num(usage?.inputTokens),
          outputTokens: num(usage?.outputTokens),
          cacheReadTokens: num(usage?.cacheReadTokens),
          cacheWriteTokens: num(usage?.cacheWriteTokens),
        });
      },
    });
  },
};
