import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import { createTargetsCommand } from '@agent-ci/commands/targets.js';
import { PACKAGE_ROOT } from '@agent-ci/paths.js';
import { parseModelsFile } from '@agent-ci/routing/resolve.js';
import { resolveTarget } from '@agent-ci/targets/resolve.js';
import {
  isRepository,
  MAX_TARGETS,
  parseTargetsFile,
  parseTargetsSources,
  type TargetsFile,
} from '@agent-ci/targets/schema.js';
import { selectTargets } from '@agent-ci/targets/select.js';
import { PRESET_NAMES } from '@agent-ci/use-cases/presets.js';
import { describe, expect, it } from 'vitest';

const MODELS = parseModelsFile(`version: 1
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
    model: claude-y
    harness: claude
    family: claude
    providerModel: claude-y-1
    credentials: [CLAUDE_CODE_OAUTH_TOKEN]
    billing: subscription
    account: personal
    structuredOutput: json-schema
    qualified: null
  - id: fake-edit
    model: fake-edit
    harness: fake
    family: fake
    providerModel: edit
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
`);
if (!MODELS.ok) throw new Error(MODELS.message);
const models = MODELS.value;

const YAML = `version: 1
allowedOwners: [octo]
defaults:
  base: main
  model: claude-y
targets:
  - id: widgets
    repository: octo/widgets
    inputs:
      setupCommand: pnpm install --frozen-lockfile
  - id: gadgets
    repository: Octo/Gadgets
    base: develop
    harness: claude
    useCases: [docs-update]
  - id: tools
    repository: octo/tools
    useCases: [tools-update]
    inputs:
      oatCliVersion: 0.3.33
      dependencyPolicy: include-lockfile
`;

