import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { failure, success } from '@agent-ci/result.js';
import {
  addUsage,
  type RunOptions,
  runAgent,
  type StructuredRunOptions,
} from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const REPLAY_CLI = fileURLToPath(
  new URL('../harness/testing/replay-cli.mjs', import.meta.url),
);

const MODELS = `version: 1
routes:
  - id: fake-review
    model: fake-review
    harness: fake
    family: fake
    providerModel: review
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-review-repair
    model: fake-review-repair
    harness: fake
    family: fake
    providerModel: review-repair
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-review-repair-escape
    model: fake-review-repair-escape
    harness: fake
    family: fake
    providerModel: review-repair-escape
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: grok-cursor
    model: grok-cursor
    harness: cursor
    family: xai
    providerModel: grok-4.7-low
    credentials: [CURSOR_API_KEY]
    billing: subscription
    account: personal
    structuredOutput: prompt
    qualified: null
`;

const SYNTHETIC_KEY = 'synthetic-cursor-key-0123456789abcdef';

/** Strict on the first answer (findings array), lenient on the last. */
const structured: StructuredRunOptions = {
  schema: { type: 'object' },
  accept(candidate, final) {
    const record = candidate as { summary?: unknown; findings?: unknown };
    if (typeof record?.summary !== 'string') {
      return failure('E_INVALID_RUN_RESULT', 'summary must be a string');
    }
    if (!final && !Array.isArray(record.findings)) {
      return failure('E_INVALID_RUN_RESULT', 'findings must be an array');
    }
    return success({
      summary: record.summary,
      findings: Array.isArray(record.findings) ? record.findings : [],
    });
  },
  repairPrompt: (problem) =>
    `Your answer was rejected: ${problem}. Answer again.`,
  outputFile: 'answer.json',
  describe: (value) =>
    `${(value as { findings: unknown[] }).findings.length} finding(s)`,
};

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-structured-'));
  await mkdir(path.join(dir, '.agent-ci-review'));
  await writeFile(
    path.join(dir, '.agent-ci-review', 'diff.patch'),
    [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      '',
    ].join('\n'),
  );
  return dir;
}

async function options(
  overrides: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const dir = await workspace();
  const out = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-structured-out-'));
  const modelsPath = path.join(out, 'models.yaml');
  await writeFile(modelsPath, MODELS);
  return {
    prompt: 'Review the change.',
    cwd: dir,
    outDir: path.join(out, 'result'),
    outputContract: 'report',
    useCase: 'agent-ci-pr-review',
    targetRepo: 'local/scratch',
    mode: 'read-only',
    allowPool: false,
    seedLogin: false,
    timeoutMs: 60_000,
    maxAttempts: 1,
    retryDelayMs: 0,
    modelsPath,
    env: { PATH: process.env.PATH, CURSOR_API_KEY: SYNTHETIC_KEY },
    structured,
    ...overrides,
  };
}

async function cursorReplay(answer: string, dir: string) {
  const control = path.join(dir, 'control.json');
  await writeFile(
    control,
    JSON.stringify({
      observedPath: path.join(dir, 'observed.json'),
      stdout: `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: answer,
        session_id: 'chat-1',
      })}\n`,
    }),
  );
  return {
    harness: {
      commandOverride: {
        command: process.execPath,
        prefixArgs: [REPLAY_CLI, control],
      },
    },
  };
}

