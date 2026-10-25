import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExportRunner, PipeRunner } from '@agent-ci/harness/home.js';
import type { RunHarnessDeps } from '@agent-ci/harness/run.js';
import { type RunOptions, runAgent } from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const REPLAY_CLI = fileURLToPath(
  new URL('../harness/testing/replay-cli.mjs', import.meta.url),
);

const MODELS = `version: 1
routes:
  - id: codex-login
    model: codex-login
    harness: codex
    family: openai
    providerModel: synthetic-openai
    login: true
    billing: subscription
    account: personal
    structuredOutput: output-schema
    qualified: null
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

async function writtenOutputs(summary: Awaited<ReturnType<typeof runAgent>>) {
  if (!summary.ok) throw new Error(summary.message);
  return (
    (await readFile(summary.value.resultPath, 'utf8')) +
    (await readFile(summary.value.logPath, 'utf8')) +
    JSON.stringify(summary.value)
  );
}

const okProcess = (stdout: string) => ({
  started: true as const,
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  outputLimitExceeded: false,
  durationMs: 1,
});

const opencodeAnswer = (text: string) =>
  `${JSON.stringify({
    type: 'text',
    part: {
      text: JSON.stringify({
        summary: text,
        report: { title: 'T', markdown: text },
      }),
    },
  })}\n`;

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
      return {
        fromExit: 0,
        toExit: 0,
        transferred: JSON.stringify([{ placeholder: 'synthetic-seed-0022' }]),
      };
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
    expect(
      observed.env.XDG_DATA_HOME.startsWith(await realpath(homeRoot)),
    ).toBe(true);
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
    it('stops read-only and edit runs before any home when the repository boundary is unknown', async () => {
      for (const mode of ['read-only', 'edit'] as const) {
        const homeRoot = await mkdtemp(
          path.join(os.tmpdir(), 'agent-ci-unknown-boundary-home-'),
        );
        const opts = await options({ model: 'fake-echo', mode, homeRoot });
        const summary = await runAgent(opts, {
          git: await brokenGit(opts.cwd),
        });
        expect(summary, mode).toMatchObject({
          ok: false,
          code: 'E_WORKSPACE_STATUS',
          message: expect.stringContaining('dubious ownership'),
        });
        // Nothing created: no layout in the home root, no artifacts.
        expect(existsSync(path.join(homeRoot, 'home'))).toBe(false);
        expect(existsSync(opts.outDir)).toBe(false);
      }
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

  describe('login tokens refreshed during a run', () => {
    const seed = 'synthetic-seed-access-token-0017';
    const fresh = 'synthetic-rotated-access-token-0017';

    async function loginOptions(): Promise<RunOptions> {
      const opts = await options({ model: 'codex-login', seedLogin: true });
      const operatorHome = path.join(
        opts.cwd,
        '..',
        `${path.basename(opts.cwd)}-operator`,
      );
      await mkdir(path.join(operatorHome, '.codex'), { recursive: true });
      await writeFile(
        path.join(operatorHome, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: seed } }),
      );
      return { ...opts, env: { PATH: process.env.PATH, HOME: operatorHome } };
    }

    /** A codex stand-in: optionally rotates the isolated login, then answers. */
    function codexSpawn(
      steps: { rotate: boolean; answer?: string; fail?: string }[],
    ): RunHarnessDeps['spawn'] {
      let call = 0;
      return async (spec) => {
        const step = steps[Math.min(call, steps.length - 1)] ?? {
          rotate: false,
        };
        call += 1;
        if (step.rotate) {
          await writeFile(
            path.join(spec.env.CODEX_HOME ?? '', 'auth.json'),
            JSON.stringify({ tokens: { access_token: fresh } }),
          );
        }
        if (step.fail !== undefined) {
          return {
            started: true,
            exitCode: 1,
            signal: null,
            stdout: `${JSON.stringify({ type: 'turn.failed', error: { message: step.fail } })}\n`,
            stderr: '',
            timedOut: false,
            outputLimitExceeded: false,
            durationMs: 1,
          };
        }
        const answer = step.answer ?? 'A clean report.';
        await writeFile(
          spec.args[spec.args.indexOf('-o') + 1] ?? '',
          JSON.stringify({
            summary: answer,
            report: { title: 'T', markdown: answer },
          }),
        );
        return {
          started: true,
          exitCode: 0,
          signal: null,
          stdout: `${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`,
          stderr: '',
          timedOut: false,
          outputLimitExceeded: false,
          durationMs: 1,
        };
      };
    }

    it('rejects an answer that echoes a token the harness refreshed mid-run', async () => {
      const summary = await runAgent(await loginOptions(), {
        harness: {
          spawn: codexSpawn([{ rotate: true, answer: `token ${fresh}` }]),
        },
      });
      expect(summary.ok && summary.value.error?.code).toBe('E_SECRET_COPY');
      const text = await writtenOutputs(summary);
      expect(text).not.toContain(fresh);
      expect(text).not.toContain(seed);
    });

    it('accepts a clean answer after a refresh (control)', async () => {
      const summary = await runAgent(await loginOptions(), {
        harness: { spawn: codexSpawn([{ rotate: true }]) },
      });
      expect(summary.ok && summary.value.result.ok).toBe(true);
      expect(summary.ok && summary.value.error).toBeUndefined();
    });

    it('redacts an earlier log record once a later refresh reveals its token', async () => {
      const summary = await runAgent(
        { ...(await loginOptions()), maxAttempts: 2 },
        {
          harness: {
            spawn: codexSpawn([
              { rotate: false, fail: `503 overloaded while using ${fresh}` },
              { rotate: true },
            ]),
          },
          sleep: async () => undefined,
        },
      );
      expect(summary.ok && summary.value.attempts).toBe(2);
      const text = await writtenOutputs(summary);
      expect(text).not.toContain(fresh);
      expect(text).toContain('log record redacted');
    });
  });

  describe('home root placement', () => {
    async function gitWorkspace(): Promise<RunOptions> {
      const opts = await options({ model: 'codex-login', seedLogin: true });
      execFileSync('git', ['init', '-q'], { cwd: opts.cwd, stdio: 'ignore' });
      const operatorHome = `${opts.cwd}-operator`;
      await mkdir(path.join(operatorHome, '.codex'), { recursive: true });
      await writeFile(
        path.join(operatorHome, '.codex', 'auth.json'),
        // Shape only; no token-like key, so secret scanners stay quiet.
        JSON.stringify({ tokens: { placeholder: 'synthetic-placement-0019' } }),
      );
      return { ...opts, env: { PATH: process.env.PATH, HOME: operatorHome } };
    }

    it('refuses a home root inside the repository before creating or seeding it', async () => {
      const opts = await gitWorkspace();
      await mkdir(path.join(opts.cwd, 'sub'));
      for (const homeRoot of [
        path.join(opts.cwd, '.agent-home'),
        opts.cwd,
        path.join(opts.cwd, 'sub', 'deeper', 'home'),
      ]) {
        const summary = await runAgent({ ...opts, homeRoot });
        expect(summary, homeRoot).toMatchObject({
          ok: false,
          code: 'E_HOME_ROOT',
        });
      }
      expect(existsSync(path.join(opts.cwd, '.agent-home'))).toBe(false);
      expect(existsSync(path.join(opts.cwd, 'home'))).toBe(false);
      expect(existsSync(path.join(opts.cwd, 'sub', 'deeper'))).toBe(false);
    });

    it('refuses a home whose name starts with two dots inside the repository', async () => {
      const opts = await gitWorkspace();
      const homeRoot = path.join(opts.cwd, '..agent-home');
      expect(await runAgent({ ...opts, homeRoot })).toMatchObject({
        ok: false,
        code: 'E_HOME_ROOT',
      });
      expect(existsSync(homeRoot)).toBe(false);
    });

    it('refuses a home behind a dangling symlink that points into the repository', async () => {
      const opts = await gitWorkspace();
      const link = `${opts.cwd}-dangling`;
      await symlink(path.join(opts.cwd, '.not-yet'), link);
      expect(
        await runAgent({ ...opts, homeRoot: path.join(link, 'h') }),
      ).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
      expect(existsSync(path.join(opts.cwd, '.not-yet'))).toBe(false);
    });

    it('refuses to place a home when git cannot establish the repository boundary', async () => {
      const opts = await gitWorkspace();
      const sub = path.join(opts.cwd, 'sub');
      await mkdir(sub);
      const homeRoot = path.join(opts.cwd, '.agent-home');
      const summary = await runAgent(
        { ...opts, cwd: sub, homeRoot },
        { git: path.join(opts.cwd, 'missing-git') },
      );
      expect(summary).toMatchObject({ ok: false, code: 'E_WORKSPACE_STATUS' });
      expect(existsSync(homeRoot)).toBe(false);
    });

    it('refuses an external root whose home/.codex links into the repository, before seeding', async () => {
      const opts = await gitWorkspace();
      const homeRoot = `${opts.cwd}-ext-home`;
      const redirected = path.join(opts.cwd, 'redirected-login');
      await mkdir(redirected);
      await mkdir(path.join(homeRoot, 'home'), { recursive: true });
      await symlink(redirected, path.join(homeRoot, 'home', '.codex'));
      expect(await runAgent({ ...opts, homeRoot })).toMatchObject({
        ok: false,
        code: 'E_HOME_ROOT',
      });
      expect(existsSync(path.join(redirected, 'auth.json'))).toBe(false);
      expect(existsSync(path.join(redirected, 'config.toml'))).toBe(false);
    });

    it('refuses a kept root whose link reaches the repository through self/..', async () => {
      const opts = await gitWorkspace();
      const homeRoot = `${opts.cwd}-home`;
      await mkdir(path.join(homeRoot, 'home'), { recursive: true });
      await symlink(homeRoot, path.join(homeRoot, 'self'));
      await mkdir(path.join(opts.cwd, 'loc'));
      await symlink(
        `${homeRoot}/self/../${path.basename(opts.cwd)}/loc`,
        path.join(homeRoot, 'home', '.local'),
      );
      expect(await runAgent({ ...opts, homeRoot })).toMatchObject({
        ok: false,
        code: 'E_HOME_ROOT',
      });
      expect(readdirSync(path.join(opts.cwd, 'loc'))).toEqual([]);
    });

    it('refuses a case-variant link into a workspace inside the kept root (case-insensitive volumes)', async () => {
      const opts = await gitWorkspace();
      const parent = path.dirname(opts.cwd);
      await mkdir(path.join(parent, 'CaseProbe'));
      const insensitive = existsSync(path.join(parent, 'caseprobe'));
      if (!insensitive) return; // a different-case path is a different path here
      const homeRoot = `${opts.cwd}-outer`;
      const repo = path.join(homeRoot, 'Repo');
      await mkdir(path.join(repo, 'loc'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      await mkdir(path.join(homeRoot, 'home'), { recursive: true });
      await symlink(
        path.join(homeRoot, 'repo', 'loc'),
        path.join(homeRoot, 'home', '.local'),
      );
      expect(await runAgent({ ...opts, cwd: repo, homeRoot })).toMatchObject({
        ok: false,
        code: 'E_HOME_ROOT',
      });
      expect(readdirSync(path.join(repo, 'loc'))).toEqual([]);
    });

    it('refuses a home inside a non-git workspace reached with a case-variant cwd', async () => {
      const opts = await options({ model: 'codex-login', seedLogin: true });
      const parent = path.dirname(opts.cwd);
      const work = path.join(parent, `${path.basename(opts.cwd)}-Work`);
      await mkdir(work);
      const lower = path.join(parent, `${path.basename(opts.cwd)}-work`);
      if (!existsSync(lower)) return; // case-sensitive volume: cannot alias
      const operatorHome = `${opts.cwd}-operator`;
      await mkdir(path.join(operatorHome, '.codex'), { recursive: true });
      await writeFile(
        path.join(operatorHome, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { placeholder: 'synthetic-nongit-0027' } }),
      );
      const summary = await runAgent({
        ...opts,
        cwd: lower,
        homeRoot: path.join(work, 'h2'),
        env: { PATH: process.env.PATH, HOME: operatorHome },
      });
      expect(summary).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
      expect(existsSync(path.join(work, 'h2'))).toBe(false);
    });

    it('refuses a home root that reaches the repository through a symlink', async () => {
      const opts = await gitWorkspace();
      const link = `${opts.cwd}-link`;
      await symlink(opts.cwd, link);
      const summary = await runAgent({
        ...opts,
        homeRoot: path.join(link, 'h'),
      });
      expect(summary).toMatchObject({ ok: false, code: 'E_HOME_ROOT' });
      expect(existsSync(path.join(opts.cwd, 'h'))).toBe(false);
    });

    it('accepts an external home and keeps login and invocation files out of changes', async () => {
      const opts = await gitWorkspace();
      const homeRoot = `${opts.cwd}-home`;
      const summary = await runAgent(
        { ...opts, homeRoot },
        {
          harness: {
            spawn: async (spec) => {
              await writeFile(
                spec.args[spec.args.indexOf('-o') + 1] ?? '',
                JSON.stringify({
                  summary: 'ok',
                  report: { title: 'T', markdown: 'M' },
                }),
              );
              return {
                started: true,
                exitCode: 0,
                signal: null,
                stdout: `${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`,
                stderr: '',
                timedOut: false,
                outputLimitExceeded: false,
                durationMs: 1,
              };
            },
          },
        },
      );
      expect(summary.ok && summary.value.result).toMatchObject({
        ok: true,
        status: 'no-op',
        changedFiles: [],
      });
      expect(
        existsSync(path.join(homeRoot, 'home', '.codex', 'auth.json')),
      ).toBe(true);
    });
  });

  describe('fail closed when the credential guard cannot be established', () => {
    const seed = 'synthetic-guard-seed-0022';
    const fresh = 'synthetic-guard-refreshed-0022';
    const seedPipe: PipeRunner = async () => ({
      fromExit: 0,
      toExit: 0,
      transferred: JSON.stringify([{ access: seed }]),
    });

    async function opencodeRun(loginExport: ExportRunner, answer: string) {
      const opts = await options({ model: 'grok-4.7', seedLogin: true });
      return runAgent(opts, {
        pipe: seedPipe,
        loginExport,
        harness: { spawn: async () => okProcess(opencodeAnswer(answer)) },
      });
    }

    it('refuses the answer when the OpenCode export fails, and writes no token anywhere', async () => {
      const failures: ExportRunner[] = [
        async () => ({ exitCode: 1, stdout: '' }),
        async () => ({ exitCode: null, stdout: '' }),
        async () => {
          throw new Error('spawn opencode ENOENT');
        },
        async () => ({ exitCode: 0, stdout: 'not json' }),
      ];
      for (const loginExport of failures) {
        const summary = await opencodeRun(loginExport, `leak ${fresh}`);
        expect(summary.ok && summary.value.error?.code).toBe('E_SECRET_GUARD');
        const text = await writtenOutputs(summary);
        expect(text).not.toContain(fresh);
        expect(text).not.toContain(seed);
        expect(summary.ok && summary.value.result).toMatchObject({
          ok: false,
          status: 'failed',
        });
      }
    });

    it('keeps the controls: a working export rejects an echoed token and accepts a clean answer', async () => {
      const working: ExportRunner = async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ access: fresh }]),
      });
      const echoed = await opencodeRun(working, `leak ${fresh}`);
      expect(echoed.ok && echoed.value.error?.code).toBe('E_SECRET_COPY');
      const clean = await opencodeRun(working, 'A clean report.');
      expect(clean.ok && clean.value.result.ok).toBe(true);
    });

    it('withholds earlier free-text log fields once the guard fails', async () => {
      const opts = await options({
        model: 'grok-4.7',
        seedLogin: true,
        maxAttempts: 2,
      });
      let call = 0;
      const summary = await runAgent(opts, {
        pipe: seedPipe,
        sleep: async () => undefined,
        loginExport: async () => {
          call += 1;
          return call === 1
            ? { exitCode: 0, stdout: '[]' }
            : { exitCode: 1, stdout: '' };
        },
        harness: {
          spawn: async () =>
            call === 0
              ? {
                  ...okProcess(''),
                  exitCode: 1,
                  stderr: `503 overloaded near ${fresh}`,
                }
              : okProcess(opencodeAnswer('clean')),
        },
      });
      expect(summary.ok && summary.value.error?.code).toBe('E_SECRET_GUARD');
      const text = await writtenOutputs(summary);
      expect(text).not.toContain(fresh);
      expect(text).toContain('[withheld: credential guard incomplete]');
    });

    it('fails closed when a Codex login store becomes unreadable or unparseable mid-run', async () => {
      const codexOptions = async () => {
        const opts = await options({ model: 'codex-login', seedLogin: true });
        const operatorHome = `${opts.cwd}-operator`;
        await mkdir(path.join(operatorHome, '.codex'), { recursive: true });
        await writeFile(
          path.join(operatorHome, '.codex', 'auth.json'),
          JSON.stringify({ tokens: { placeholder: seed } }),
        );
        return { ...opts, env: { PATH: process.env.PATH, HOME: operatorHome } };
      };
      const damage: ((file: string) => Promise<void>)[] = [
        async (file) => writeFile(file, '{ not json'),
        async (file) => {
          await rm(file);
          await mkdir(file);
        },
      ];
      for (const harm of damage) {
        const summary = await runAgent(await codexOptions(), {
          harness: {
            spawn: async (spec) => {
              await harm(path.join(spec.env.CODEX_HOME ?? '', 'auth.json'));
              await writeFile(
                spec.args[spec.args.indexOf('-o') + 1] ?? '',
                JSON.stringify({
                  summary: `leak ${fresh}`,
                  report: { title: 'T', markdown: 'M' },
                }),
              );
              return okProcess(
                `${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`,
              );
            },
          },
        });
        expect(summary.ok && summary.value.error?.code).toBe('E_SECRET_GUARD');
        expect(await writtenOutputs(summary)).not.toContain(fresh);
      }
    });

    it('refuses to seed login material it cannot parse or that holds no credential', async () => {
      for (const content of ['{ not json', JSON.stringify({ tokens: {} })]) {
        const opts = await options({ model: 'codex-login', seedLogin: true });
        const operatorHome = `${opts.cwd}-operator`;
        await mkdir(path.join(operatorHome, '.codex'), { recursive: true });
        await writeFile(
          path.join(operatorHome, '.codex', 'auth.json'),
          content,
        );
        const summary = await runAgent({
          ...opts,
          env: { PATH: process.env.PATH, HOME: operatorHome },
        });
        expect(summary).toMatchObject({ ok: false, code: 'E_SECRET_GUARD' });
        expect(existsSync(opts.outDir)).toBe(false);
      }
    });
  });

  describe('output directory inside the workspace', () => {
    it('refuses an output path that a workspace symlink redirects', async () => {
      const opts = await options({ model: 'fake-echo' });
      const elsewhere = `${opts.cwd}-elsewhere`;
      await mkdir(elsewhere);
      await symlink(elsewhere, path.join(opts.cwd, '.agent-ci'));
      for (const outDir of [
        path.join(opts.cwd, '.agent-ci'),
        path.join(opts.cwd, '.agent-ci', 'nested'),
      ]) {
        expect(await runAgent({ ...opts, outDir }), outDir).toMatchObject({
          ok: false,
          code: 'E_OUTPUT_PATH',
        });
      }
      expect(readdirSync(elsewhere)).toEqual([]);
    });

    it('replaces links at output file paths instead of writing through them', async () => {
      const opts = await options({ model: 'fake-echo' });
      const victim = `${opts.cwd}-victim.txt`;
      await writeFile(victim, 'untouched');
      await mkdir(opts.outDir, { recursive: true });
      for (const name of ['prompt.md', 'run-result.json', 'run-log.jsonl']) {
        await symlink(victim, path.join(opts.outDir, name));
      }
      const summary = await runAgent(opts);
      expect(summary.ok && summary.value.result.ok).toBe(true);
      expect(await readFile(victim, 'utf8')).toBe('untouched');
    });

    it('re-checks the output directory after the agent ran', async () => {
      const opts = await options({ model: 'fake-echo', mode: 'edit' });
      const elsewhere = `${opts.cwd}-swapped`;
      await mkdir(elsewhere);
      const summary = await runAgent(opts, {
        harness: {
          spawn: async () => {
            // The agent swaps the output directory for a link mid-run.
            await rm(opts.outDir, { recursive: true, force: true });
            await symlink(elsewhere, opts.outDir);
            return okProcess(
              `${JSON.stringify({
                type: 'result',
                is_error: false,
                result: JSON.stringify({
                  summary: 's',
                  report: { title: 'T', markdown: 'M' },
                }),
              })}\n`,
            );
          },
        },
      });
      expect(summary).toMatchObject({ ok: false, code: 'E_OUTPUT_PATH' });
      expect(readdirSync(elsewhere)).toEqual([]);
    });

    it('accepts an output directory outside the workspace (control)', async () => {
      const opts = await options({ model: 'fake-echo' });
      const outDir = `${opts.cwd}-out`;
      const summary = await runAgent({ ...opts, outDir });
      expect(summary.ok && summary.value.resultPath.startsWith(outDir)).toBe(
        true,
      );
    });
  });
});
