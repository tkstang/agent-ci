import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import {
  appendGithubOutput,
  appendGithubPath,
} from '@agent-ci/commands/github.js';
import { parseModelsFile } from '@agent-ci/routing/resolve.js';
import {
  CREDENTIAL_TRANSPORT_ENV,
  mapTransportCredential,
  runAgent,
} from '@agent-ci/run/execute.js';
import { describe, expect, it } from 'vitest';

const SYNTHETIC = 'synthetic-transport-value-0099';

const MODELS = `version: 1
routes:
  - id: claude-pool
    model: claude-x
    harness: claude
    family: claude
    providerModel: claude-x-1
    credentials: [ANTHROPIC_AUTH_TOKEN]
    billing: subscription
    account: pool
    structuredOutput: json-schema
    qualified: null
  - id: claude-personal
    model: claude-x
    harness: claude
    family: claude
    providerModel: claude-x-1
    credentials: [CLAUDE_CODE_OAUTH_TOKEN]
    billing: subscription
    account: personal
    structuredOutput: json-schema
    qualified: null
  - id: two-keys
    model: two-keys
    harness: opencode
    family: other
    providerModel: p/m
    credentials: [OPENCODE_API_KEY, CURSOR_API_KEY]
    billing: subscription
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-keyed
    model: fake-keyed
    harness: fake
    family: fake
    providerModel: echo
    credentials: [CURSOR_API_KEY]
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: codex-pool
    model: codex-pool-model
    harness: codex
    family: openai
    providerModel: gpt-x
    credentials: [AGENT_CI_PROXY_API_KEY]
    baseUrl: http://127.0.0.1:8317/v1
    billing: subscription
    account: pool
    structuredOutput: output-schema
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
`;

async function setup(): Promise<{
  dir: string;
  models: string;
  output: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-route-'));
  const models = path.join(dir, 'models.yaml');
  await writeFile(models, MODELS);
  const output = path.join(dir, 'github-output');
  await writeFile(output, '');
  return { dir, models, output };
}

const ctx = (dir: string, env: Record<string, string>) => ({
  cwd: dir,
  env: { PATH: process.env.PATH, ...env },
  log: () => undefined,
});

describe('agent-ci route', () => {
  it('resolves the CI route without its credential and writes step outputs', async () => {
    const { dir, models, output } = await setup();
    const { envelope, exitCode } = await run(
      ['route', '--model', 'claude-x', '--models', models, '--github-output'],
      ctx(dir, { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output }),
    );
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        route: {
          id: 'claude-personal',
          credentials: ['CLAUDE_CODE_OAUTH_TOKEN'],
        },
        skipped: [{ id: 'claude-pool', code: 'E_POLICY_POOL_CI' }],
      },
    });
    expect(await readFile(output, 'utf8')).toBe(
      [
        'route_id=claude-personal',
        'model=claude-x',
        'harness=claude',
        'account=personal',
        'billing=subscription',
        'credential=CLAUDE_CODE_OAUTH_TOKEN',
        '',
      ].join('\n'),
    );
  });

  it('writes an empty credential for the fake harness', async () => {
    const { dir, models, output } = await setup();
    await run(
      ['route', '--model', 'fake-echo', '--models', models, '--github-output'],
      ctx(dir, { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output }),
    );
    expect(await readFile(output, 'utf8')).toContain('credential=\n');
  });

  it('keeps every policy refusal (pool in CI, pinned pool route)', async () => {
    const { dir, models } = await setup();
    const pinned = await run(
      ['route', '--route', 'claude-pool', '--models', models, '--allow-pool'],
      ctx(dir, { CI: '1' }),
    );
    expect(pinned.envelope).toMatchObject({
      ok: false,
      code: 'E_POLICY_POOL_CI',
    });
  });

  it('refuses a multi-credential route for a workflow and needs GITHUB_OUTPUT', async () => {
    const { dir, models, output } = await setup();
    const multi = await run(
      ['route', '--model', 'two-keys', '--models', models, '--github-output'],
      ctx(dir, { GITHUB_OUTPUT: output }),
    );
    expect(multi.envelope).toMatchObject({ ok: false, code: 'E_ROUTE_CONFIG' });
    // Only the four statically selectable model secrets reach a workflow.
    const unlisted = await run(
      [
        'route',
        '--route',
        'claude-pool',
        '--allow-pool',
        '--models',
        models,
        '--github-output',
      ],
      ctx(dir, { GITHUB_OUTPUT: output }),
    );
    expect(unlisted.envelope).toMatchObject({
      ok: false,
      code: 'E_ROUTE_CONFIG',
    });
    const unset = await run(
      ['route', '--model', 'fake-echo', '--models', models, '--github-output'],
      ctx(dir, {}),
    );
    expect(unset.envelope).toMatchObject({
      ok: false,
      code: 'E_INVALID_INPUT',
    });
  });

  it('never prints or writes the proxy origin override', async () => {
    const { dir, models, output } = await setup();
    const { envelope, exitCode } = await run(
      [
        'route',
        '--route',
        'codex-pool',
        '--allow-pool',
        '--models',
        models,
        '--github-output',
      ],
      ctx(dir, {
        GITHUB_OUTPUT: output,
        AGENT_CI_PROXY_BASE_URL: 'https://proxy.example.com',
      }),
    );
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      ok: true,
      data: { route: { id: 'codex-pool', account: 'pool' } },
    });
    expect(JSON.stringify(envelope)).not.toContain('proxy.example.com');
    const written = await readFile(output, 'utf8');
    expect(written).toContain('account=pool\n');
    expect(written).not.toContain('proxy.example.com');
  });
});

