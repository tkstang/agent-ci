import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import { buildFailedRunResult } from '@agent-ci/contracts/run-result.js';
import { describe, expect, it } from 'vitest';

const context = (cwd = process.cwd()) => ({
  env: {},
  cwd,
  log: () => undefined,
});

describe('agent-ci models', () => {
  it('lists every qualified model and route from the packaged table', async () => {
    const { envelope, exitCode } = await run(['models'], context());
    expect(exitCode).toBe(0);
    if (!envelope.ok) throw new Error('models failed');
    const data = envelope.data as {
      models: string[];
      routes: { id: string; harness: string; account: string }[];
    };
    expect(data.models).toEqual(
      expect.arrayContaining([
        'claude-haiku-4-5',
        'gpt-5.6-luna',
        'grok-4.7',
        'fake-echo',
      ]),
    );
    const harnesses = new Set(data.routes.map((route) => route.harness));
    expect(harnesses).toEqual(
      new Set(['claude', 'codex', 'opencode', 'cursor', 'fake']),
    );
  });

  it('filters by model and reports a bad table as E_ROUTE_CONFIG', async () => {
    const filtered = await run(['models', '--model', 'grok-4.7'], context());
    if (!filtered.envelope.ok) throw new Error('models failed');
    expect(
      (filtered.envelope.data as { routes: { model: string }[] }).routes.every(
        (route) => route.model === 'grok-4.7',
      ),
    ).toBe(true);
    const missing = await run(
      ['models', '--models', '/nonexistent/models.yaml'],
      context(),
    );
    expect(missing.envelope).toMatchObject({
      ok: false,
      code: 'E_ROUTE_CONFIG',
    });
  });
});

describe('agent-ci validate', () => {
  it('accepts a valid run-result.json and rejects a malformed one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-validate-'));
    const good = path.join(dir, 'good.json');
    await writeFile(
      good,
      JSON.stringify(
        buildFailedRunResult({
          outputContract: 'report',
          code: 'E_X',
          message: 'm',
        }),
      ),
    );
    const ok = await run(['validate', '--file', 'good.json'], context(dir));
    expect(ok.envelope).toMatchObject({
      ok: true,
      data: { valid: true, outputContract: 'report', status: 'failed' },
    });
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ ok: 'yes' }));
    const rejected = await run(
      ['validate', '--file', bad, '--contract', 'changes'],
      context(dir),
    );
    expect(rejected.exitCode).toBe(1);
    expect(rejected.envelope).toMatchObject({
      ok: false,
      code: 'E_INVALID_RUN_RESULT',
    });
    const unreadable = await run(
      ['validate', '--file', 'missing.json'],
      context(dir),
    );
    expect(unreadable.envelope).toMatchObject({ code: 'E_INVALID_INPUT' });
  });
});
