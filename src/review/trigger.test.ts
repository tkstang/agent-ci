import { execFileSync } from 'node:child_process';

import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { validateIdentity } from '@agent-ci/review/contracts.js';
import { FakeGithub } from '@agent-ci/review/testing/fake-github.js';
import {
  acknowledgeRequest,
  type Authorized,
  authorizeRequest,
  configureRequest,
  isBranchName,
  parseAllowedModels,
  parseAllowedPrAuthors,
  parsePolicy,
  resolvePrReviewTrigger,
} from '@agent-ci/review/trigger.js';
import { loadModelsFile } from '@agent-ci/routing/resolve.js';
import { parseModelsFile } from '@agent-ci/routing/resolve.js';
import { describe, expect, it } from 'vitest';

const REPO = 'tkstang/app';
const API = `/repos/${REPO}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);

const human = (name: string) => ({ login: name, type: 'User' });
const bot = (name: string) => ({ login: `${name}[bot]`, type: 'Bot' });

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    title: 'Add cache',
    body: 'Body text',
    user: human('author'),
    head: { sha: HEAD, repo: { full_name: REPO } },
    base: { sha: BASE, ref: 'main', repo: { full_name: REPO } },
    ...overrides,
  };
}

const labelEvent = (
  overrides: Record<string, unknown> = {},
  label = 'agent-ci:review',
) => ({
  action: 'labeled',
  label: { name: label },
  pull_request: { number: 7 },
  sender: human('maintainer'),
  ...overrides,
});
const commentEvent = (
  body: string,
  overrides: Record<string, unknown> = {},
) => ({
  action: 'created',
  issue: { number: 7, pull_request: { url: 'x' } },
  comment: { id: 99, body, user: human('maintainer') },
  sender: human('maintainer'),
  ...overrides,
});

describe('resolvePrReviewTrigger', () => {
  const decide = (
    eventName: string,
    event: unknown,
    facts: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) =>
    resolvePrReviewTrigger({
      eventName,
      event,
      repository: REPO,
      facts,
      ...extra,
    });
  const allFacts = {
    actorPermission: 'write',
    pullRequest: pull(),
    authorPermission: 'maintain',
  };

  it('authorizes a same-repository label request from pull_request_target and pull_request', () => {
    for (const eventName of ['pull_request_target', 'pull_request'])
      expect(decide(eventName, labelEvent(), allFacts)).toMatchObject({
        status: 'authorized',
        request: { trigger: 'label', prNumber: 7, labelMode: 'review' },
        pullRequest: { headSha: HEAD, baseRef: 'main', author: 'author' },
      });
  });

  it('asks for each fact in order and nothing before it is needed', () => {
    expect(decide('pull_request_target', labelEvent())).toMatchObject({
      status: 'need',
      fact: 'actorPermission',
      login: 'maintainer',
    });
    expect(
      decide('pull_request_target', labelEvent(), { actorPermission: 'admin' }),
    ).toMatchObject({ status: 'need', fact: 'pullRequest' });
    expect(
      decide('pull_request_target', labelEvent(), {
        actorPermission: 'admin',
        pullRequest: pull(),
      }),
    ).toMatchObject({
      status: 'need',
      fact: 'authorPermission',
      login: 'author',
    });
  });

  it.each([
    ['an unrelated event', 'push', {}],
    [
      'an unlabeled action',
      'pull_request_target',
      labelEvent({ action: 'opened' }),
    ],
    [
      'an unrelated label',
      'pull_request_target',
      labelEvent({}, 'agent-ci:summarize'),
    ],
    ['a bot labeler', 'pull_request_target', labelEvent({ sender: bot('x') })],
    [
      'an edited comment',
      'issue_comment',
      commentEvent('/agent-ci-review', { action: 'edited' }),
    ],
    ['a non-command comment', 'issue_comment', commentEvent('looks good')],
    [
      'a bot comment',
      'issue_comment',
      commentEvent('/agent-ci-review', {
        comment: { id: 1, body: '/agent-ci-review', user: bot('x') },
      }),
    ],
    [
      'a plain issue',
      'issue_comment',
      commentEvent('/agent-ci-review', { issue: { number: 7 } }),
    ],
  ])('ignores %s', (_name, eventName, event) => {
    expect(decide(eventName as string, event, allFacts).status).toBe('ignore');
  });

  it.each([
    ['unauthorized-actor', { actorPermission: 'triage' }],
    ['unauthorized-actor', { actorPermission: 'none' }],
    [
      'fork',
      {
        actorPermission: 'write',
        pullRequest: pull({
          head: { sha: HEAD, repo: { full_name: 'mallory/app' } },
        }),
      },
    ],
    [
      'closed',
      { actorPermission: 'write', pullRequest: pull({ state: 'closed' }) },
    ],
    ['draft', { actorPermission: 'write', pullRequest: pull({ draft: true }) }],
    [
      'bot-author',
      {
        actorPermission: 'write',
        pullRequest: pull({ user: bot('renovate') }),
      },
    ],
    [
      'unauthorized-author',
      {
        actorPermission: 'write',
        pullRequest: pull(),
        authorPermission: 'read',
      },
    ],
  ])('skips with %s', (reason, facts) => {
    expect(decide('pull_request_target', labelEvent(), facts)).toMatchObject({
      status: 'skip',
      reason,
    });
  });

  it('trusts a listed bot author but never bypasses the actor or fork checks', () => {
    const facts = {
      actorPermission: 'write',
      pullRequest: pull({ user: bot('renovate') }),
    };
    expect(
      decide('pull_request_target', labelEvent(), facts, {
        allowedPrAuthors: ['renovate[bot]'],
      }).status,
    ).toBe('authorized');
    expect(
      decide(
        'pull_request_target',
        labelEvent(),
        { ...facts, actorPermission: 'read' },
        { allowedPrAuthors: ['renovate[bot]'] },
      ).status,
    ).toBe('skip');
  });

  it('fails closed on an unusable PR lookup', () => {
    expect(() =>
      decide('pull_request_target', labelEvent(), {
        actorPermission: 'write',
        pullRequest: { number: 7 },
      }),
    ).toThrow(expect.objectContaining({ code: 'E_GITHUB_API' }));
  });

  it('accepts a PR-scoped dispatch and refuses a malformed one', () => {
    const sender = { sender: human('maintainer') };
    expect(
      decide('workflow_dispatch', sender, allFacts, { dispatchPrNumber: '7' }),
    ).toMatchObject({
      status: 'authorized',
      request: { trigger: 'dispatch', commandText: '/agent-ci-review' },
    });
    expect(
      decide('workflow_dispatch', sender, allFacts, { dispatchPrNumber: 'x' }),
    ).toMatchObject({ status: 'skip', reason: 'invalid-dispatch' });
    expect(
      decide('workflow_dispatch', sender, allFacts, {
        dispatchPrNumber: '7',
        dispatchCommand: 'review please',
      }),
    ).toMatchObject({ status: 'skip', reason: 'invalid-dispatch' });
  });
});

describe('authorizeRequest', () => {
  it('looks up the sender, the PR, the author and the merge base', async () => {
    const github = new FakeGithub()
      .on('GET', `${API}/collaborators/maintainer/permission`, {
        body: { permission: 'write' },
      })
      .on('GET', `${API}/pulls/7`, { body: pull() })
      .on('GET', `${API}/collaborators/author/permission`, {
        body: { permission: 'admin' },
      })
      .on('GET', `${API}/compare/${BASE}...${HEAD}`, {
        body: { merge_base_commit: { sha: MERGE } },
      });
    const outcome = await authorizeRequest({
      github: github.client(),
      repository: REPO,
      eventName: 'issue_comment',
      event: commentEvent('/agent-ci-review'),
    });
    expect(outcome).toMatchObject({
      status: 'authorized',
      authorized: { mergeBaseSha: MERGE, request: { commentId: 99 } },
    });
    // Nothing is written before authorization.
    expect(github.sent('POST')).toEqual([]);
  });

  it('treats a non-collaborator (404) as no permission', async () => {
    const github = new FakeGithub();
    expect(
      await authorizeRequest({
        github: github.client(),
        repository: REPO,
        eventName: 'pull_request_target',
        event: labelEvent(),
      }),
    ).toMatchObject({ status: 'skip', reason: 'unauthorized-actor' });
  });
});

const MODELS = parseModelsFile(`version: 1
routes:
  - id: claude-pool
    model: claude-haiku-4-5
    harness: claude
    family: claude
    providerModel: claude-haiku-4-5-20251001
    credentials: [ANTHROPIC_AUTH_TOKEN]
    billing: subscription
    account: pool
    structuredOutput: json-schema
    qualified: null
  - id: claude-personal
    model: claude-haiku-4-5
    harness: claude
    family: claude
    providerModel: claude-haiku-4-5-20251001
    credentials: [CLAUDE_CODE_OAUTH_TOKEN]
    billing: subscription
    account: personal
    structuredOutput: json-schema
    qualified: null
  - id: grok-opencode
    model: grok-4.7
    harness: opencode
    family: xai
    providerModel: opencode-go/grok-4.7
    credentials: [OPENCODE_API_KEY]
    billing: subscription
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: luna-pool
    model: gpt-5.6-luna
    harness: codex
    family: openai
    providerModel: gpt-5.6-luna
    credentials: [AGENT_CI_PROXY_API_KEY]
    billing: subscription
    account: pool
    structuredOutput: output-schema
    qualified: null
