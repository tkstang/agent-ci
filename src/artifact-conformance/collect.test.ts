import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectConformanceReport,
  inspectConformanceClaims,
} from './collect.js';

const SHA = 'a'.repeat(40);
const REF = 'synthetic/probe/.github/workflows/caller.yml@refs/heads/probe';
const REQUEST_SECRET = 'synthetic-request-credential-do-not-export';
const DISCARDED_SECRET = 'synthetic-discarded-credential-do-not-export';
const CLAIMS = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'urn:agent-ci:artifact-conformance:v1',
  run_id: '101',
  run_attempt: '2',
  check_run_id: '303',
  repository_id: '404',
  repository_owner_id: '505',
  workflow_ref: REF,
  workflow_sha: SHA,
  job_workflow_ref:
    'synthetic/probe/.github/workflows/leaf.yml@refs/heads/probe',
  job_workflow_sha: SHA,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function token(changes: Record<string, unknown> = {}): string {
  return [
    Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ ...CLAIMS, ...changes })).toString(
      'base64url',
    ),
    Buffer.from('synthetic-not-a-signature').toString('base64url'),
  ].join('.');
}

async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-oidc-test-'));
  roots.push(root);
  const output = path.join(root, 'github-output');
  await writeFile(output, '', { mode: 0o600 });
  return {
    root,
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL:
        'https://pipelines.actions.githubusercontent.com/synthetic/idtoken?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_SECRET,
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: output,
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'tkstang/agent-ci',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_RUN_ID: '101',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_REPOSITORY_ID: '404',
      GITHUB_REPOSITORY_OWNER_ID: '505',
      GITHUB_JOB: 'capture',
      GITHUB_WORKFLOW_REF: REF,
      GITHUB_WORKFLOW_SHA: SHA,
      CONFORMANCE_SCOPE: 'scope-a',
      CONFORMANCE_ROLE: 'producer',
    },
  };
}

