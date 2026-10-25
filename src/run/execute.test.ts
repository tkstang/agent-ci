import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PipeRunner } from '@agent-ci/harness/home.js';
import { type RunOptions, runAgent } from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const REPLAY_CLI = fileURLToPath(
  new URL('../harness/testing/replay-cli.mjs', import.meta.url),
);

const MODELS = `version: 1
routes:
  - id: fake-echo-keyed
    model: fake-echo-keyed
    harness: fake
    family: fake
    providerModel: echo
    credentials: [CURSOR_API_KEY]
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-echo
    model: fake-echo
    harness: fake
    family: fake
    providerModel: echo
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-hang
    model: fake-hang
    harness: fake
    family: fake
    providerModel: hang
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: grok-login
    model: grok-4.7
    harness: opencode
    family: xai
    providerModel: opencode-go/grok-4.7
    login: true
    billing: subscription
    account: personal
    structuredOutput: prompt
    qualified: null
`;

async function options(
  overrides: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-exec-'));
  const modelsPath = path.join(dir, 'models.yaml');
  await writeFile(modelsPath, MODELS);
  return {
    prompt: 'Summarize.',
    cwd: dir,
    outDir: path.join(dir, '.agent-ci'),
    outputContract: 'report',
    useCase: 'generic-prompt',
    targetRepo: 'local/scratch',
    mode: 'read-only',
    allowPool: false,
    seedLogin: false,
    timeoutMs: 60_000,
    maxAttempts: 1,
    retryDelayMs: 0,
    modelsPath,
    env: { PATH: process.env.PATH },
    ...overrides,
  };
}

async function brokenGit(dir: string): Promise<string> {
  const fakeGit = path.join(dir, 'broken-git');
  await writeFile(
    fakeGit,
    "#!/bin/sh\necho 'fatal: detected dubious ownership in repository' >&2\nexit 128\n",
    { mode: 0o755 },
  );
  return fakeGit;
}

