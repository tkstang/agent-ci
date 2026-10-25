import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { KNOWN_CREDENTIAL_ENV } from '@agent-ci/contracts/secret-guard.js';
import { claudeAdapter } from '@agent-ci/harness/adapters/claude.js';
import { codexAdapter } from '@agent-ci/harness/adapters/codex.js';
import { cursorAdapter } from '@agent-ci/harness/adapters/cursor.js';
import { opencodeAdapter } from '@agent-ci/harness/adapters/opencode.js';
import { UnsafeWorkspaceError } from '@agent-ci/harness/env.js';
import {
  alive,
  envNames,
  fixture,
  makeRequest,
  replay,
  type ReplayControl,
} from '@agent-ci/harness/testing/replay.js';
import type { HarnessAdapter, Usage } from '@agent-ci/harness/types.js';
import type { Route } from '@agent-ci/routing/schema.js';
import { describe, expect, it } from 'vitest';

const base = {
  login: false,
  billing: 'subscription',
  structuredOutput: 'prompt',
  qualified: '2026-10-25',
} as const;

interface Case {
  readonly adapter: HarnessAdapter;
  readonly route: Route;
  /** Non-secret settings the adapter adds to the child environment. */
  readonly settings: readonly string[];
  readonly success: () => Promise<ReplayControl>;
  readonly auth: () => Promise<ReplayControl>;
  readonly transient: ReplayControl;
  readonly usage: Usage | null;
}