describe('synthetic OIDC conformance capture', () => {
  it('persists only allowlisted diagnostics in private staging and exports distinct artifact selectors', async () => {
    const { root, env } = await runtime();
    const jwt = token({
      sub: DISCARDED_SECRET,
      arbitrary_claim: DISCARDED_SECRET,
      nested: { credential: DISCARDED_SECRET },
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ value: jwt, credential: DISCARDED_SECRET }),
      );
    const result = await collectConformanceReport(env, request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected capture');
    const text = await readFile(result.value.reportPath, 'utf8');
    expect(JSON.parse(text)).toEqual({
      version: 1,
      diagnostic_only: true,
      signature_verified: false,
      selectors_are_grants: false,
      selector: { scope: 'scope-a', role: 'producer' },
      context: { event_name: 'workflow_dispatch', job_id: 'capture' },
      claims: CLAIMS,
    });
    for (const secret of [
      jwt,
      REQUEST_SECRET,
      DISCARDED_SECRET,
      env.ACTIONS_ID_TOKEN_REQUEST_URL,
    ])
      expect(text).not.toContain(secret);
    expect((await stat(result.value.reportPath)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(path.dirname(result.value.reportPath))).mode & 0o777,
    ).toBe(0o700);
    expect(result.value.artifactName).toBe('oidc-scope-a-producer-2-303');
    expect(await readFile(env.GITHUB_OUTPUT, 'utf8')).toBe(
      `report_path=${result.value.reportPath}\nartifact_name=oidc-scope-a-producer-2-303\n`,
    );
    const call = request.mock.calls[0];
    expect(call?.[0]).toBeInstanceOf(URL);
    expect(String(call?.[0])).toContain(
      'audience=urn%3Aagent-ci%3Aartifact-conformance%3Av1',
    );
    expect(call?.[1]?.redirect).toBe('manual');
    expect(call?.[1]?.headers).toEqual({
      Authorization: `Bearer ${REQUEST_SECRET}`,
    });
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(await readdir(root)).toHaveLength(2);
  });

  it('keeps repeated scope/role captures separate using each check-run identity', async () => {
    const { env } = await runtime();
    const a = await collectConformanceReport(
      env,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ value: token() })),
    );
    const b = await collectConformanceReport(
      env,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ value: token({ check_run_id: '304' }) }),
        ),
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.artifactName).not.toBe(b.value.artifactName);
      expect(a.value.reportPath).not.toBe(b.value.reportPath);
    }
  });

  it.each([4097, 16384])(
    'passes a synthetic %i-character request credential unchanged without persisting it',
    async (length) => {
      const { root, env } = await runtime();
      const credential = 'x'.repeat(length);
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ value: token() }));
      const result = await collectConformanceReport(
        { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: credential },
        request,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected capture');
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[1]?.headers).toEqual({
        Authorization: `Bearer ${credential}`,
      });
      expect(await readFile(result.value.reportPath, 'utf8')).not.toContain(
        credential,
      );
      expect(await readFile(env.GITHUB_OUTPUT, 'utf8')).not.toContain(
        credential,
      );
      expect(await readdir(root)).toHaveLength(2);
    },
  );

  it.each([
    { check_run_id: undefined },
    { check_run_id: '000303' },
    { check_run_id: 9007199254740992 },
    { run_id: '102' },
    { run_attempt: '1' },
    { repository_id: '405' },
    { repository_owner_id: '506' },
    { workflow_sha: 'b'.repeat(40) },
    {
      workflow_ref:
        'synthetic/probe/.github/workflows/other.yml@refs/heads/probe',
    },
    { job_workflow_sha: 'not-a-sha' },
    { job_workflow_ref: 'https://outside.invalid/credential' },
    { aud: ['urn:agent-ci:artifact-conformance:v1'] },
    { iss: 'https://outside.invalid' },
  ])(
    'refuses missing, malformed or mismatched claims without producing a report: %j',
    async (changes) => {
      const { root, env } = await runtime();
      const result = await collectConformanceReport(
        env,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ value: token(changes), secret: DISCARDED_SECRET }),
          ),
      );
      expect(result).toEqual({ ok: false, code: 'E_GITHUB_API' });
      expect(await readdir(root)).toEqual(['github-output']);
      expect(await readFile(env.GITHUB_OUTPUT, 'utf8')).toBe('');
    },
  );

  it.each([
    [
      'http://pipelines.actions.githubusercontent.com/idtoken',
      'request_protocol_refused',
    ],
    [
      'https://pipelines.actions.githubusercontent.com.outside.invalid/idtoken',
      'request_host_refused',
    ],
    ['https://outside.invalid/idtoken', 'request_host_refused'],
    [
      'https://user:credential@pipelines.actions.githubusercontent.com/idtoken',
      'request_userinfo_refused',
    ],
    [
      'https://pipelines.actions.githubusercontent.com:444/idtoken',
      'request_port_refused',
    ],
    [
      'https://pipelines.actions.githubusercontent.com/idtoken#fragment',
      'request_fragment_refused',
    ],
  ])(
    'refuses an untrusted credential destination before HTTP: %s',
    async (url, reason) => {
      const { root, env } = await runtime();
      const request = vi.fn<typeof fetch>();
      expect(
        await collectConformanceReport(
          { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: url },
          request,
        ),
      ).toEqual({ ok: false, code: 'E_INVALID_INPUT', reason });
      expect(request).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual(['github-output']);
      expect(await readFile(env.GITHUB_OUTPUT, 'utf8')).toBe('');
    },
  );

  it.each([
    ['ACTIONS_ID_TOKEN_REQUEST_URL', undefined, 'request_url_missing'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', 'x'.repeat(4097), 'request_url_too_long'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', DISCARDED_SECRET, 'request_url_invalid'],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', undefined, 'request_credential_missing'],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', '', 'request_credential_missing'],
    [
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'x'.repeat(16385),
      'request_credential_too_long',
    ],
    [
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      `${REQUEST_SECRET}\n`,
      'request_credential_line_break',
    ],
    [
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      `${REQUEST_SECRET}\r`,
      'request_credential_line_break',
    ],
    ['RUNNER_TEMP', undefined, 'runner_temp_invalid'],
    ['RUNNER_TEMP', DISCARDED_SECRET, 'runner_temp_invalid'],
    ['GITHUB_OUTPUT', undefined, 'github_output_invalid'],
    ['GITHUB_OUTPUT', DISCARDED_SECRET, 'github_output_invalid'],
  ] as const)(
    'reports only a fixed preflight reason for %s (%#)',
    async (key, value, reason) => {
      const { root, env } = await runtime();
      const request = vi.fn<typeof fetch>();
      const result = await collectConformanceReport(
        { ...env, [key]: value },
        request,
      );
      expect(result).toEqual({ ok: false, code: 'E_INVALID_INPUT', reason });
      for (const secret of [
        REQUEST_SECRET,
        DISCARDED_SECRET,
        env.ACTIONS_ID_TOKEN_REQUEST_URL,
      ])
        expect(JSON.stringify(result)).not.toContain(secret);
      expect(request).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual(['github-output']);
      expect(await readFile(env.GITHUB_OUTPUT, 'utf8')).toBe('');
    },
  );

  it.each([302, 401, 500])(
    'discards non-success HTTP bodies without following redirects: %i',
    async (status) => {
      const { root, env } = await runtime();
      const result = await collectConformanceReport(
        env,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(DISCARDED_SECRET, { status })),
      );
      expect(result).toEqual({ ok: false, code: 'E_GITHUB_API' });
      expect(await readdir(root)).toEqual(['github-output']);
    },
  );

  it('bounds a streamed body even when content-length is absent', async () => {
    const { root, env } = await runtime();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(32 * 1024 + 1)));
    expect(await collectConformanceReport(env, request)).toEqual({
      ok: false,
      code: 'E_GITHUB_API',
    });
    expect(await readdir(root)).toEqual(['github-output']);
  });

  it.each([
    'not-json',
    JSON.stringify({ value: 'not-a-jwt' }),
    JSON.stringify({ value: token({ large: 'x'.repeat(25 * 1024) }) }),
  ])(
    'refuses malformed or over-limit envelopes without persisting them',
    async (body) => {
      const { root, env } = await runtime();
      expect(
        await collectConformanceReport(
          env,
          vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
        ),
      ).toEqual({ ok: false, code: 'E_GITHUB_API' });
      expect(await readdir(root)).toEqual(['github-output']);
    },
  );

  it('discards exception text and removes staging if output publication fails', async () => {
    const { root, env } = await runtime();
    const thrown = await collectConformanceReport(
      env,
      vi.fn<typeof fetch>().mockRejectedValue(new Error(DISCARDED_SECRET)),
    );
    expect(thrown).toEqual({ ok: false, code: 'E_GITHUB_API' });
    const failed = await collectConformanceReport(
      { ...env, GITHUB_OUTPUT: root },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ value: token() })),
    );
    expect(failed).toEqual({ ok: false, code: 'E_OUTPUT_PATH' });
    expect(await readdir(root)).toEqual(['github-output']);
  });

  it('does not accept non-synthetic selectors or non-manual runtime context', async () => {
    const { env } = await runtime();
    expect(
      inspectConformanceClaims(token(), {
        ...env,
        CONFORMANCE_SCOPE: 'private-target',
      }),
    ).toBeUndefined();
    expect(
      inspectConformanceClaims(token(), {
        ...env,
        GITHUB_REPOSITORY: 'synthetic/other-caller',
      }),
    ).toBeUndefined();
    expect(
      inspectConformanceClaims(token(), {
        ...env,
        CONFORMANCE_ROLE: 'adjudicator',
      }),
    ).toBeUndefined();
    expect(
      inspectConformanceClaims(token(), {
        ...env,
        GITHUB_EVENT_NAME: 'pull_request',
      }),
    ).toBeUndefined();
  });

  it('runs dependency-free from sparse source and reports only a fixed refusal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-oidc-sparse-'));
    roots.push(root);
    const script = path.join(root, 'collect.ts');
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      script,
      await readFile(
        fileURLToPath(new URL('./collect.ts', import.meta.url)),
        'utf8',
      ),
    );
    const { env } = await runtime();
    for (const [runtimeEnv, reason] of [
      [{}, 'request_url_missing'],
      [
        { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: DISCARDED_SECRET },
        'request_url_invalid',
      ],
      [
        { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x'.repeat(16385) },
        'request_credential_too_long',
      ],
    ] as const) {
      try {
        execFileSync(process.execPath, [script], {
          env: runtimeEnv,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        throw new Error('expected refusal');
      } catch (error) {
        const result = error as {
          status?: number;
          stdout?: string;
          stderr?: string;
        };
        expect(result.status).toBe(1);
        expect(result.stdout).toBe(
          `${JSON.stringify({ ok: false, code: 'E_INVALID_INPUT', reason })}\n`,
        );
        expect(result.stderr).toBe('');
      }
    }
  });
});