describe('runAgent', () => {
  it('times out a hanging harness and still writes a failed result', async () => {
    const opts = await options({ model: 'fake-hang', timeoutMs: 1_000 });
    const summary = await runAgent(opts);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error?.code).toBe('E_HARNESS_TIMEOUT');
    const result = JSON.parse(await readFile(summary.value.resultPath, 'utf8'));
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      errors: [expect.stringContaining('E_HARNESS_TIMEOUT')],
    });
  });

  it('seeds an opted-in login into the isolated home before the harness runs', async () => {
    const pipeCalls: Parameters<PipeRunner>[] = [];
    const pipe: PipeRunner = async (...args) => {
      pipeCalls.push(args);
      return { fromExit: 0, toExit: 0, transferred: '' };
    };
    const homeRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-ci-kept-home-'),
    );
    const opts = await options({
      model: 'grok-4.7',
      seedLogin: true,
      homeRoot,
    });
    const control = path.join(opts.cwd, 'control.json');
    const runResult = JSON.stringify({
      summary: 'ok',
      report: { title: 'T', markdown: 'M' },
    });
    await writeFile(
      control,
      JSON.stringify({
        observedPath: path.join(opts.cwd, 'observed.json'),
        stdout: `${JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { text: runResult } })}\n`,
      }),
    );
    const summary = await runAgent(opts, {
      pipe,
      harness: {
        commandOverride: {
          command: process.execPath,
          prefixArgs: [REPLAY_CLI, control],
        },
      },
    });
    expect(summary.ok && summary.value.result.status).toBe('no-op');
    expect(pipeCalls).toHaveLength(1);
    const observed = JSON.parse(
      await readFile(path.join(opts.cwd, 'observed.json'), 'utf8'),
    );
    expect(observed.env.XDG_DATA_HOME.startsWith(homeRoot)).toBe(true);
    expect(pipeCalls[0]?.[1].env.XDG_DATA_HOME).toBe(
      observed.env.XDG_DATA_HOME,
    );
  });

  it('refuses a login route without --seed-login before creating anything', async () => {
    const opts = await options({ model: 'grok-4.7' });
    expect(await runAgent(opts)).toMatchObject({
      ok: false,
      code: 'E_CREDENTIAL_MISSING',
    });
  });

  it('clears a login left in a kept home root before a non-login route runs', async () => {
    const homeRoot = await mkdtemp(
      path.join(os.tmpdir(), 'agent-ci-kept-home-'),
    );
    const stale = path.join(homeRoot, 'home', '.codex', 'auth.json');
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, '{"placeholder":"synthetic-stale-login"}');
    const opts = await options({ model: 'fake-echo', homeRoot });
    const summary = await runAgent(opts);
    expect(summary.ok && summary.value.result.ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('treats seeded-login material as a secret: an echoed token fails the run and is never written', async () => {
    const token = 'synthetic-seeded-access-token-0001';
    const pipe: PipeRunner = async () => ({
      fromExit: 0,
      toExit: 0,
      transferred: JSON.stringify([{ type: 'oauth', access: token }]),
    });
    const opts = await options({ model: 'grok-4.7', seedLogin: true });
    const control = path.join(opts.cwd, 'control.json');
    const leaked = JSON.stringify({
      summary: `I found a token: ${token}`,
      report: { title: 'T', markdown: token },
    });
    await writeFile(
      control,
      JSON.stringify({
        observedPath: path.join(opts.cwd, 'observed.json'),
        stdout: `${JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { text: leaked } })}\n`,
      }),
    );
    const summary = await runAgent(opts, {
      pipe,
      harness: {
        commandOverride: {
          command: process.execPath,
          prefixArgs: [REPLAY_CLI, control],
        },
      },
    });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.error?.code).toBe('E_SECRET_COPY');
    const written =
      (await readFile(summary.value.resultPath, 'utf8')) +
      (await readFile(summary.value.logPath, 'utf8'));
    expect(written).not.toContain(token);
    expect(JSON.stringify(summary.value)).not.toContain(token);
  });

  describe('workspace status and in-attempt errors', () => {
    it('fails an edit run before the harness when changes cannot be detected', async () => {
      const opts = await options({ model: 'fake-echo', mode: 'edit' });
      const summary = await runAgent(opts, { git: await brokenGit(opts.cwd) });
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.error?.code).toBe('E_WORKSPACE_STATUS');
      expect(summary.value.attempts).toBe(0);
      const result = JSON.parse(
        await readFile(summary.value.resultPath, 'utf8'),
      );
      expect(result).toMatchObject({ ok: false, status: 'failed' });
      const log = await readFile(summary.value.logPath, 'utf8');
      expect(log).toContain('"event":"workspace.status"');
      expect(log).not.toContain('"event":"attempt"');
    });

    it('records the git failure but completes a read-only run', async () => {
      const opts = await options({ model: 'fake-echo' });
      const summary = await runAgent(opts, { git: await brokenGit(opts.cwd) });
      expect(summary.ok && summary.value.result.ok).toBe(true);
      if (!summary.ok) return;
      const log = await readFile(summary.value.logPath, 'utf8');
      expect(log).toContain('"event":"workspace.status"');
      expect(log).toContain('dubious ownership');
    });

    it('turns a leak-guard throw into a written, failed result', async () => {
      const value = 'synthetic-cursor-credential-0042';
      const opts = await options({
        model: 'fake-echo-keyed',
        prompt: `Please use ${value}`,
        env: { PATH: process.env.PATH, CURSOR_API_KEY: value },
      });
      const summary = await runAgent(opts);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.error?.code).toBe('E_CREDENTIAL_LEAK');
      const written =
        (await readFile(summary.value.resultPath, 'utf8')) +
        (await readFile(summary.value.logPath, 'utf8'));
      expect(written).toContain('E_CREDENTIAL_LEAK');
      expect(written).not.toContain(value);
      expect(await readFile(summary.value.promptPath, 'utf8')).not.toContain(
        value,
      );
    });
  });
});
