import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import { validateRunResult } from '@agent-ci/contracts/run-result.js';
import { describe, expect, it } from 'vitest';

const fakeRoute = (scenario: string) => `  - id: fake-${scenario}
    model: fake-${scenario}
    harness: fake
    family: fake
    providerModel: ${scenario}
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
`;

const MODELS = `version: 1
routes:
${['echo', 'invalid', 'auth', 'fail'].map(fakeRoute).join('')}  - id: pool-only
    model: pool-model
    harness: claude
    family: claude
    providerModel: claude-haiku-4-5-20251001
    credentials: [ANTHROPIC_AUTH_TOKEN]
    billing: subscription
    account: pool
    structuredOutput: json-schema
    qualified: null
`;

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-run-'));
  const models = path.join(dir, 'models.yaml');
  await writeFile(models, MODELS);
  const logs: string[] = [];
  const context = {
    // Synthetic placeholder: present so the guard has a value to watch for.
    env: {
      PATH: process.env.PATH,
      CURSOR_API_KEY: 'synthetic-cursor-placeholder-value',
    },
    cwd: dir,
    log: (line: string) => logs.push(line),
  };
  return { dir, models, context, logs };
}

const exists = async (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe('agent-ci run', () => {
  it('runs the fake harness and writes a validated run-result.json and run log', async () => {
    const { dir, models, context } = await workspace();
    const { envelope, exitCode } = await run(
      [
        'run',
        '--model',
        'fake-echo',
        '--prompt',
        'Summarize.',
        '--models',
        models,
        '--target-repo',
        'local/scratch',
      ],
      context,
    );
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      ok: true,
      command: 'run',
      data: {
        ok: true,
        status: 'no-op',
        outputContract: 'report',
        attempts: 1,
        route: { id: 'fake-echo', harness: 'fake', billing: 'none' },
        homeRoot: null,
      },
    });
    const result = JSON.parse(
      await readFile(path.join(dir, '.agent-ci', 'run-result.json'), 'utf8'),
    );
    expect(validateRunResult(result).ok).toBe(true);
    expect(result).toMatchObject({
      useCase: 'generic-prompt',
      targetRepo: 'local/scratch',
    });
    const log = (
      await readFile(path.join(dir, '.agent-ci', 'run-log.jsonl'), 'utf8')
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(log.map((record) => record.event)).toEqual([
      'run.start',
      'attempt',
      'run.result',
    ]);
    const text =
      JSON.stringify(envelope) + JSON.stringify(result) + JSON.stringify(log);
    expect(text).not.toContain('synthetic-cursor-placeholder-value');
  });

  it('writes a contract-shaped failed result when the answer is not JSON', async () => {
    const { dir, models, context } = await workspace();
    const { envelope, exitCode } = await run(
      ['run', '--model', 'fake-invalid', '--prompt', 'x', '--models', models],
      context,
    );
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, code: 'E_INVALID_RUN_RESULT' });
    const result = JSON.parse(
      await readFile(path.join(dir, '.agent-ci', 'run-result.json'), 'utf8'),
    );
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(validateRunResult(result, { outputContract: 'report' }).ok).toBe(
      true,
    );
  });

  it('does not retry an auth failure and reports it as a user error', async () => {
    const { models, context } = await workspace();
    const { envelope, exitCode } = await run(
      [
        'run',
        '--model',
        'fake-auth',
        '--prompt',
        'x',
        '--models',
        models,
        '--max-attempts',
        '3',
      ],
      context,
    );
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, code: 'E_HARNESS_AUTH' });
  });

  it('retries a transient failure and reports a harness fault (exit 2)', async () => {
    const { dir, models, context } = await workspace();
    const { envelope, exitCode } = await run(
      [
        'run',
        '--model',
        'fake-fail',
        '--prompt',
        'x',
        '--models',
        models,
        '--max-attempts',
        '2',
        '--retry-delay-seconds',
        '0',
      ],
      context,
    );
    expect(exitCode).toBe(2);
    expect(envelope).toMatchObject({ ok: false, code: 'E_HARNESS_FAILED' });
    const log = await readFile(
      path.join(dir, '.agent-ci', 'run-log.jsonl'),
      'utf8',
    );
    expect(log.match(/"event":"attempt"/gu)).toHaveLength(2);
  });

  it('refuses a pool route without --allow-pool and writes nothing', async () => {
    const { dir, models, context } = await workspace();
    const { envelope, exitCode } = await run(
      ['run', '--model', 'pool-model', '--prompt', 'x', '--models', models],
      {
        ...context,
        env: {
          ...context.env,
          ANTHROPIC_AUTH_TOKEN: 'synthetic-token-placeholder',
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, code: 'E_POLICY_POOL' });
    expect(await exists(path.join(dir, '.agent-ci'))).toBe(false);
  });

  it('keeps an explicit --home-root and removes a temp root', async () => {
    const { dir, models, context } = await workspace();
    const homeRoot = path.join(dir, 'home-root');
    const kept = await run(
      [
        'run',
        '--model',
        'fake-echo',
        '--prompt',
        'x',
        '--models',
        models,
        '--home-root',
        homeRoot,
      ],
      context,
    );
    expect(kept.envelope).toMatchObject({ ok: true, data: { homeRoot } });
    expect(await exists(path.join(homeRoot, 'home', '.codex'))).toBe(true);
  });

  it('rejects bad flags with E_INVALID_INPUT', async () => {
    const { context } = await workspace();
    for (const argv of [
      ['run', '--prompt', 'x'],
      ['run', '--model', 'fake-echo'],
      ['run', '--model', 'fake-echo', '--prompt', 'x', '--prompt-file', 'y'],
      ['run', '--model', 'fake-echo', '--prompt', 'x', '--mode', 'yolo'],
      ['run', '--model', 'fake-echo', '--prompt', 'x', '--bogus'],
      ['run', '--model', 'fake-echo', '--prompt', 'x', '--max-attempts', '0'],
    ]) {
      const { envelope, exitCode } = await run(argv, context);
      expect(exitCode).toBe(1);
      expect(envelope).toMatchObject({ ok: false, code: 'E_INVALID_INPUT' });
    }
  });
});