function file(text = YAML): TargetsFile {
  const parsed = parseTargetsFile(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

const code = (result: { ok: boolean; code?: string }) =>
  result.ok ? 'ok' : result.code;

describe('targets.yaml', () => {
  it('accepts a valid file and validates repository names', () => {
    expect(file().targets).toHaveLength(3);
    expect(isRepository('octo/widgets.js')).toBe(true);
    for (const bad of [
      'octo',
      'octo/a/b',
      '-octo/x',
      'octo/..',
      'octo/.',
      'oc to/x',
      'octo/x$y',
      '',
    ]) {
      expect(isRepository(bad), bad).toBe(false);
    }
  });

  it('refuses malformed files', () => {
    for (const text of [
      'version: [',
      'version: 2\ntargets: [{id: a, repository: o/r}]',
      'version: 1\ntargets: []',
      'version: 1\ntargets: [{id: A_B, repository: o/r}]',
      'version: 1\ntargets: [{id: a, repository: o}]',
      'version: 1\ntargets: [{id: a, repository: o/r, base: "bad..branch"}]',
      'version: 1\ntargets: [{id: a, repository: o/r, extra: 1}]',
      'version: 1\ntargets: [{id: a, repository: o/r, model: "a b"}]',
      'version: 1\ntargets: [{id: a, repository: o/r, harness: other}]',
      'version: 1\ntargets: [{id: a, repository: o/r, useCases: [deploy]}]',
      'version: 1\ntargets: [{id: a, repository: o/r, inputs: {publishBranch: main}}]',
      'version: 1\ntargets: [{id: a, repository: o/r, inputs: {oatCliVersion: "file:../x"}}]',
      'version: 1\ntargets: [{id: a, repository: o/r, inputs: {prTitle: "a\\nb"}}]',
      'version: 1\ntargets: [{id: a, repository: o/r, inputs: {timeoutMinutes: 0}}]',
    ]) {
      expect(code(parseTargetsFile(text)), text).toBe('E_TARGETS_CONFIG');
    }
  });

  it('refuses duplicate ids, duplicate repositories (any case) and owners outside the allowlist', () => {
    const dupId =
      'version: 1\ntargets: [{id: a, repository: o/r}, {id: a, repository: o/s}]';
    const dupRepo =
      'version: 1\ntargets: [{id: a, repository: o/r}, {id: b, repository: O/R}]';
    const owner =
      'version: 1\nallowedOwners: [octo]\ntargets: [{id: a, repository: evil/r}]';
    for (const text of [dupId, dupRepo, owner]) {
      const parsed = parseTargetsFile(text);
      expect(code(parsed), text).toBe('E_TARGETS_CONFIG');
    }
  });

  it(`refuses more than ${MAX_TARGETS} targets`, () => {
    const targets = Array.from(
      { length: MAX_TARGETS + 1 },
      (_, index) => `  - {id: t${index}, repository: o/r${index}}`,
    );
    const text = `version: 1\ndefaults: {base: main}\ntargets:\n${targets.join('\n')}\n`;
    expect(code(parseTargetsFile(text))).toBe('E_TARGETS_CONFIG');
  });
});

describe('merged targets sources', () => {
  it('validates shared policy and uniqueness across sources before selection', () => {
    for (const [addition, message] of [
      [{ id: 'widgets', repository: 'octo/other' }, 'duplicate target id'],
      [
        { id: 'other', repository: 'OCTO/WIDGETS' },
        'duplicate target repository',
      ],
      [{ id: 'other', repository: 'outside/repo' }, 'outside allowedOwners'],
      [{ id: 'other', repository: 'octo/other', base: 42 }, 'targets.3.base'],
      [
        { id: 'other', repository: 'octo/other', extra: true },
        'Unrecognized key',
      ],
    ] as const) {
      const parsed = parseTargetsSources(YAML, JSON.stringify([addition]));
      expect(parsed).toMatchObject({ ok: false, code: 'E_TARGETS_CONFIG' });
      if (!parsed.ok) expect(parsed.message).toContain(message);
    }
    // JSON additions cannot replace malformed policy, version or target fields.
    for (const yaml of [
      'version: 2\ntargets: []',
      'version: 1\nallowedOwners: octo\ntargets: []',
      'version: 1\ndefaults: {base: 42}\ntargets: []',
      'version: 1\ntargets: {}',
      'version: 1\nextra: true\ntargets: []',
    ]) {
      expect(
        code(parseTargetsSources(yaml, '[{"id":"a","repository":"octo/a"}]')),
        yaml,
      ).toBe('E_TARGETS_CONFIG');
    }
  });

  it('requires bounded JSON arrays and checks UTF-8 bytes before parsing', () => {
    for (const json of ['[', 'targets: []', '{}', 'null', 'true', '"[]"']) {
      expect(code(parseTargetsSources(YAML, json)), json).toBe(
        'E_TARGETS_CONFIG',
      );
    }
    const oversized = `[${'é'.repeat(128 * 1024)}`;
    const parsed = parseTargetsSources(YAML, oversized);
    expect(parsed).toMatchObject({ ok: false, code: 'E_TARGETS_CONFIG' });
    if (!parsed.ok) expect(parsed.message).toContain('exceeds 262144 bytes');
    expect(code(parseTargetsSources(YAML, ' '.repeat(256 * 1024)))).toBe('ok');
  });

  it('accepts policy-only YAML only when additions make the combined list non-empty', () => {
    const policy =
      'version: 1\nallowedOwners: [octo]\ndefaults: {base: main}\ntargets: []';
    const added = parseTargetsSources(
      policy,
      '[{"id":"a","repository":"octo/a"}]',
    );
    expect(added).toMatchObject({
      ok: true,
      value: {
        version: 1,
        allowedOwners: ['octo'],
        defaults: { base: 'main' },
        targets: [{ id: 'a' }],
      },
    });
    expect(code(parseTargetsFile(policy))).toBe('E_TARGETS_CONFIG');
    for (const json of [undefined, '', ' \n\t ', '[]']) {
      expect(code(parseTargetsSources(policy, json))).toBe('E_TARGETS_CONFIG');
      expect(code(parseTargetsSources(undefined, json))).toBe(
        'E_TARGETS_CONFIG',
      );
      expect(parseTargetsSources(YAML, json)).toEqual(parseTargetsFile(YAML));
    }
  });
});

describe('selectTargets', () => {
  const env = {};

  it('selects every participating target for a preset, with resolved inputs', () => {
    const selected = selectTargets(file(), {
      preset: 'docs-update',
      models,
      env,
    });
    if (!selected.ok) throw new Error(selected.message);
    expect(selected.value.map((entry) => entry.id)).toEqual([
      'widgets',
      'gadgets',
    ]);
    expect(selected.value[0]).toMatchObject({
      repository: 'octo/widgets',
      base: 'main',
      preset: 'docs-update',
      use_case: 'oat-docs-update',
      model: 'claude-y',
      mode: 'edit',
      output_contract: 'changes',
      skills_oat_packs: 'core,docs',
      setup_command: 'pnpm install --frozen-lockfile',
      publish_branch: 'agent-ci/oat-docs-update',
      path_policy: 'docs-update',
      artifact_name: 'agent-ci-widgets',
      adopt_branch: false,
    });
    expect(selected.value[1]).toMatchObject({
      base: 'develop',
      harness: 'claude',
    });
  });

  it('selects one target by id or repository (any case) and refuses unknown or non-participating ones', () => {
    for (const target of ['gadgets', 'octo/gadgets']) {
      const one = selectTargets(file(), {
        preset: 'docs-update',
        target,
        models,
        env,
      });
      expect(one.ok && one.value.map((entry) => entry.id)).toEqual(['gadgets']);
    }
    expect(
      code(
        selectTargets(file(), {
          preset: 'docs-update',
          target: 'nope',
          models,
          env,
        }),
      ),
    ).toBe('E_TARGET_NOT_FOUND');
    expect(
      code(
        selectTargets(file(), {
          preset: 'instructions-update',
          target: 'gadgets',
          models,
          env,
        }),
      ),
    ).toBe('E_TARGET_NOT_FOUND');
  });

  it('allows the reset flag for one target only', () => {
    expect(
      code(
        selectTargets(file(), {
          preset: 'docs-update',
          reset: true,
          models,
          env,
        }),
      ),
    ).toBe('E_TARGETS_RESET_ALL');
    const one = selectTargets(file(), {
      preset: 'docs-update',
      target: 'widgets',
      reset: true,
      models,
      env,
    });
    expect(one.ok && one.value[0]?.adopt_branch).toBe(true);
  });

  it('enforces the matrix bound', () => {
    const bounded = selectTargets(file(), {
      preset: 'docs-update',
      maxTargets: 1,
      models,
      env,
    });
    expect(code(bounded)).toBe('E_TARGETS_LIMIT');
    for (const maxTargets of [0, MAX_TARGETS + 1, 1.5]) {
      expect(
        code(
          selectTargets(file(), {
            preset: 'docs-update',
            maxTargets,
            models,
            env,
          }),
        ),
      ).toBe('E_INVALID_INPUT');
    }
  });

  it('resolves models under the CI routing policy and applies overrides', () => {
    const pool = file(YAML.replace('model: claude-y', 'model: claude-x'));
    expect(
      code(
        selectTargets(pool, {
          preset: 'docs-update',
          models,
          env: { CI: 'true' },
        }),
      ),
    ).toBe('E_TARGETS_CONFIG');
    const unknown = file(YAML.replace('model: claude-y', 'model: nope'));
    expect(
      code(selectTargets(unknown, { preset: 'docs-update', models, env })),
    ).toBe('E_TARGETS_CONFIG');
    // A model override replaces harness and route pins; a base override applies to all.
    const overridden = selectTargets(file(), {
      preset: 'docs-update',
      model: 'fake-edit',
      base: 'feat/x',
      models,
      env,
    });
    if (!overridden.ok) throw new Error(overridden.message);
    for (const entry of overridden.value) {
      expect(entry).toMatchObject({
        model: 'fake-edit',
        harness: '',
        route: '',
        base: 'feat/x',
      });
    }
    expect(
      code(
        selectTargets(file(), {
          preset: 'docs-update',
          base: 'a..b',
          models,
          env,
        }),
      ),
    ).toBe('E_INVALID_INPUT');
  });

  it('gives deterministic tools-update entries no model and the lockfile policy when asked', () => {
    const tools = selectTargets(file(), {
      preset: 'tools-update',
      models,
      env,
    });
    if (!tools.ok) throw new Error(tools.message);
    expect(tools.value).toHaveLength(2);
    const entry = tools.value.find((item) => item.id === 'tools');
    expect(entry).toMatchObject({
      model: '',
      skills_oat_packs: '',
      oat_cli_version: '0.3.33',
      dependency_policy: 'include-lockfile',
      path_policy: 'tools-update-lockfile',
      publish_branch: 'agent-ci/oat-tools-update',
    });
  });

  it('needs a base and a model for every agent target', () => {
    const noBase = file(
      'version: 1\ntargets: [{id: a, repository: o/r, model: claude-y}]',
    );
    expect(
      code(selectTargets(noBase, { preset: 'docs-update', models, env })),
    ).toBe('E_TARGETS_CONFIG');
    const noModel = file(
      'version: 1\ntargets: [{id: a, repository: o/r, base: main}]',
    );
    expect(
      code(selectTargets(noModel, { preset: 'docs-update', models, env })),
    ).toBe('E_TARGETS_CONFIG');
    expect(
      code(selectTargets(noModel, { preset: 'tools-update', models, env })),
    ).toBe('ok');
  });
});

interface Call {
  url: string;
  auth: string | null;
}

function fakeFetch(
  repos: Record<
    string,
    { full_name: string; default_branch: string; private?: boolean }
  >,
  commits: Record<string, string>,
  deniedToken?: string,
  behavior: {
    /** Tokens allowed to write (dry-run ref creation answers 422). */
    writers?: readonly string[];
    /** Classic-token scopes reported per token. */
    scopes?: Readonly<Record<string, string>>;
    /** Dry-run probe responses per token (default: a permission denial). */
    probe?: Readonly<
      Record<
        string,
        {
          status: number;
          headers?: Record<string, string>;
          message: string;
        }
      >
    >;
  } = {},
) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const headers = new Headers(init?.headers);
    calls.push({ url: text, auth: headers.get('authorization') });
    const token = (headers.get('authorization') ?? '').replace('Bearer ', '');
    if (token === deniedToken) {
      return new Response('{}', { status: 404 });
    }
    if (init?.method === 'POST' && text.endsWith('/git/refs')) {
      const custom = behavior.probe?.[token];
      if (custom !== undefined) {
        return new Response(JSON.stringify({ message: custom.message }), {
          status: custom.status,
          headers: custom.headers ?? {},
        });
      }
      return behavior.writers?.includes(token) === true
        ? new Response(JSON.stringify({ message: 'Object does not exist' }), {
            status: 422,
          })
        : new Response(
            JSON.stringify({
              message: 'Resource not accessible by personal access token',
            }),
            { status: 403 },
          );
    }
    const repo = /\/repos\/([^/]+\/[^/]+)$/u.exec(text);
    if (repo !== null) {
      const found = repos[(repo[1] ?? '').toLowerCase()];
      const scopes = behavior.scopes?.[token];
      return found === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(found), {
            status: 200,
            headers: scopes === undefined ? {} : { 'x-oauth-scopes': scopes },
          });
    }
    const commit = /\/commits\/(.+)$/u.exec(text);
    const sha = commits[decodeURIComponent(commit?.[1] ?? '')];
    return sha === undefined
      ? new Response('{}', { status: 422 })
      : new Response(JSON.stringify({ sha }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPOS = {
  'octo/caller': { full_name: 'octo/caller', default_branch: 'main' },
  'octo/widgets': {
    full_name: 'octo/widgets',
    default_branch: 'trunk',
    private: false,
  },
  'octo/secret': {
    full_name: 'octo/secret',
    default_branch: 'main',
    private: true,
  },
};

describe('resolveTarget', () => {
  it('keeps the calling repository behavior: event defaults and GITHUB_TOKEN only', async () => {
    const { impl, calls } = fakeFetch(REPOS, { [SHA_A]: SHA_A });
    const resolved = await resolveTarget({
      callingRepository: 'octo/caller',
      eventRef: SHA_A,
      eventBase: 'feature/x',
      eventPr: '12',
      githubToken: 'gh-token',
      targetToken: 'target-token',
      fetch: impl,
    });
    expect(resolved.ok && resolved.value).toEqual({
      repository: 'octo/caller',
      cross: false,
      sha: SHA_A,
      base: 'feature/x',
      commentPr: '12',
      defaultBranch: 'main',
    });
    expect(calls.every((call) => call.auth === 'Bearer gh-token')).toBe(true);
  });

  it('treats a differently cased calling repository as the calling repository', async () => {
    const { impl, calls } = fakeFetch(REPOS, { [SHA_A]: SHA_A });
    const resolved = await resolveTarget({
      repository: 'Octo/Caller',
      callingRepository: 'octo/caller',
      eventRef: SHA_A,
      githubToken: 'gh-token',
      fetch: impl,
    });
    expect(resolved.ok && resolved.value.cross).toBe(false);
    expect(calls.every((call) => call.auth === 'Bearer gh-token')).toBe(true);
  });

  it('reaches another repository only with the target token and never applies event values to it', async () => {
    const { impl, calls } = fakeFetch(REPOS, { trunk: SHA_B, [SHA_A]: SHA_A });
    const resolved = await resolveTarget({
      repository: 'octo/widgets',
      callingRepository: 'octo/caller',
      eventRef: SHA_A,
      eventBase: 'feature/x',
      eventPr: '12',
      githubToken: 'gh-token',
      targetToken: 'target-token',
      fetch: impl,
    });
    expect(resolved.ok && resolved.value).toEqual({
      repository: 'octo/widgets',
      cross: true,
      sha: SHA_B,
      base: 'trunk',
      commentPr: '',
      defaultBranch: 'trunk',
    });
    expect(calls.every((call) => call.auth === 'Bearer target-token')).toBe(
      true,
    );
    expect(calls.some((call) => call.url.includes('/commits/trunk'))).toBe(
      true,
    );
  });

  it('needs a working read-only checkout token for a private repository', async () => {
    const { impl, calls } = fakeFetch(REPOS, { main: SHA_B }, 'bad-read');
    const base = {
      repository: 'octo/secret',
      callingRepository: 'octo/caller',
      targetToken: 'target-token',
      fetch: impl,
    };
    expect(code(await resolveTarget(base))).toBe('E_TARGET_TOKEN');
    expect(code(await resolveTarget({ ...base, readToken: 'bad-read' }))).toBe(
      'E_TARGET_TOKEN',
    );
    calls.length = 0;
    const resolved = await resolveTarget({ ...base, readToken: 'read-token' });
    expect(resolved.ok && resolved.value).toMatchObject({
      repository: 'octo/secret',
      cross: true,
      sha: SHA_B,
    });
    // The read token only proves it can read, and cannot write, the target.
    expect(calls.map((call) => call.auth)).toEqual([
      'Bearer target-token',
      'Bearer read-token',
      'Bearer read-token',
      'Bearer target-token',
    ]);
    expect(calls[2]?.url).toMatch(/\/repos\/octo\/secret\/git\/refs$/u);
  });

  it('refuses a read token that is the write token, a scoped classic token, or can write contents', async () => {
    const { impl } = fakeFetch(
      REPOS,
      { main: SHA_B, trunk: SHA_A },
      undefined,
      {
        writers: ['writer'],
        scopes: { classic: 'read:org, repo', reader: 'read:org', blank: '' },
      },
    );
    const base = {
      repository: 'octo/secret',
      callingRepository: 'octo/caller',
      targetToken: 'target-token',
      fetch: impl,
    };
    // Any scoped classic token is refused, even read-only scopes.
    for (const readToken of ['target-token', 'classic', 'reader', 'writer']) {
      const refused = await resolveTarget({ ...base, readToken });
      expect(code(refused), readToken).toBe('E_TARGET_TOKEN');
    }
    // A token reporting no scopes (fine-grained, App) that cannot write passes.
    for (const readToken of ['fine-grained', 'blank']) {
      expect(code(await resolveTarget({ ...base, readToken })), readToken).toBe(
        'ok',
      );
    }
    // A public target without a read token needs none of these checks.
    expect(
      code(
        await resolveTarget({
          ...base,
          repository: 'octo/widgets',
          readToken: undefined,
        }),
      ),
    ).toBe('ok');
  });

  it('admits only a recognized permission denial from the write probe (gate H2)', async () => {
    const probe = {
      denied: {
        status: 403,
        message: 'Resource not accessible by personal access token',
      },
      app: { status: 403, message: 'Resource not accessible by integration' },
      hidden: { status: 404, message: 'Not Found' },
      primary: {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '9999999999',
        },
        message: 'API rate limit exceeded for user ID 1.',
      },
      secondary: {
        status: 403,
        headers: { 'retry-after': '60' },
        message: 'You have exceeded a secondary rate limit.',
      },
      // A rate-limit header wins even over a denial message.
      limitedDenial: {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        message: 'Resource not accessible by personal access token',
      },
      tooMany: { status: 429, message: 'Too Many Requests' },
      saml: {
        status: 403,
        message: 'Resource protected by organization SAML enforcement.',
      },
      otherNotFound: { status: 404, message: 'Repository not found' },
    };
    const { impl } = fakeFetch(REPOS, { main: SHA_B }, undefined, { probe });
    const base = {
      repository: 'octo/secret',
      callingRepository: 'octo/caller',
      targetToken: 'target-token',
      fetch: impl,
    };
    const verdicts: Record<string, string | undefined> = {};
    for (const readToken of Object.keys(probe)) {
      verdicts[readToken] = code(await resolveTarget({ ...base, readToken }));
    }
    expect(verdicts).toEqual({
      denied: 'ok',
      app: 'ok',
      hidden: 'ok',
      primary: 'E_TARGET_TOKEN',
      secondary: 'E_TARGET_TOKEN',
      limitedDenial: 'E_TARGET_TOKEN',
      tooMany: 'E_TARGET_TOKEN',
      saml: 'E_TARGET_TOKEN',
      otherNotFound: 'E_TARGET_TOKEN',
    });
  });

  it('stops before any request when another repository has no target token', async () => {
    const { impl, calls } = fakeFetch(REPOS, {});
    const resolved = await resolveTarget({
      repository: 'octo/widgets',
      callingRepository: 'octo/caller',
      githubToken: 'gh-token',
      targetToken: '',
      fetch: impl,
    });
    expect(code(resolved)).toBe('E_TARGET_TOKEN');
    expect(calls).toHaveLength(0);
  });

  it('encodes refs, validates inputs and refuses unexpected metadata', async () => {
    const { impl, calls } = fakeFetch(REPOS, { 'feat/x': SHA_A });
    const explicit = await resolveTarget({
      repository: 'octo/widgets',
      callingRepository: 'octo/caller',
      ref: 'feat/x',
      base: 'release',
      commentPr: '3',
      targetToken: 't',
      fetch: impl,
    });
    expect(explicit.ok && explicit.value).toMatchObject({
      sha: SHA_A,
      base: 'release',
      commentPr: '3',
    });
    expect(calls.at(-1)?.url).toMatch(/\/commits\/feat%2Fx$/u);
    for (const input of [
      { repository: 'octo/../x' },
      { ref: 'a..b' },
      { base: 'x y' },
      { commentPr: '1; rm' },
      { callingRepository: 'nope' },
    ]) {
      const result = await resolveTarget({
        callingRepository: 'octo/caller',
        eventRef: SHA_A,
        githubToken: 'gh',
        fetch: impl,
        ...input,
      });
      expect(code(result), JSON.stringify(input)).toBe('E_INVALID_INPUT');
    }
    const spoofed = fakeFetch(
      { 'octo/widgets': { full_name: 'evil/widgets', default_branch: 'main' } },
      {},
    );
    const mismatch = await resolveTarget({
      repository: 'octo/widgets',
      callingRepository: 'octo/caller',
      targetToken: 't',
      fetch: spoofed.impl,
    });
    expect(code(mismatch)).toBe('E_GITHUB_API');
    const missing = await resolveTarget({
      repository: 'octo/absent',
      callingRepository: 'octo/caller',
      targetToken: 't',
      fetch: impl,
    });
    expect(code(missing)).toBe('E_GITHUB_API');
  });
});

describe('agent-ci targets', () => {
  it('appends JSON targets after YAML targets with file defaults and per-target overrides', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-merge-'));
    await writeFile(
      path.join(dir, 'targets.yaml'),
      'version: 1\nallowedOwners: [octo]\ndefaults: {base: main, model: fake-edit, inputs: {maxAttempts: 3}}\ntargets: [{id: a, repository: octo/a}]\n',
    );
    const result = await run(
      [
        'targets',
        'matrix',
        '--preset',
        'docs-update',
        '--targets-json',
        '[{"id":"b","repository":"octo/b","base":"develop","private":true}]',
      ],
      { cwd: dir, env: {}, log: () => undefined },
    );
    expect(result.envelope).toMatchObject({
      ok: true,
      data: {
        count: 2,
        matrix: {
          include: [
            {
              id: 'a',
              base: 'main',
              model: 'fake-edit',
              max_attempts: 3,
              private_target: false,
            },
            {
              id: 'b',
              base: 'develop',
              model: 'fake-edit',
              max_attempts: 3,
              private_target: true,
            },
          ],
        },
      },
    });
  });

  it('requires a default or named file unless --file explicitly disables it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-json-only-'));
    const ctx = { cwd: dir, env: {}, log: () => undefined };
    const json =
      '[{"id":"a","repository":"octo/a","base":"main","model":"fake-edit"}]';
    for (const fileArgs of [[], ['--file', 'missing.yaml']]) {
      const missing = await run(
        ['targets', 'validate', ...fileArgs, '--targets-json', json],
        ctx,
      );
      expect(missing.envelope).toMatchObject({
        ok: false,
        code: 'E_TARGETS_CONFIG',
      });
    }
    const validated = await run(
      ['targets', 'validate', '--file', '', '--targets-json', json],
      ctx,
    );
    expect(validated.envelope).toMatchObject({
      ok: true,
      data: {
        targets: [{ id: 'a', repository: 'octo/a' }],
        presets: {
          'docs-update': 1,
          'instructions-update': 1,
          'tools-update': 1,
        },
      },
    });
    const matrix = await run(
      [
        'targets',
        'matrix',
        '--preset',
        'tools-update',
        '--file',
        '',
        '--targets-json',
        json,
      ],
      ctx,
    );
    expect(matrix.envelope).toMatchObject({ ok: true, data: { count: 1 } });
  });

  it('rejects invalid merged input before writing GitHub outputs even when selecting one target', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-json-errors-'));
    await writeFile(
      path.join(dir, 'targets.yaml'),
      'version: 1\nallowedOwners: [octo]\ndefaults: {base: main}\ntargets: [{id: a, repository: octo/a}]',
    );
    const output = path.join(dir, 'output');
    await writeFile(output, 'sentinel\n');
    const ctx = {
      cwd: dir,
      env: { GITHUB_OUTPUT: output },
      log: () => undefined,
    };
    const tooMany = Array.from({ length: MAX_TARGETS }, (_, index) => ({
      id: `t${index}`,
      repository: `octo/r${index}`,
    }));
    for (const json of [
      '[',
      JSON.stringify(tooMany),
      '[{"id":"b","repository":"outside/b"}]',
    ]) {
      const result = await run(
        [
          'targets',
          'matrix',
          '--preset',
          'tools-update',
          '--target',
          'a',
          '--targets-json',
          json,
          '--github-output',
        ],
        ctx,
      );
      expect(result.envelope).toMatchObject({
        ok: false,
        code: 'E_TARGETS_CONFIG',
      });
      expect(await readFile(output, 'utf8')).toBe('sentinel\n');
    }
  });

  it('routes only selected preset targets, validates every applicable preset, and bounds the merged matrix', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-json-routing-'));
    await writeFile(
      path.join(dir, 'targets.yaml'),
      'version: 1\ndefaults: {base: main, model: fake-edit}\ntargets: [{id: a, repository: octo/a}]',
    );
    const ctx = { cwd: dir, env: { CI: 'true' }, log: () => undefined };
    const json =
      '[{"id":"b","repository":"octo/b","useCases":["instructions-update"],"model":"unknown-model"}]';
    const baseArgs = ['--targets-json', json];
    const selected = await run(
      [
        'targets',
        'matrix',
        '--preset',
        'instructions-update',
        '--target',
        'a',
        ...baseArgs,
      ],
      ctx,
    );
    expect(selected.envelope).toMatchObject({ ok: true, data: { count: 1 } });
    const otherPreset = await run(
      ['targets', 'matrix', '--preset', 'docs-update', ...baseArgs],
      ctx,
    );
    expect(otherPreset.envelope).toMatchObject({
      ok: true,
      data: { count: 1 },
    });
    const invalidRoute = await run(['targets', 'validate', ...baseArgs], ctx);
    expect(invalidRoute.envelope).toMatchObject({
      ok: false,
      code: 'E_TARGETS_CONFIG',
    });
    const bounded = await run(
      [
        'targets',
        'matrix',
        '--preset',
        'tools-update',
        '--max-targets',
        '1',
        '--targets-json',
        '[{"id":"b","repository":"octo/b"}]',
      ],
      ctx,
    );
    expect(bounded.envelope).toMatchObject({
      ok: false,
      code: 'E_TARGETS_LIMIT',
    });
  });

  it('writes the matrix as one step-output line and confines --file to --root', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-targets-'));
    const caller = path.join(dir, 'caller');
    await mkdir(caller);
    await writeFile(
      path.join(caller, 'targets.yaml'),
      'version: 1\ndefaults: {base: main, model: fake-edit}\ntargets: [{id: a, repository: o/r}]\n',
    );
    const output = path.join(dir, 'out.txt');
    await writeFile(output, '');
    const ctx = {
      cwd: dir,
      env: { GITHUB_OUTPUT: output },
      log: () => undefined,
    };
    const result = await run(
      [
        'targets',
        'matrix',
        '--root',
        'caller',
        '--preset',
        'docs-update',
        '--reset',
        '',
        '--github-output',
      ],
      ctx,
    );
    expect(result.exitCode).toBe(0);
    const lines = (await readFile(output, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith('matrix={"include":[')).toBe(true);
    expect(lines[1]).toBe('count=1');

    await symlink('/etc/hosts', path.join(caller, 'link.yaml'));
    for (const candidate of ['../out.txt', 'link.yaml']) {
      const escaped = await run(
        [
          'targets',
          'matrix',
          '--root',
          'caller',
          '--file',
          candidate,
          '--preset',
          'docs-update',
        ],
        ctx,
      );
      expect(
        escaped.envelope.ok ? 'ok' : escaped.envelope.code,
        candidate,
      ).toBe('E_TARGETS_CONFIG');
    }
    const model = await run(
      [
        'targets',
        'matrix',
        '--root',
        'caller',
        '--preset',
        'tools-update',
        '--model',
        'fake-edit',
      ],
      ctx,
    );
    expect(model.envelope.ok ? 'ok' : model.envelope.code).toBe(
      'E_INVALID_INPUT',
    );
  });

  it('resolves a target and writes its step outputs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-resolve-'));
    const output = path.join(dir, 'out.txt');
    await writeFile(output, '');
    const { impl } = fakeFetch(REPOS, { [SHA_A]: SHA_A });
    const command = createTargetsCommand({ fetch: impl });
    const data = await command.run(
      ['resolve', '--repository', '', '--event-ref', SHA_A, '--github-output'],
      {
        cwd: dir,
        env: {
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'octo/caller',
          GITHUB_TOKEN: 'gh-token',
        },
        log: () => undefined,
      },
    );
    expect(data).toMatchObject({ repository: 'octo/caller', cross: false });
    expect(await readFile(output, 'utf8')).toBe(
      `repository=octo/caller\ncross=false\nsha=${SHA_A}\nbase=main\ncomment_pr=\ndefault_branch=main\n`,
    );
    expect(JSON.stringify(data)).not.toContain('gh-token');
  });
});

describe('checked-in targets files', () => {
  it('validate against models.yaml under the CI policy; this repository targets only itself', async () => {
    const table = parseModelsFile(
      await readFile(path.join(PACKAGE_ROOT, 'models.yaml'), 'utf8'),
    );
    if (!table.ok) throw new Error(table.message);
    for (const name of ['targets.yaml', 'targets.example.yaml']) {
      const parsed = parseTargetsFile(
        await readFile(path.join(PACKAGE_ROOT, name), 'utf8'),
      );
      if (!parsed.ok) throw new Error(`${name}: ${parsed.message}`);
      for (const preset of PRESET_NAMES) {
        const selected = selectTargets(parsed.value, {
          preset,
          models: table.value,
          env: { CI: 'true' },
        });
        expect(selected.ok, `${name} ${preset}`).toBe(true);
      }
      if (name === 'targets.yaml') {
        expect(parsed.value.targets.map((target) => target.repository)).toEqual(
          ['tkstang/agent-ci'],
        );
      }
    }
  });
});