describe('structured runs', () => {
  it('writes the accepted value and a report result; no repair needed', async () => {
    const opts = await options({ routeId: 'fake-review' });
    const summary = await runAgent(opts);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error).toBeUndefined();
    expect(summary.value.repair).toBe('not-needed');
    expect(summary.value.result).toMatchObject({
      ok: true,
      status: 'no-op',
      outputContract: 'report',
      summary: '1 finding(s)',
    });
    const written = JSON.parse(
      await readFile(summary.value.structuredPath ?? '', 'utf8'),
    );
    expect(written.findings[0]).toMatchObject({
      path: 'src/a.ts',
      line: 2,
      original_code: 'const b = 2;',
    });
    // The structured prompt is used as given (no RunResult wrapper).
    expect(await readFile(summary.value.promptPath, 'utf8')).toBe(
      'Review the change.',
    );
  });

  it('repairs a rejected first answer once by resuming the session', async () => {
    const opts = await options({ routeId: 'fake-review-repair' });
    const summary = await runAgent(opts);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error).toBeUndefined();
    expect(summary.value.repair).toBe('repaired');
    const log = await readFile(summary.value.logPath, 'utf8');
    const repair = log
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string; type?: string })
      .find((record) => JSON.stringify(record).includes('"repair"'));
    expect(JSON.stringify(repair)).toContain('findings must be an array');
    expect(existsSync(summary.value.structuredPath ?? '')).toBe(true);
  });

  it('validates the home again after the repair turn and withholds the answer', async () => {
    const opts = await options({ routeId: 'fake-review-repair-escape' });
    const summary = await runAgent(opts);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error?.code).toBe('E_HOME_ROOT');
    expect(summary.value.structuredPath).toBeNull();
    expect(existsSync(path.join(opts.outDir, 'answer.json'))).toBe(false);
  });

  it('keeps what the last chance allows when no repair turn exists (Cursor)', async () => {
    const opts = await options({ routeId: 'grok-cursor' });
    const summary = await runAgent(
      opts,
      await cursorReplay('{"summary":"partial","findings":"none"}', opts.cwd),
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.repair).toBe('unavailable');
    expect(summary.value.error).toBeUndefined();
    const written = JSON.parse(
      await readFile(summary.value.structuredPath ?? '', 'utf8'),
    );
    expect(written).toEqual({ summary: 'partial', findings: [] });
  });

  it('fails without writing a value when even the last chance is rejected', async () => {
    const opts = await options({ routeId: 'grok-cursor' });
    const summary = await runAgent(
      opts,
      await cursorReplay('This is not JSON.', opts.cwd),
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error?.code).toBe('E_INVALID_RUN_RESULT');
    expect(summary.value.structuredPath).toBeNull();
    expect(summary.value.result.ok).toBe(false);
    expect(existsSync(path.join(opts.outDir, 'answer.json'))).toBe(false);
  });

  it('withholds an answer that carries a credential value', async () => {
    const opts = await options({ routeId: 'grok-cursor' });
    const summary = await runAgent(
      opts,
      await cursorReplay(
        JSON.stringify({ summary: `key ${SYNTHETIC_KEY}`, findings: [] }),
        opts.cwd,
      ),
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error?.code).toBe('E_SECRET_COPY');
    expect(existsSync(path.join(opts.outDir, 'answer.json'))).toBe(false);
    const written =
      (await readFile(summary.value.resultPath, 'utf8')) +
      (await readFile(summary.value.logPath, 'utf8'));
    expect(written).not.toContain(SYNTHETIC_KEY);
  });

  it('refuses a tool-free run on a harness without a verified tool-free posture', async () => {
    const opts = await options({
      routeId: 'grok-cursor',
      structured: { ...structured, noTools: true },
    });
    const summary = await runAgent(opts);
    expect(summary).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
    expect(existsSync(opts.outDir)).toBe(false);
  });

  it('refuses a tool bridge on a harness without a verified one, before anything is created', async () => {
    const opts = await options({
      routeId: 'grok-cursor',
      structured: {
        ...structured,
        toolBridge: {
          server: 'agent-ci-checks',
          command: process.execPath,
          args: ['checks-mcp.js'],
          tool: 'run_check',
        },
      },
    });
    const summary = await runAgent(opts);
    expect(summary).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
    expect(existsSync(opts.outDir)).toBe(false);
  });

  it('refuses an edit-mode structured run and a reserved output name', async () => {
    const edit = await runAgent(
      await options({ routeId: 'fake-review', mode: 'edit' }),
    );
    expect(edit).toMatchObject({ ok: false, code: 'E_INVALID_INPUT' });
    const reserved = await runAgent(
      await options({
        routeId: 'fake-review',
        structured: { ...structured, outputFile: 'run-result.json' },
      }),
    );
    expect(reserved).toMatchObject({ ok: false, code: 'E_INVALID_INPUT' });
  });
});

describe('addUsage', () => {
  it('sums counters both sides report and leaves the rest unknown', () => {
    expect(
      addUsage(
        { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
        { inputTokens: 3, costUsd: 0.25 },
      ),
    ).toEqual({ inputTokens: 4, costUsd: 0.75 });
    expect(addUsage(null, { inputTokens: 1 })).toEqual({ inputTokens: 1 });
  });
});
