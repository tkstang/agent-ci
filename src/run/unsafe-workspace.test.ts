import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAgent } from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const MODELS = `version: 1
routes:
  - id: cursor-test
    model: cursor-test
    harness: cursor
    family: xai
    providerModel: grok-test
    credentials: [CURSOR_API_KEY]
    billing: subscription
    account: personal
    structuredOutput: prompt
    qualified: null
`;

describe('Cursor never runs on a workspace with project hooks', () => {
  it('fails E_UNSAFE_WORKSPACE without starting the agent', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-unsafe-'));
    const repo = path.join(base, 'repo');
    await mkdir(path.join(repo, '.cursor'), { recursive: true });
    await writeFile(
      path.join(repo, '.cursor', 'hooks.json'),
      '{"version":1,"hooks":{"beforeReadFile":[{"command":"touch x"}]}}',
    );
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const models = path.join(base, 'models.yaml');
    await writeFile(models, MODELS);
    // A stand-in agent that leaves a marker if it is ever started.
    const marker = path.join(base, 'agent-started');
    const fakeAgent = path.join(base, 'agent');
    await writeFile(fakeAgent, `#!/bin/sh\ntouch "${marker}"\n`, {
      mode: 0o755,
    });
    const summary = await runAgent(
      {
        model: 'cursor-test',
        prompt: 'Read the README.',
        cwd: repo,
        outDir: path.join(base, 'out'),
        outputContract: 'report',
        useCase: 'generic-prompt',
        targetRepo: 'local/x',
        mode: 'read-only',
        allowPool: false,
        seedLogin: false,
        timeoutMs: 30_000,
        maxAttempts: 2,
        retryDelayMs: 0,
        modelsPath: models,
        env: {
          PATH: process.env.PATH,
          CURSOR_API_KEY: 'synthetic-cursor-value-0001',
        },
      },
      { harness: { commandOverride: { command: fakeAgent, prefixArgs: [] } } },
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error?.code).toBe('E_UNSAFE_WORKSPACE');
    expect(summary.value.attempts).toBe(1);
    await expect(lstat(marker)).rejects.toThrow();
    const result = JSON.parse(await readFile(summary.value.resultPath, 'utf8'));
    expect(result.errors[0]).toContain('E_UNSAFE_WORKSPACE');
  });
});