const cases: Case[] = [
  {
    adapter: claudeAdapter,
    route: {
      ...base,
      id: 'claude-haiku-4-5-pool',
      model: 'claude-haiku-4-5',
      harness: 'claude',
      family: 'claude',
      providerModel: 'claude-haiku-4-5-20251001',
      credentials: ['ANTHROPIC_AUTH_TOKEN'],
      baseUrl: 'http://127.0.0.1:8317',
      account: 'pool',
      structuredOutput: 'json-schema',
    },
    settings: [
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_AUTOUPDATER',
    ],
    success: async () => ({ stdout: await fixture('claude-success.json') }),
    auth: async () => ({
      stdout: await fixture('claude-auth-failure.json'),
      exitCode: 1,
    }),
    transient: {
      stdout: `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'API Error: Overloaded',
        api_error_status: 529,
      })}\n`,
      exitCode: 1,
    },
    usage: {
      inputTokens: 10,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 6424,
      costUsd: 0.00834,
    },
  },
  {
    adapter: codexAdapter,
    route: {
      ...base,
      id: 'gpt-5.6-luna-pool',
      model: 'gpt-5.6-luna',
      harness: 'codex',
      family: 'openai',
      providerModel: 'gpt-5.6-luna',
      credentials: ['AGENT_CI_PROXY_API_KEY'],
      baseUrl: 'http://127.0.0.1:8317/v1',
      effort: 'low',
      account: 'pool',
      structuredOutput: 'output-schema',
    },
    settings: [],
    success: async () => ({
      stdout: await fixture('codex-success.jsonl'),
      stderr: await fixture('codex-reading-stdin.stderr.txt'),
      writeArgFile: { flag: '-o', content: 'agent-ci-probe-ok' },
    }),
    auth: async () => ({
      stdout: await fixture('codex-auth-failure.jsonl'),
      exitCode: 1,
    }),
    transient: {
      stdout: `${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({
        type: 'turn.failed',
        error: { message: 'stream disconnected before completion' },
      })}\n`,
      exitCode: 1,
    },
    usage: {
      inputTokens: 7948,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  },
  {
    adapter: opencodeAdapter,
    route: {
      ...base,
      id: 'grok-4.7-opencode',
      model: 'grok-4.7',
      harness: 'opencode',
      family: 'xai',
      providerModel: 'opencode-go/grok-4.7',
      credentials: ['OPENCODE_API_KEY'],
      account: 'personal',
    },
    settings: [
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_PROJECT_CONFIG',
    ],
    success: async () => ({ stdout: await fixture('opencode-success.jsonl') }),
    auth: async () => ({
      stdout: await fixture('opencode-no-route.jsonl'),
      exitCode: 1,
    }),
    transient: {
      stdout: `${JSON.stringify({
        type: 'error',
        error: { type: 'provider.error', message: '429 Too Many Requests' },
      })}\n`,
      exitCode: 1,
    },
    usage: null,
  },
  {
    adapter: cursorAdapter,
    route: {
      ...base,
      id: 'grok-4.7-cursor',
      model: 'grok-4.7',
      harness: 'cursor',
      family: 'xai',
      providerModel: 'grok-4.7-low',
      credentials: ['CURSOR_API_KEY'],
      account: 'work',
    },
    settings: ['NO_OPEN_BROWSER'],
    success: async () => ({ stdout: await fixture('cursor-success.json') }),
    auth: async () => ({
      stderr: await fixture('cursor-auth-failure.stderr.txt'),
      exitCode: 1,
    }),
    transient: { stderr: 'Error: rate limit exceeded (429)\n', exitCode: 1 },
    usage: {
      inputTokens: 12236,
      outputTokens: 39,
      cacheReadTokens: 5376,
      cacheWriteTokens: 0,
    },
  },
];

describe.each(cases)('$adapter.id adapter', (c) => {
  it('passes only allowlisted base variables, the route credential and the isolated home', async () => {
    const request = await makeRequest(c.route);
    const { observed } = await replay(c.adapter, request, await c.success());
    const expected = [
      'LANG',
      'PATH',
      ...c.route.credentials,
      ...Object.keys(request.home.env),
      ...c.settings,
    ].toSorted();
    expect(envNames(observed)).toEqual(expected);
    const visibleCredentials = KNOWN_CREDENTIAL_ENV.filter(
      (name) => name in observed.env,
    );
    expect(visibleCredentials).toEqual(c.route.credentials);
    expect(observed.env[c.route.credentials[0] ?? '']).toBe(
      request.parentEnv[c.route.credentials[0] ?? ''],
    );
  });

  it('points every config home at the isolated root, never the operator home', async () => {
    const request = await makeRequest(c.route);
    const { observed } = await replay(c.adapter, request, await c.success());
    for (const name of Object.keys(request.home.env)) {
      expect(observed.env[name]?.startsWith(request.home.root)).toBe(true);
    }
    expect(JSON.stringify(observed.env)).not.toContain('/Users/operator');
  });

  it('spawns with stdin closed', async () => {
    const request = await makeRequest(c.route);
    const { observed } = await replay(c.adapter, request, await c.success());
    expect(observed.stdinDevNull).toBe(true);
  });

  it('keeps credentials out of argv', async () => {
    const request = await makeRequest(c.route);
    const { observed } = await replay(c.adapter, request, await c.success());
    const secret = request.parentEnv[c.route.credentials[0] ?? ''] ?? '';
    expect(secret).not.toBe('');
    expect(observed.argv.join(' ')).not.toContain(secret);
  });

  it('extracts the final answer and usage from the recorded probe output', async () => {
    const request = await makeRequest(c.route);
    const { run } = await replay(c.adapter, request, await c.success());
    expect(run.outcome).toMatchObject({
      ok: true,
      finalText: 'agent-ci-probe-ok',
      usage: c.usage,
    });
  });

  it('classifies the recorded auth failure as non-retryable', async () => {
    const request = await makeRequest(c.route);
    const { run } = await replay(c.adapter, request, await c.auth());
    expect(run.outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_AUTH',
      retryable: false,
    });
  });

  it('classifies a transient provider failure as retryable', async () => {
    const request = await makeRequest(c.route);
    const { run } = await replay(c.adapter, request, c.transient);
    expect(run.outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_FAILED',
      retryable: true,
    });
  });

  it('kills the harness process group at the deadline', async () => {
    const request = await makeRequest(c.route);
    const { run, observed } = await replay(
      c.adapter,
      request,
      { mode: 'hang' },
      { timeoutMs: 800 },
    );
    expect(run.outcome).toMatchObject({ ok: false, code: 'E_HARNESS_TIMEOUT' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(observed.grandchildPid ?? 0)).toBe(false);
  });

  it('stops the harness at the output cap', async () => {
    const request = await makeRequest(c.route);
    const { run } = await replay(
      c.adapter,
      request,
      { mode: 'flood' },
      { maxOutputBytes: 128 * 1024 },
    );
    expect(run.outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_OUTPUT_LIMIT',
    });
  });
});

