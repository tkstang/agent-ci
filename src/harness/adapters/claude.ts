import path from 'node:path';

import {
  compactUsage,
  interpretResultEnvelope,
  num,
} from '@agent-ci/harness/adapters/result-envelope.js';
import { buildChildEnv } from '@agent-ci/harness/env.js';
import { writeOwnedFile } from '@agent-ci/harness/home.js';
import type {
  HarnessAdapter,
  HarnessRequest,
  ToolBridge,
} from '@agent-ci/harness/types.js';

const MCP_CONFIG_FILE = 'claude-mcp-config.json';

/** Claude's name for an MCP tool: `mcp__<server>__<tool>`. */
export function claudeBridgeTool(bridge: ToolBridge): string {
  return `mcp__${bridge.server}__${bridge.tool}`;
}

/**
 * The `--mcp-config` file for the tool bridge: exactly one stdio server.
 * With `--strict-mcp-config` no other MCP configuration is loaded.
 */
export function claudeMcpConfig(bridge: ToolBridge): Record<string, unknown> {
  return {
    mcpServers: {
      [bridge.server]: {
        type: 'stdio',
        command: bridge.command,
        args: [...bridge.args],
      },
    },
  };
}

/**
 * Built-in tools a read-only run may use: read, search and load installed
 * skills; no edits or shell. Without `Skill`, skills installed into the home
 * root are invisible (live probe 2026-10-25, research
 * `skill-discovery-2026-10-25.md`).
 *
 * `Skill` does not reopen execution (claude 2.1.310, live probe 2026-10-25,
 * research `read-only-execution-probe-2026-10-25.md`): a skill's
 * `` !`command` `` dynamic context runs through the Bash permission check and
 * is denied in this mode (it ran only in a `bypassPermissions` control), a
 * skill declaring `allowed-tools: Bash` is denied, and project skills from
 * `<repo>/.claude/skills` are not loaded under `--setting-sources user`.
 * Re-run that probe whenever the pinned Claude Code version changes.
 */
export const CLAUDE_READ_ONLY_TOOLS = 'Read,Grep,Glob,Skill';

/**
 * Claude Code: `claude -p --output-format json --model M ... -- <prompt>`.
 *
 * - `--tools` is variadic and swallows a following prompt (probe
 *   2026-10-25), so options always end with `--`.
 * - `--setting-sources user` loads settings only from the isolated home, so
 *   a target repository's `.claude/settings.json` cannot add hooks or allow
 *   rules; `--strict-mcp-config` ignores every MCP config not passed here.
 * - read-only: `--permission-mode dontAsk` with read/search tools only;
 *   edit: `--permission-mode acceptEdits` with prompts answered by nobody.
 * - edit: `--add-dir <home>/.agents/skills` lets the agent read the skills
 *   installed for this run. Skills marked `disable-model-invocation` (the
 *   OAT docs and instructions skills) cannot be loaded through `Skill`, and
 *   without the directory every read outside the workspace is refused (live
 *   probe 2026-10-25, research `p05-live-evidence-2026-10-25.md`).
 *   `--add-dir` would also allow edits there, so `--disallowedTools` denies
 *   Edit and Write on the canonical skills directory and Claude's skills
 *   view (live-probed: the read works, the write is refused), and the run
 *   core fingerprints both trees and fails closed on any change.
 */
export function claudeSkillWriteDenials(
  home: Pick<HarnessRequest['home'], 'home' | 'skillsDir'>,
): string[] {
  const trees = [home.skillsDir, `${home.home}/.claude/skills`];
  return trees.flatMap((tree) => [`Edit(/${tree}/**)`, `Write(/${tree}/**)`]);
}
export function claudeArgs(
  request: HarnessRequest,
  files: { readonly mcpConfig?: string } = {},
): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    request.route.providerModel,
    '--setting-sources',
    'user',
    '--strict-mcp-config',
  ];
  if (request.mode === 'read-only') {
    args.push(
      '--permission-mode',
      'dontAsk',
      '--tools',
      // `""` removes every built-in tool (the adjudicator); with
      // --strict-mcp-config and user-only settings nothing else is offered.
      request.noTools === true ? '' : CLAUDE_READ_ONLY_TOOLS,
    );
    // The tool bridge: one MCP server and an allow rule for its one tool.
    // `--tools` limits built-in tools only; under `dontAsk` an MCP tool runs
    // only when an allow rule names it (live probe, research
    // `p04-tool-bridge-probes-2026-10-25.md`).
    if (request.toolBridge !== undefined && files.mcpConfig !== undefined) {
      args.push(
        '--mcp-config',
        files.mcpConfig,
        '--allowedTools',
        claudeBridgeTool(request.toolBridge),
      );
    }
  } else {
    args.push(
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--add-dir',
      request.home.skillsDir,
      // Read access only: deny every file-editing tool on the skill trees
      // (`//` marks an absolute path in Claude permission rules). The run
      // core also fingerprints the trees and fails closed on any change.
      '--disallowedTools',
      ...claudeSkillWriteDenials(request.home),
    );
  }
  if (
    request.jsonSchema !== undefined &&
    request.route.structuredOutput === 'json-schema'
  ) {
    args.push('--json-schema', JSON.stringify(request.jsonSchema));
  }
  // The same flags on every turn: a resumed turn keeps the run's posture
  // because each `claude -p` invocation applies its own flags.
  if (request.resumeSessionId !== undefined) {
    args.push('--resume', request.resumeSessionId);
  }
  args.push('--', request.prompt);
  return args;
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  defaultCommand: 'claude',
  versionArgs: ['--version'],
  supportsResume: true,
  supportsNoTools: true,
  supportsToolBridge: true,
  async prepare(request) {
    let mcpConfig: string | undefined;
    if (request.toolBridge !== undefined) {
      mcpConfig = path.join(request.scratchDir, MCP_CONFIG_FILE);
      await writeOwnedFile(
        mcpConfig,
        `${JSON.stringify(claudeMcpConfig(request.toolBridge), null, 2)}\n`,
      );
    }
    const settings: Record<string, string> = {
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    if (request.route.baseUrl !== undefined) {
      settings.ANTHROPIC_BASE_URL = request.route.baseUrl;
    }
    return {
      command: 'claude',
      args: claudeArgs(request, mcpConfig === undefined ? {} : { mcpConfig }),
      env: buildChildEnv({
        parentEnv: request.parentEnv,
        route: request.route,
        homeEnv: request.home.env,
        settings,
      }),
    };
  },
  async interpret(output) {
    return interpretResultEnvelope(output, {
      harness: 'claude',
      usage: (envelope) => {
        const usage = envelope.usage as Record<string, unknown> | undefined;
        return compactUsage({
          inputTokens: num(usage?.input_tokens),
          outputTokens: num(usage?.output_tokens),
          cacheReadTokens: num(usage?.cache_read_input_tokens),
          cacheWriteTokens: num(usage?.cache_creation_input_tokens),
          costUsd: num(envelope.total_cost_usd),
        });
      },
    });
  },
};
