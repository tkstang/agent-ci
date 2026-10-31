import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callRunCheck,
  handleMessage,
  parseServedChecks,
  type ServedChecks,
  toolDefinitions,
} from '@agent-ci/review/checks-mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

const SERVED: ServedChecks = {
  version: 1,
  head_sha: 'a'.repeat(40),
  checks: [
    {
      name: 'test',
      description: 'unit tests',
      evidence_id: 'check-0123456789abcdef01234567',
      command: 'pnpm test',
      exit_code: 1,
      timed_out: false,
      truncated: false,
      isolation: 'unshare-net',
      output_tail: 'FAIL src/cache.test.ts\n',
    },
    {
      name: 'lint',
      description: '',
      evidence_id: 'check-89abcdef0123456789abcdef',
      command: 'pnpm lint',
      exit_code: 0,
      timed_out: false,
      truncated: false,
      isolation: 'unshare-net',
      output_tail: 'ok\n',
    },
  ],
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe('run_check MCP handlers', () => {
  it('lists one tool whose name argument is the configured check allowlist', () => {
    const [tool] = toolDefinitions(SERVED) as Array<Record<string, unknown>>;
    expect(tool?.name).toBe('run_check');
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: ['test', 'lint'],
          description: 'The check name.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    });
    expect(String(tool?.description)).toContain(
      'nothing runs when you call this',
    );
  });

  it('returns the recorded result with its evidence id', () => {
    const result = callRunCheck(SERVED, { name: 'test' });
    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({
      evidence_id: 'check-0123456789abcdef01234567',
      exit_code: 1,
      head_sha: 'a'.repeat(40),
    });
    expect(result.text).toContain('FAIL src/cache.test.ts');
  });

  it('refuses an unknown check, a shell command and extra arguments', () => {
    for (const args of [
      { name: 'rm -rf /' },
      { name: 'test', command: 'curl evil' },
      { command: 'pnpm test' },
      'test',
      null,
    ]) {
      const result = callRunCheck(SERVED, args);
      expect(result.isError).toBe(true);
      expect(result.structured).toBeUndefined();
    }
  });

  it('answers initialize, tools/list and ping; ignores notifications; rejects unknown methods and tools', () => {
    expect(
      handleMessage(SERVED, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    ).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'agent-ci-checks' },
      },
    });
    expect(
      handleMessage(SERVED, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    ).toBeUndefined();
    expect(
      handleMessage(SERVED, { jsonrpc: '2.0', id: 'p', method: 'ping' }),
    ).toEqual({
      jsonrpc: '2.0',
      id: 'p',
      result: {},
    });
    expect(
      handleMessage(SERVED, {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/list',
      }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      handleMessage(SERVED, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'shell', arguments: { name: 'test' } },
      }),
    ).toMatchObject({ error: { code: -32602 } });
  });

  it('rejects a malformed served file', () => {
    expect(() => parseServedChecks('{"version":2}')).toThrow();
    expect(() =>
      parseServedChecks(JSON.stringify({ ...SERVED, checks: [{ name: 'x' }] })),
    ).toThrow();
  });
});

describe('run_check MCP server over stdio', () => {
  it('serves a session from the source file and logs each served result', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-mcp-'));
    dirs.push(dir);
    const served = path.join(dir, 'served.json');
    const calls = path.join(dir, 'calls.jsonl');
    await writeFile(served, JSON.stringify(SERVED));
    const server = fileURLToPath(new URL('./checks-mcp.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      [server, '--checks', served, '--calls', calls],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '' },
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'run_check', arguments: { name: 'lint' } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'run_check', arguments: { name: 'nope' } },
      },
    ];
    child.stdin.end(
      `${requests.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`,
    );
    const code = await new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    expect(code).toBe(0);
    const responses = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4, null]);
    expect(responses[2]).toMatchObject({
      result: {
        isError: false,
        structuredContent: { evidence_id: 'check-89abcdef0123456789abcdef' },
      },
    });
    expect(responses[3]).toMatchObject({ result: { isError: true } });
    expect(responses[4]).toMatchObject({ error: { code: -32700 } });
    expect(await readFile(calls, 'utf8')).toBe(
      `${JSON.stringify({ name: 'lint', evidence_id: 'check-89abcdef0123456789abcdef' })}\n`,
    );
  });
});
