import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { extractStructuredResult } from '@agent-ci/contracts/final-answer.js';
import { fakeAdapter } from '@agent-ci/harness/adapters/fake.js';
import { createHomeRoot } from '@agent-ci/harness/home.js';
import { runHarness } from '@agent-ci/harness/run.js';
import type { HarnessRequest } from '@agent-ci/harness/types.js';
import type { Route } from '@agent-ci/routing/schema.js';
import { describe, expect, it } from 'vitest';

const route = (scenario: string): Route => ({
  id: `fake-${scenario}`,
  model: `fake-${scenario}`,
  harness: 'fake',
  providerModel: scenario,
  credentials: [],
  login: false,
  billing: 'none',
  account: 'personal',
  structuredOutput: 'prompt',
  qualified: null,
});

async function request(scenario: string): Promise<HarnessRequest> {
  const home = await createHomeRoot();
  if (!home.ok) throw new Error(home.message);
  return {
    route: route(scenario),
    prompt: 'Return a report.',
    cwd: process.cwd(),
    mode: 'read-only',
    home: home.value,
    scratchDir: await mkdtemp(path.join(os.tmpdir(), 'agent-ci-scratch-')),
    parentEnv: {
      PATH: process.env.PATH,
      // Synthetic placeholder; the fake route names no credential.
      CURSOR_API_KEY: 'synthetic-cursor-placeholder',
    },
  };
}

describe('fake harness', () => {
  it('runs end to end without a model or credential', async () => {
    const run = await runHarness(fakeAdapter, await request('echo'), {
      timeoutMs: 20_000,
    });
    expect(run.outcome.ok).toBe(true);
    if (!run.outcome.ok) return;
    const candidate = extractStructuredResult(run.outcome.finalText);
    expect(candidate.ok).toBe(true);
    const markdown = String(
      (candidate.ok &&
        (candidate.value as { report: { markdown: string } }).report
          .markdown) ??
        '',
    );
    expect(markdown).toContain('stdin is /dev/null: true');
    expect(markdown).toContain('Credential-like variables visible: 0');
    expect(markdown).toContain('HOME under an agent-ci home root: true');
    expect(run.outcome.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('classifies auth and transient failures', async () => {
    const auth = await runHarness(fakeAdapter, await request('auth'), {
      timeoutMs: 20_000,
    });
    expect(auth.outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_AUTH',
      retryable: false,
    });
    const transient = await runHarness(fakeAdapter, await request('fail'), {
      timeoutMs: 20_000,
    });
    expect(transient.outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_FAILED',
      retryable: true,
    });
  });

  it('times out a hanging harness', async () => {
    const run = await runHarness(fakeAdapter, await request('hang'), {
      timeoutMs: 1_000,
    });
    expect(run.outcome).toMatchObject({ ok: false, code: 'E_HARNESS_TIMEOUT' });
  });
});