describe('route pool opt-in in workflows', () => {
  it('resolves a non-Claude pool route on a self-hosted runner with --allow-pool-value true only', async () => {
    const { dir, models, output } = await setup();
    const args = (value: string) => [
      'route',
      '--model',
      'codex-pool-model',
      '--allow-pool-value',
      value,
      '--models',
      models,
      '--github-output',
    ];
    const selfHosted = {
      GITHUB_OUTPUT: output,
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'self-hosted',
    };
    const allowed = await run(args('true'), ctx(dir, selfHosted));
    expect(allowed.exitCode).toBe(0);
    expect(await readFile(output, 'utf8')).toContain(
      'credential=AGENT_CI_PROXY_API_KEY\n',
    );
    for (const [value, env, code] of [
      ['', selfHosted, 'E_POLICY_POOL'],
      ['false', selfHosted, 'E_POLICY_POOL'],
      [
        'true',
        { ...selfHosted, RUNNER_ENVIRONMENT: 'github-hosted' },
        'E_POLICY_POOL_CI',
      ],
      ['yes', selfHosted, 'E_INVALID_INPUT'],
    ] as const) {
      const refused = await run(args(value), ctx(dir, env));
      expect(
        refused.envelope,
        `${value} ${env.RUNNER_ENVIRONMENT}`,
      ).toMatchObject({
        ok: false,
        code,
      });
    }
  });
});

describe('GitHub step files', () => {
  it('refuses multi-line values and keys that are not snake_case', async () => {
    const { output } = await setup();
    const env = { GITHUB_OUTPUT: output, GITHUB_PATH: output };
    await expect(
      appendGithubOutput(env, { key: 'a\nforged=1' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await expect(
      appendGithubOutput(env, { 'Bad-Key': 'x' }),
    ).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(appendGithubPath(env, '/a\n/b')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    expect(await readFile(output, 'utf8')).toBe('');
  });
});

describe('--credential-from-env', () => {
  const file = (() => {
    const parsed = parseModelsFile(MODELS);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.value;
  })();
  const request = { allowPool: false, seedLogin: false };

  it('moves the transport value to the route credential and drops the transport variable', () => {
    const mapped = mapTransportCredential(
      file,
      { ...request, model: 'fake-keyed' },
      { PATH: '/bin', [CREDENTIAL_TRANSPORT_ENV]: SYNTHETIC },
    );
    expect(mapped.ok && mapped.value).toEqual({
      PATH: '/bin',
      CURSOR_API_KEY: SYNTHETIC,
    });
  });

  it('treats an empty transport value as no credential', () => {
    const mapped = mapTransportCredential(
      file,
      { ...request, model: 'fake-echo' },
      { [CREDENTIAL_TRANSPORT_ENV]: '' },
    );
    expect(mapped.ok && mapped.value).toEqual({});
  });

  it('refuses a value for routes that do not name exactly one credential', () => {
    for (const model of ['fake-echo', 'two-keys']) {
      const mapped = mapTransportCredential(
        file,
        { ...request, model },
        { [CREDENTIAL_TRANSPORT_ENV]: SYNTHETIC },
      );
      expect(mapped.ok ? 'ok' : mapped.code).toBe('E_ROUTE_CONFIG');
    }
  });

  it('gives the harness exactly the mapped credential and keeps it out of outputs', async () => {
    const { dir, models } = await setup();
    const base = {
      model: 'fake-keyed',
      prompt: 'Report.',
      cwd: dir,
      outDir: path.join(dir, 'out'),
      outputContract: 'report' as const,
      useCase: 'generic-prompt',
      targetRepo: 'local/x',
      mode: 'read-only' as const,
      allowPool: false,
      seedLogin: false,
      timeoutMs: 60_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      modelsPath: models,
      env: { PATH: process.env.PATH, [CREDENTIAL_TRANSPORT_ENV]: SYNTHETIC },
    };
    const mapped = await runAgent({ ...base, credentialFromEnv: true });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.error).toBeUndefined();
    const report = JSON.stringify(mapped.value.result.report);
    expect(report).toContain('Credential-like variables visible: 1');
    const written =
      (await readFile(mapped.value.resultPath, 'utf8')) +
      (await readFile(mapped.value.logPath, 'utf8'));
    expect(written).not.toContain(SYNTHETIC);
    // Without the flag the transport variable is never a route credential.
    const unmapped = await runAgent(base);
    expect(unmapped.ok ? 'ok' : unmapped.code).toBe('E_CREDENTIAL_MISSING');
  });
});

describe('empty workflow inputs behave like absent flags', () => {
  it('accepts empty --harness and --route for route and run', async () => {
    const { dir, models } = await setup();
    const routed = await run(
      [
        'route',
        '--model',
        'fake-echo',
        '--harness',
        '',
        '--route',
        '',
        '--models',
        models,
      ],
      ctx(dir, {}),
    );
    expect(routed.envelope).toMatchObject({
      ok: true,
      data: { route: { id: 'fake-echo' } },
    });
    const ran = await run(
      [
        'run',
        '--model',
        'fake-echo',
        '--harness',
        '',
        '--route',
        '',
        '--models',
        models,
        '--prompt',
        'x',
        '--out',
        path.join(dir, 'o'),
      ],
      ctx(dir, {}),
    );
    expect(ran.envelope).toMatchObject({ ok: true });
  });

  it('validates --publish-pr', async () => {
    const { dir } = await setup();
    const bad = await run(
      [
        'publish',
        '--result-dir',
        dir,
        '--repo',
        'o/r',
        '--publish-pr',
        'maybe',
      ],
      ctx(dir, { GITHUB_TOKEN: 'x' }),
    );
    expect(bad.envelope).toMatchObject({ ok: false, code: 'E_INVALID_INPUT' });
  });
});