describe('claude argv and posture', () => {
  const route = cases[0]?.route as Route;

  it('ends options with -- so the variadic --tools cannot swallow the prompt', async () => {
    const request = await makeRequest(route);
    const { observed } = await replay(claudeAdapter, request, {
      stdout: await fixture('claude-success.json'),
    });
    expect(observed.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-haiku-4-5-20251001',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob,Skill',
      '--',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
    expect(observed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8317');
  });

  it('uses acceptEdits for edit runs and passes a JSON schema', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const request = await makeRequest(route, {
      mode: 'edit',
      jsonSchema: schema,
    });
    const { observed, run } = await replay(claudeAdapter, request, {
      stdout: `${JSON.stringify({
        type: 'result',
        is_error: false,
        result: '{"ok":true}',
        structured_output: { ok: true },
      })}\n`,
    });
    expect(observed.argv).toContain('acceptEdits');
    expect(observed.argv).not.toContain('--tools');
    // The run's own installed skills are readable; nothing else is added.
    const addDir = observed.argv.indexOf('--add-dir');
    expect(observed.argv[addDir + 1]).toBe(request.home.skillsDir);
    expect(observed.argv.filter((arg) => arg === '--add-dir')).toHaveLength(1);
    // ... read-only: every file-editing tool is denied on both skill trees.
    const denied = observed.argv.indexOf('--disallowedTools');
    expect(denied).toBe(addDir + 2);
    expect(observed.argv.slice(denied + 1, denied + 5)).toEqual([
      `Edit(/${request.home.skillsDir}/**)`,
      `Write(/${request.home.skillsDir}/**)`,
      `Edit(/${request.home.home}/.claude/skills/**)`,
      `Write(/${request.home.home}/.claude/skills/**)`,
    ]);
    expect(observed.argv[denied + 1]?.startsWith('Edit(//')).toBe(true);
    expect(observed.argv.indexOf('--')).toBeGreaterThan(denied + 4);
    const index = observed.argv.indexOf('--json-schema');
    expect(JSON.parse(observed.argv[index + 1] ?? '')).toEqual(schema);
    expect(run.outcome).toMatchObject({ ok: true, structured: { ok: true } });
  });

  it('removes every tool for a tool-free run and resumes with the same posture', async () => {
    const request = await makeRequest(route, {
      noTools: true,
      resumeSessionId: 'session-1',
    });
    const { observed } = await replay(claudeAdapter, request, {
      stdout: await fixture('claude-success.json'),
    });
    expect(observed.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-haiku-4-5-20251001',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--resume',
      'session-1',
      '--',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
  });
});

describe('posture guard', () => {
  it('refuses a resume or a tool-free run an adapter has not verified', async () => {
    const cursorRoute = cases[3]?.route as Route;
    const resume = await makeRequest(cursorRoute, {
      resumeSessionId: 'chat-1',
    });
    await expect(replay(cursorAdapter, resume, { stdout: '' })).rejects.toThrow(
      'no verified session resume',
    );
    const codexRoute = cases[1]?.route as Route;
    const noTools = await makeRequest(codexRoute, { noTools: true });
    await expect(replay(codexAdapter, noTools, { stdout: '' })).rejects.toThrow(
      'no verified tool-free',
    );
    const claudeRoute = cases[0]?.route as Route;
    const editNoTools = await makeRequest(claudeRoute, {
      noTools: true,
      mode: 'edit',
    });
    await expect(
      replay(claudeAdapter, editNoTools, { stdout: '' }),
    ).rejects.toThrow('no verified tool-free');
  });
});

const BRIDGE = {
  server: 'agent-ci-checks',
  command: '/usr/bin/node',
  args: [
    '/opt/agent-ci/dist/review/checks-mcp.js',
    '--checks',
    '/tmp/served.json',
  ],
  tool: 'run_check',
} as const;

describe('tool bridge (verify-review run_check)', () => {
  it('claude: loads exactly one MCP server and allows only its one tool, keeping the read-only tools', async () => {
    const route = cases[0]?.route as Route;
    const request = await makeRequest(route, { toolBridge: BRIDGE });
    const { observed } = await replay(claudeAdapter, request, {
      stdout: await fixture('claude-success.json'),
    });
    const config = path.join(request.scratchDir, 'claude-mcp-config.json');
    expect(observed.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-haiku-4-5-20251001',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob,Skill',
      '--mcp-config',
      config,
      '--allowedTools',
      'mcp__agent-ci-checks__run_check',
      '--',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({
      mcpServers: {
        'agent-ci-checks': {
          type: 'stdio',
          command: '/usr/bin/node',
          args: [
            '/opt/agent-ci/dist/review/checks-mcp.js',
            '--checks',
            '/tmp/served.json',
          ],
        },
      },
    });
  });

  it('codex: adds one approved MCP server table with only its one tool enabled', async () => {
    const route = cases[1]?.route as Route;
    const request = await makeRequest(route, { toolBridge: BRIDGE });
    const { observed } = await replay(codexAdapter, request, {
      stdout: await fixture('codex-success.jsonl'),
      writeArgFile: { flag: '-o', content: 'agent-ci-probe-ok' },
    });
    const config = await readFile(
      path.join(request.home.env.CODEX_HOME ?? '', 'config.toml'),
      'utf8',
    );
    expect(
      config.endsWith(
        [
          'supports_websockets = false',
          '',
          '[mcp_servers.agent-ci-checks]',
          'command = "/usr/bin/node"',
          'args = ["/opt/agent-ci/dist/review/checks-mcp.js", "--checks", "/tmp/served.json"]',
          'enabled_tools = ["run_check"]',
          'startup_timeout_sec = 20',
          '',
          '[mcp_servers.agent-ci-checks.tools.run_check]',
          'approval_mode = "approve"',
          '',
        ].join('\n'),
      ),
    ).toBe(true);
    // The sandbox stays read-only; nothing else changes in argv.
    expect(
      observed.argv.slice(
        observed.argv.indexOf('-s'),
        observed.argv.indexOf('-s') + 2,
      ),
    ).toEqual(['-s', 'read-only']);
    expect(observed.argv.join(' ')).not.toContain('mcp');
  });

  it('refuses the bridge on harnesses without a verified one, outside read-only, and with no tools', async () => {
    const opencodeRoute = cases[2]?.route as Route;
    const cursorRoute = cases[3]?.route as Route;
    const claudeRoute = cases[0]?.route as Route;
    for (const [adapter, route] of [
      [opencodeAdapter, opencodeRoute],
      [cursorAdapter, cursorRoute],
    ] as const) {
      const request = await makeRequest(route, { toolBridge: BRIDGE });
      await expect(replay(adapter, request, { stdout: '' })).rejects.toThrow(
        'no verified read-only tool bridge',
      );
    }
    const edit = await makeRequest(claudeRoute, {
      toolBridge: BRIDGE,
      mode: 'edit',
    });
    await expect(replay(claudeAdapter, edit, { stdout: '' })).rejects.toThrow(
      'only in read-only runs',
    );
    const noTools = await makeRequest(claudeRoute, {
      toolBridge: BRIDGE,
      noTools: true,
    });
    await expect(
      replay(claudeAdapter, noTools, { stdout: '' }),
    ).rejects.toThrow('only in read-only runs');
    const badName = await makeRequest(claudeRoute, {
      toolBridge: { ...BRIDGE, server: 'Bad Name' },
    });
    await expect(
      replay(claudeAdapter, badName, { stdout: '' }),
    ).rejects.toThrow('invalid tool bridge name');
  });
});

describe('codex argv, provider config and posture', () => {
  const route = cases[1]?.route as Route;

  it('writes a proxy provider keyed by the route credential name into the isolated CODEX_HOME', async () => {
    const request = await makeRequest(route);
    const { observed } = await replay(codexAdapter, request, {
      stdout: await fixture('codex-success.jsonl'),
      writeArgFile: { flag: '-o', content: 'agent-ci-probe-ok' },
    });
    const config = await readFile(
      path.join(request.home.env.CODEX_HOME ?? '', 'config.toml'),
      'utf8',
    );
    expect(config).toBe(
      [
        'model_provider = "agent_ci"',
        '',
        '[model_providers.agent_ci]',
        'name = "agent-ci route"',
        'base_url = "http://127.0.0.1:8317/v1"',
        'wire_api = "responses"',
        'env_key = "AGENT_CI_PROXY_API_KEY"',
        'supports_websockets = false',
        '',
      ].join('\n'),
    );
    expect(observed.argv).toEqual([
      'exec',
      '-m',
      'gpt-5.6-luna',
      '--json',
      '-o',
      path.join(request.scratchDir, 'codex-last-message.txt'),
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-c',
      'model_reasoning_effort="low"',
      '--',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
  });

  it('replaces a link at config.toml instead of writing through it', async () => {
    const request = await makeRequest(route);
    const outside = path.join(request.scratchDir, 'outside.toml');
    await writeFile(outside, 'untouched');
    const config = path.join(request.home.env.CODEX_HOME ?? '', 'config.toml');
    await symlink(outside, config);
    await replay(codexAdapter, request, {
      stdout: await fixture('codex-success.jsonl'),
      writeArgFile: { flag: '-o', content: 'agent-ci-probe-ok' },
    });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect((await lstat(config)).isSymbolicLink()).toBe(false);
  });

  it('uses workspace-write for edit runs and an output schema file', async () => {
    const schema = { type: 'object' };
    const request = await makeRequest(route, {
      mode: 'edit',
      jsonSchema: schema,
    });
    const { observed, run } = await replay(codexAdapter, request, {
      stdout: await fixture('codex-success.jsonl'),
      writeArgFile: { flag: '-o', content: '{"ok":true}' },
    });
    expect(observed.argv).toContain('workspace-write');
    const schemaPath =
      observed.argv[observed.argv.indexOf('--output-schema') + 1];
    expect(JSON.parse(await readFile(schemaPath ?? '', 'utf8'))).toEqual(
      schema,
    );
    expect(run.outcome).toMatchObject({ ok: true, structured: { ok: true } });
  });

  it('resumes with exec resume, setting the read-only sandbox again', async () => {
    const schema = { type: 'object' };
    const request = await makeRequest(route, {
      resumeSessionId: '0199-session',
      jsonSchema: schema,
    });
    const { observed } = await replay(codexAdapter, request, {
      stdout: await fixture('codex-success.jsonl'),
      writeArgFile: { flag: '-o', content: '{}' },
    });
    expect(observed.argv).toEqual([
      'exec',
      'resume',
      '-m',
      'gpt-5.6-luna',
      '--json',
      '-o',
      path.join(request.scratchDir, 'codex-last-message.txt'),
      '-c',
      'sandbox_mode="read-only"',
      '--skip-git-repo-check',
      '-c',
      'model_reasoning_effort="low"',
      '--output-schema',
      path.join(request.scratchDir, 'codex-output-schema.json'),
      '--',
      '0199-session',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
  });

  it('reports the recorded grok protocol failure as non-retryable', async () => {
    const request = await makeRequest(route);
    const { run } = await replay(codexAdapter, request, {
      stdout: await fixture('codex-protocol-unsupported.jsonl'),
      exitCode: 1,
    });
    expect(run.outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_FAILED',
      retryable: false,
    });
    expect(!run.outcome.ok && run.outcome.message).toContain(
      'ModelProtocolUnsupported',
    );
  });

  it('falls back to the last agent_message when the -o file is missing', async () => {
    const request = await makeRequest(route);
    const { run } = await replay(codexAdapter, request, {
      stdout: await fixture('codex-success.jsonl'),
    });
    expect(run.outcome).toMatchObject({
      ok: true,
      finalText: 'agent-ci-probe-ok',
    });
  });
});

const step = (input: number, output: number) =>
  JSON.stringify({
    type: 'step_finish',
    part: {
      tokens: { input, output, cache: { read: 1, write: 0 } },
      cost: 0.5,
    },
  });

describe('opencode argv and job config', () => {
  const route = cases[2]?.route as Route;

  it('runs standalone with deny rules for read-only', async () => {
    const request = await makeRequest(route);
    const { observed } = await replay(opencodeAdapter, request, {
      stdout: await fixture('opencode-success.jsonl'),
    });
    expect(observed.argv).toEqual([
      'run',
      '--standalone',
      '-m',
      'opencode-go/grok-4.7',
      '--format',
      'json',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
    const config = JSON.parse(
      await readFile(
        path.join(
          request.home.env.XDG_CONFIG_HOME ?? '',
          'opencode',
          'opencode.json',
        ),
        'utf8',
      ),
    );
    expect(config.permission).toEqual({
      edit: 'deny',
      bash: 'deny',
      shell: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      question: 'deny',
      execute: 'deny',
    });
  });

  it('continues a session with --session in the same isolated home', async () => {
    const request = await makeRequest(route, { resumeSessionId: 'ses_1' });
    const { observed } = await replay(opencodeAdapter, request, {
      stdout: await fixture('opencode-success.jsonl'),
    });
    expect(observed.argv).toEqual([
      'run',
      '--standalone',
      '-m',
      'opencode-go/grok-4.7',
      '--format',
      'json',
      '--session',
      'ses_1',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
  });

  it('adds --auto for edit runs and keeps the network and question tools denied', async () => {
    const request = await makeRequest(route, { mode: 'edit' });
    const { observed } = await replay(opencodeAdapter, request, {
      stdout: await fixture('opencode-success.jsonl'),
    });
    expect(observed.argv).toContain('--auto');
    const config = JSON.parse(
      await readFile(
        path.join(
          request.home.env.XDG_CONFIG_HOME ?? '',
          'opencode',
          'opencode.json',
        ),
        'utf8',
      ),
    );
    expect(config.permission).toEqual({
      webfetch: 'deny',
      websearch: 'deny',
      question: 'deny',
    });
  });

  it('sums step_finish token usage when present', async () => {
    const request = await makeRequest(route);
    const { run } = await replay(opencodeAdapter, request, {
      stdout: [
        step(10, 2),
        JSON.stringify({ type: 'text', part: { text: 'hi' } }),
        step(5, 1),
      ].join('\n'),
    });
    expect(run.outcome).toMatchObject({
      ok: true,
      finalText: 'hi',
      usage: {
        inputTokens: 15,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        costUsd: 1,
      },
    });
  });
});

async function hookedWorkspace(
  files: Record<string, string>,
): Promise<{ root: string; sub: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-cursor-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sub = path.join(root, 'pkg');
  await mkdir(sub);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return { root, sub };
}

describe('cursor argv and posture', () => {
  const route = cases[3]?.route as Route;

  it('refuses a workspace whose hooks Cursor would run, before starting the agent', async () => {
    const hooked: Record<string, string>[] = [
      { '.cursor/hooks.json': '{"version":1,"hooks":{}}' },
      { '.claude/settings.json': '{"hooks":{}}' },
      { '.claude/settings.local.json': 'not json' },
      // Cursor's project permission file: an allow-list widens what may run.
      {
        '.cursor/cli.json':
          '{"permissions":{"allow":["Shell(*)","Write(**)"],"deny":[]}}',
      },
      { '.cursor/cli.json': 'not json' },
    ];
    for (const files of hooked) {
      const { root, sub } = await hookedWorkspace(files);
      for (const cwd of [root, sub]) {
        const request = await makeRequest(route, { cwd });
        await expect(cursorAdapter.prepare(request)).rejects.toBeInstanceOf(
          UnsafeWorkspaceError,
        );
      }
    }
    // Settings without hooks and a cli.json without grants are fine.
    const { root } = await hookedWorkspace({
      '.claude/settings.json': '{"permissions":{"allow":["Bash(*)"]}}',
      '.cursor/cli.json': '{"permissions":{"allow":[],"deny":["Shell(*)"]}}',
    });
    const ok = await cursorAdapter.prepare(
      await makeRequest(route, { cwd: root }),
    );
    expect(ok.command).toBe('agent');
  });

  it('uses ask mode without --force for read-only runs and --force for edits', async () => {
    const readOnly = await replay(cursorAdapter, await makeRequest(route), {
      stdout: await fixture('cursor-success.json'),
    });
    expect(readOnly.observed.argv).toEqual([
      '-p',
      '--trust',
      '--output-format',
      'json',
      '--model',
      'grok-4.7-low',
      '--mode',
      'ask',
      'Reply with exactly: agent-ci-probe-ok',
    ]);
    const edit = await replay(
      cursorAdapter,
      await makeRequest(route, { mode: 'edit' }),
      {
        stdout: await fixture('cursor-success.json'),
      },
    );
    expect(edit.observed.argv).toContain('--force');
    expect(edit.observed.argv).not.toContain('ask');
  });
});