`);
if (!MODELS.ok) throw new Error(MODELS.message);

const authorized = (commandText: string | null): Authorized => ({
  request: {
    trigger: commandText === null ? 'label' : 'comment',
    prNumber: 7,
    labelMode: commandText === null ? 'review' : null,
    label: commandText === null ? 'agent-ci:review' : null,
    commandText,
    commentId: commandText === null ? null : 99,
    sender: 'maintainer',
  },
  pullRequest: {
    number: 7,
    headSha: HEAD,
    baseSha: BASE,
    baseRef: 'main',
    author: 'author',
    authorType: 'User',
    title: 'Add cache',
    body: 'Body text',
  },
  mergeBaseSha: MERGE,
});
const DEFAULTS = {
  reviewer_model: 'claude-haiku-4-5',
  second_reviewer: false,
  second_reviewer_model: 'grok-4.7',
  adjudicator: false,
  adjudicator_model: 'claude-haiku-4-5',
};
const CI_ENV = { CI: 'true', GITHUB_ACTIONS: 'true' };
const configure = (
  commandText: string | null,
  overrides: Partial<Parameters<typeof configureRequest>[0]> = {},
) =>
  configureRequest({
    authorized: authorized(commandText),
    defaults: DEFAULTS,
    allowedModels: ['claude-haiku-4-5', 'grok-4.7', 'gpt-5.6-luna'],
    models: MODELS.value,
    env: CI_ENV,
    ...overrides,
  });

describe('configureRequest', () => {
  it('plans verify-review only when the workflow enables it, on bridge harnesses', () => {
    expect(configure('/agent-ci-verify-review')).toMatchObject({
      status: 'failed',
      failure: {
        route: 'command',
        detail: expect.stringContaining('not enabled'),
      },
    });
    expect(
      configure('/agent-ci-verify-review', { verifyEnabled: true }),
    ).toMatchObject({
      status: 'planned',
      config: { mode: 'verify-review', primary: { model: 'claude-haiku-4-5' } },
    });
    // A label carries the mode too.
    const label = authorized(null);
    expect(
      configureRequest({
        authorized: {
          ...label,
          request: {
            ...label.request,
            labelMode: 'verify-review',
            label: 'agent-ci:verify-review',
          },
        },
        defaults: DEFAULTS,
        allowedModels: ['claude-haiku-4-5'],
        models: MODELS.value,
        env: CI_ENV,
        verifyEnabled: true,
      }),
    ).toMatchObject({ status: 'planned', config: { mode: 'verify-review' } });
    // OpenCode (and Cursor) reviewers have no run_check bridge.
    expect(
      configure('/agent-ci-verify-review reviewer_model=grok-4.7', {
        verifyEnabled: true,
      }),
    ).toMatchObject({
      status: 'failed',
      failure: {
        route: 'command',
        detail: expect.stringContaining('run_check tool bridge'),
      },
    });
    expect(
      configure('/agent-ci-verify-review second_reviewer=on', {
        verifyEnabled: true,
      }),
    ).toMatchObject({
      status: 'failed',
      failure: { route: 'configuration' },
    });
  });

  it('answers a verify-review request on a repository without verify as not enabled, even with the pool opt-in', () => {
    expect(
      configure('/agent-ci-verify-review', {
        verifyEnabled: false,
        allowPool: true,
        env: { ...CI_ENV, RUNNER_ENVIRONMENT: 'self-hosted' },
      }),
    ).toMatchObject({
      status: 'failed',
      failure: {
        route: 'command',
        detail: expect.stringContaining('not enabled'),
      },
    });
  });

  it('refuses verify-review with the pool opt-in in CI, but not locally', () => {
    expect(
      configure('/agent-ci-verify-review', {
        verifyEnabled: true,
        allowPool: true,
        env: { ...CI_ENV, RUNNER_ENVIRONMENT: 'self-hosted' },
      }),
    ).toMatchObject({
      status: 'failed',
      failure: {
        route: 'configuration',
        detail: expect.stringContaining('allow_pool'),
      },
    });
    expect(
      configure('/agent-ci-verify-review', {
        verifyEnabled: true,
        allowPool: true,
        env: {},
      }),
    ).toMatchObject({ status: 'planned', config: { mode: 'verify-review' } });
  });

  it('resolves a label request to the workflow settings', () => {
    expect(configure(null)).toMatchObject({
      status: 'planned',
      config: { mode: 'review', primary: { model: 'claude-haiku-4-5' } },
    });
  });

  it('carries command options and the instruction', () => {
    expect(
      configure('/agent-ci-review second_reviewer=on focus on the cache'),
    ).toMatchObject({
      status: 'planned',
      config: {
        second: { enabled: true, model: 'grok-4.7' },
        instruction: 'focus on the cache',
      },
    });
  });

  it('blames the requester for a command model that is not allowed or routable', () => {
    expect(configure('/agent-ci-review reviewer_model=opus')).toMatchObject({
      status: 'failed',
      failure: {
        route: 'command',
        detail: expect.stringContaining('allowed_models'),
      },
    });
    // A pool-only model has no route in CI.
    expect(
      configure('/agent-ci-review reviewer_model=gpt-5.6-luna'),
    ).toMatchObject({
      status: 'failed',
      failure: {
        route: 'command',
        detail: expect.stringContaining('no usable route'),
      },
    });
  });

  it('blames the workflow for a default model that is not allowed', () => {
    expect(configure(null, { allowedModels: ['grok-4.7'] })).toMatchObject({
      status: 'failed',
      failure: { route: 'configuration' },
    });
  });

  it('runs the adjudicator only on a harness with a verified tool-free posture', () => {
    expect(
      configure('/agent-ci-review adjudicator_model=grok-4.7'),
    ).toMatchObject({
      status: 'failed',
      failure: {
        route: 'command',
        detail: expect.stringContaining('tool-free'),
      },
    });
    expect(configure('/agent-ci-review adjudicator=on')).toMatchObject({
      status: 'planned',
      config: { adjudicator: { enabled: true, model: 'claude-haiku-4-5' } },
    });
  });

  it('plans the exact Sol Low adjudicator and refuses a forged route alias or effort before execution', async () => {
    const loaded = await loadModelsFile(DEFAULT_MODELS_PATH);
    if (!loaded.ok) throw new Error(loaded.message);
    const options = {
      models: loaded.value,
      allowPool: true,
      env: { CI: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
      allowedModels: ['claude-haiku-4-5', 'gpt-6.1-sol-low'],
    };
    const command = '/agent-ci-review adjudicator_model=gpt-6.1-sol-low';
    expect(configure(command, options)).toMatchObject({ status: 'planned' });
    for (const change of [
      { effort: 'high' },
      { providerModel: 'gpt-5.6-luna' },
      { account: 'personal' as const },
    ]) {
      const models = {
        ...loaded.value,
        routes: loaded.value.routes.map((route) =>
          route.model === 'gpt-6.1-sol-low' ? { ...route, ...change } : route,
        ),
      };
      expect(configure(command, { ...options, models })).toMatchObject({
        status: 'failed',
        failure: { detail: expect.stringContaining('tool-free') },
      });
    }
  });

  it('blames the requester for a model name with invalid syntax', () => {
    for (const command of [
      '/agent-ci-review reviewer_model=bad!name',
      '/agent-ci-review adjudicator_model=x[y]',
    ])
      expect(configure(command)).toMatchObject({
        status: 'failed',
        failure: {
          route: 'command',
          detail: expect.stringContaining('is not a model name'),
        },
      });
  });

  it('reports a malformed command to the requester', () => {
    expect(configure('/agent-ci-review bogus=1')).toMatchObject({
      status: 'failed',
      failure: { route: 'command' },
    });
  });
});

describe('policy and allowed models', () => {
  it('parses and bounds the publication policy', () => {
    expect(parsePolicy({})).toEqual({
      fail_on_severity: null,
      floor: 'medium',
      budget: 10,
    });
    expect(
      parsePolicy({
        failOnSeverity: 'HIGH',
        minInlineSeverity: 'low',
        maxInlineComments: '0',
      }),
    ).toEqual({ fail_on_severity: 'high', floor: 'low', budget: 0 });
    for (const bad of [
      { failOnSeverity: 'urgent' },
      { maxInlineComments: '101' },
      { maxInlineComments: '-1' },
    ])
      expect(() => parsePolicy(bad)).toThrow(
        expect.objectContaining({ code: 'E_REVIEW_REQUEST' }),
      );
  });

  it('parses allowed models and rejects selection syntax', () => {
    expect(parseAllowedModels('claude-haiku-4-5\ngrok-4.7, grok-4.7')).toEqual([
      'claude-haiku-4-5',
      'grok-4.7',
    ]);
    expect(() => parseAllowedModels('opus[fast=true]')).toThrow(
      expect.objectContaining({ code: 'E_REVIEW_REQUEST' }),
    );
  });
});

describe('acknowledgeRequest', () => {
  const base = {
    repository: REPO,
    runId: '500',
    publisherLogin: 'github-actions[bot]',
  };

  it('consumes the label and binds an accepted request', async () => {
    const github = new FakeGithub().on(
      'DELETE',
      `${API}/issues/7/labels/agent-ci%3Areview`,
      { status: 204 },
    );
    const outcome = await acknowledgeRequest({
      ...base,
      github: github.client(),
      authorized: authorized(null),
      configured: configure(null),
      reply: true,
      acknowledge: true,
    });
    expect(github.sent('DELETE')).toHaveLength(1);
    expect(outcome).toMatchObject({
      status: 'accepted',
      record: {
        version: 1,
        repository: REPO,
        pr_number: 7,
        head_sha: HEAD,
        merge_base_sha: MERGE,
        pr: { title: 'Add cache', body: 'Body text' },
      },
    });
  });

  it('replies once to a failed command and never twice for the same request', async () => {
    let comments: unknown[] = [];
    const github = new FakeGithub()
      .on('GET', `${API}/issues/7/comments`, () => ({ body: comments }))
      .on('POST', `${API}/issues/7/comments`, (request) => {
        comments = [
          {
            user: { login: 'github-actions[bot]', type: 'Bot' },
            body: (request.body as { body: string }).body,
          },
        ];
        return { status: 201, body: {} };
      });
    const run = () =>
      acknowledgeRequest({
        ...base,
        github: github.client(),
        authorized: authorized('/agent-ci-review bogus=1'),
        configured: configure('/agent-ci-review bogus=1'),
        reply: true,
        acknowledge: true,
      });
    expect(await run()).toMatchObject({ status: 'failed', reply: 'posted' });
    expect(await run()).toMatchObject({
      status: 'failed',
      reply: 'already-posted',
    });
    expect(github.sent('POST')).toHaveLength(1);
  });

  it('reacts with eyes to an accepted comment; a failed reaction does not drop it', async () => {
    const github = new FakeGithub().on(
      'POST',
      `${API}/issues/comments/99/reactions`,
      { status: 403 },
    );
    const outcome = await acknowledgeRequest({
      ...base,
      github: github.client(),
      authorized: authorized('/agent-ci-review'),
      configured: configure('/agent-ci-review'),
      reply: true,
      acknowledge: true,
    });
    expect(outcome.status).toBe('accepted');
    expect(github.sent('POST')).toHaveLength(1);
  });

  it('writes nothing to GitHub for a local run', async () => {
    const github = new FakeGithub();
    await acknowledgeRequest({
      ...base,
      github: github.client(),
      authorized: authorized('/agent-ci-review bogus=1'),
      configured: configure('/agent-ci-review bogus=1'),
      reply: false,
      acknowledge: false,
    });
    expect(github.requests).toEqual([]);
  });
});

describe('base branch names', () => {
  const names = [
    'main',
    'release+next',
    '_main',
    'リリース',
    'feature/a.b-c',
    'v1.2@x',
    '-main',
    'a..b',
    'a b',
    'a:b',
    'a~1',
    'a^',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    '.hidden',
    'a/.b',
    'a.lock',
    'a/',
    '/a',
    'a//b',
    'a.',
    'a@{1}',
    'a\u0001b',
    'a\u007fb',
  ];

  it.each([...names, '@'])(
    'agrees with git check-ref-format on refs/heads/%s',
    (name) => {
      let git = !name.startsWith('-'); // `git branch` refuses a leading dash
      try {
        execFileSync('git', ['check-ref-format', `refs/heads/${name}`], {
          stdio: 'ignore',
        });
      } catch {
        git = false;
      }
      expect(isBranchName(name)).toBe(git);
    },
  );

  it.each(['release+next', 'リリース', 'main'])(
    'authorizes a same-repository request whose base is %j and binds it',
    async (ref) => {
      const github = new FakeGithub()
        .on('GET', `${API}/collaborators/maintainer/permission`, {
          body: { permission: 'write' },
        })
        .on('GET', `${API}/pulls/7`, {
          body: pull({ base: { sha: BASE, ref, repo: { full_name: REPO } } }),
        })
        .on('GET', `${API}/collaborators/author/permission`, {
          body: { permission: 'write' },
        })
        .on('GET', `${API}/compare/${BASE}...${HEAD}`, {
          body: { merge_base_commit: { sha: MERGE } },
        });
      const outcome = await authorizeRequest({
        github: github.client(),
        repository: REPO,
        eventName: 'pull_request_target',
        event: labelEvent(),
      });
      expect(outcome).toMatchObject({
        status: 'authorized',
        authorized: { pullRequest: { baseRef: ref } },
      });
    },
  );

  it('still refuses a base name git would refuse (multi-line, traversal)', () => {
    for (const ref of ['main\nshould_run=true', 'a..b'])
      expect(() =>
        resolvePrReviewTrigger({
          eventName: 'pull_request_target',
          event: labelEvent(),
          repository: REPO,
          facts: {
            actorPermission: 'write',
            pullRequest: pull({
              base: { sha: BASE, ref, repo: { full_name: REPO } },
            }),
          },
        }),
      ).toThrow(expect.objectContaining({ code: 'E_GITHUB_API' }));
  });
});

const identity = (repository: string) => ({
  repository,
  workflow: 'agent-ci-pr-review',
  pr_number: 1,
  scope: 'default',
  run_id: '1',
  run_attempt: '1',
});

describe('repository names', () => {
  it('accepts names GitHub allows, including a leading dot, and refuses dot names', () => {
    for (const ok of [
      'tkstang/.github',
      'tkstang/_tools',
      'tkstang/-x',
      'tkstang/app',
    ])
      expect(validateIdentity(identity(ok)).repository).toBe(ok);
    for (const bad of [
      'tkstang/.',
      'tkstang/..',
      '.org/app',
      'tkstang/a b',
      'tkstang',
    ])
      expect(() => validateIdentity(identity(bad))).toThrow(
        expect.objectContaining({ code: 'E_REVIEW_INPUT' }),
      );
  });
});

describe('GitHub login forms', () => {
  const facts = (author: string) => ({
    actorPermission: 'write',
    pullRequest: pull({ user: { login: author, type: 'User' } }),
    authorPermission: 'write',
  });

  it.each(['octocat', 'octocat_acme'])(
    'authorizes a label request by %s on a PR that %s authored',
    (login) => {
      expect(
        resolvePrReviewTrigger({
          eventName: 'pull_request_target',
          event: labelEvent({ sender: { login, type: 'User' } }),
          repository: REPO,
          facts: facts(login),
        }),
      ).toMatchObject({
        status: 'authorized',
        request: { sender: login },
        pullRequest: { author: login },
      });
    },
  );

  it('accepts EMU and app logins in allowed_pr_authors and refuses non-logins', () => {
    expect(
      parseAllowedPrAuthors('octocat_acme, app[bot]\nbad login, x<y, _lead'),
    ).toEqual(['octocat_acme', 'app[bot]']);
  });

  it('trusts an allowlisted app author and renders logins inertly in notices', () => {
    expect(
      resolvePrReviewTrigger({
        eventName: 'pull_request_target',
        event: labelEvent(),
        repository: REPO,
        allowedPrAuthors: ['app[bot]'],
        facts: {
          actorPermission: 'write',
          pullRequest: pull({ user: bot('app') }),
        },
      }).status,
    ).toBe('authorized');
    expect(
      resolvePrReviewTrigger({
        eventName: 'pull_request_target',
        event: labelEvent({ sender: { login: 'octocat_acme', type: 'User' } }),
        repository: REPO,
        facts: { actorPermission: 'read' },
      }),
    ).toMatchObject({
      status: 'skip',
      notice:
        '`octocat_acme` does not have write access, so the review request was not run.',
    });
  });
});
