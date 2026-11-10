import { FakeGithub } from '@agent-ci/review/testing/fake-github.js';
import { describe, expect, it } from 'vitest';

import { resolvePrRun } from './gate.js';
import { parsePrRunRequest, PR_RUN_CONTEXT_BYTES } from './request.js';

const REPOSITORY = 'tkstang/app';
const API = `/repos/${REPOSITORY}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const CREATED = '2026-11-09T12:00:00Z';
const user = (login: string) => ({ login, type: 'User' });

function setup(body = '/agent-ci fix the build') {
  const comment: Record<string, unknown> = {
    id: 99,
    body,
    user: user('maintainer'),
    issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/7`,
    created_at: CREATED,
    updated_at: CREATED,
  };
  const pull: Record<string, unknown> = {
    number: 7,
    state: 'open',
    draft: true,
    title: 'Fix the build',
    body: 'Update the integration.',
    user: user('author'),
    head: { sha: HEAD, ref: 'feature/fix', repo: { full_name: REPOSITORY } },
    base: { sha: BASE, ref: 'main', repo: { full_name: REPOSITORY } },
    html_url: `https://github.com/${REPOSITORY}/pull/7`,
  };
  const event: Record<string, unknown> = {
    action: 'created',
    repository: { full_name: REPOSITORY },
    sender: user('maintainer'),
    issue: { number: 7, pull_request: { url: 'https://api.github.com/pr' } },
    comment: { ...comment },
  };
  const github = new FakeGithub()
    .on('GET', `${API}/issues/comments/99`, { body: comment })
    .on('GET', `${API}/collaborators/maintainer/permission`, {
      body: { permission: 'write' },
    })
    .on('GET', `${API}/collaborators/author/permission`, {
      body: { permission: 'maintain' },
    })
    .on('GET', `${API}/pulls/7`, { body: pull })
    .on('GET', `${API}/git/ref/heads/feature/fix`, {
      body: {
        ref: 'refs/heads/feature/fix',
        object: { type: 'commit', sha: HEAD },
      },
    })
    .on('GET', `${API}/git/ref/heads/main`, {
      body: { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE } },
    })
    .on('GET', API, { body: { default_branch: 'main' } })
    .on('GET', `${API}/issues/7/comments`, { body: [] })
    .on('GET', `${API}/pulls/7/reviews`, { body: [] })
    .on('GET', `${API}/pulls/7/comments`, { body: [] });
  const input = {
    github: github.client(),
    repository: REPOSITORY,
    eventName: 'issue_comment',
    event,
    actor: 'maintainer',
  };
  return { input, github, comment, pull, event };
}

describe('resolvePrRun', () => {
  it.each([
    ['base', 'main', 'baseSha'],
    ['head', 'feature/fix', 'headSha'],
  ])(
    'pins the current %s branch tip when PR metadata is stale',
    async (_side, branch, field) => {
      const { input, github } = setup();
      const current = 'c'.repeat(40);
      github.on('GET', `${API}/git/ref/heads/${branch}`, {
        body: {
          ref: `refs/heads/${branch}`,
          object: { type: 'commit', sha: current },
        },
      });
      expect(await resolvePrRun(input)).toMatchObject({
        ok: true,
        value: { status: 'ready', request: { [field]: current } },
      });
    },
  );

  it.each([
    [
      'another branch',
      { ref: 'refs/heads/other', object: { type: 'commit', sha: BASE } },
    ],
    [
      'a tag object',
      { ref: 'refs/heads/main', object: { type: 'tag', sha: BASE } },
    ],
    [
      'an invalid SHA',
      { ref: 'refs/heads/main', object: { type: 'commit', sha: 'invalid' } },
    ],
    ['missing object metadata', { ref: 'refs/heads/main' }],
    ['a list instead of an exact ref', []],
  ])(
    'fails closed when the actual ref response contains %s',
    async (_name, body) => {
      const { input, github } = setup();
      github.on('GET', `${API}/git/ref/heads/main`, { body });
      expect(await resolvePrRun(input)).toMatchObject({
        ok: false,
        code: 'E_GITHUB_API',
      });
      expect(
        github.requests.some((request) =>
          request.path.includes('/pulls/7/comments'),
        ),
      ).toBe(false);
    },
  );

  it.each(['main', 'feature/fix'])(
    'fails closed when the actual %s branch is missing',
    async (branch) => {
      const { input, github } = setup();
      github.on('GET', `${API}/git/ref/heads/${branch}`, { status: 404 });
      expect(await resolvePrRun(input)).toMatchObject({
        ok: false,
        code: 'E_GITHUB_API',
      });
    },
  );

  it('encodes branch path segments without changing the pinned ref name', async () => {
    const { input, github, pull } = setup();
    const branch = 'feature/日本語+cache#next';
    const current = 'c'.repeat(40);
    pull.head = { sha: HEAD, ref: branch, repo: { full_name: REPOSITORY } };
    github.on(
      'GET',
      `${API}/git/ref/heads/feature/%E6%97%A5%E6%9C%AC%E8%AA%9E%2Bcache%23next`,
      {
        body: {
          ref: `refs/heads/${branch}`,
          object: { type: 'commit', sha: current },
        },
      },
    );
    expect(await resolvePrRun(input)).toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        request: { headRef: branch, headSha: current },
      },
    });
  });

  it('targets the fetched head of an open draft PR and preserves native skill and PHP text', async () => {
    const { input, github } = setup(
      '/agent-ci use $fix-ci and then $address-feedback; preserve PHP $response\n/another-skill',
    );
    const result = await resolvePrRun(input);
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        request: {
          version: 1,
          repository: REPOSITORY,
          prNumber: 7,
          commentId: 99,
          actor: 'maintainer',
          headSha: HEAD,
          headRef: 'feature/fix',
          baseSha: BASE,
          baseRef: 'main',
          prompt:
            'use $fix-ci and then $address-feedback; preserve PHP $response\n/another-skill',
          prUrl: `https://github.com/${REPOSITORY}/pull/7`,
        },
      },
    });
    expect(github.requests.every((request) => request.method === 'GET')).toBe(
      true,
    );
  });

  it('accepts the mention form with a command token boundary', async () => {
    const { input } = setup('@agent-ci /fix-build now');
    expect(await resolvePrRun(input)).toMatchObject({
      ok: true,
      value: { status: 'ready', request: { prompt: '/fix-build now' } },
    });
  });

  it('ignores bot-authored commands before any lookup', async () => {
    const { input, event, github } = setup();
    const bot = { login: 'automation[bot]', type: 'Bot' };
    event.sender = bot;
    event.comment = { id: 99, body: '/agent-ci fix it', user: bot };
    expect(
      await resolvePrRun({ ...input, actor: 'automation[bot]' }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ignored', reason: 'bot-command' },
    });
    expect(github.requests).toEqual([]);
  });

  it.each([
    '/agent-ci-review',
    '/agent-ci-verify-review fix it',
    '/agent-cidental',
    '@agent-ci-review',
    'Please /agent-ci fix it',
  ])(
    'ignores another command or prose without doing a lookup: %s',
    async (body) => {
      const { input, github } = setup(body);
      expect(await resolvePrRun(input)).toEqual({
        ok: true,
        value: { status: 'ignored', reason: 'not-a-command' },
      });
      expect(github.requests).toEqual([]);
    },
  );

  it('ignores edited events and comments on plain issues before lookups', async () => {
    const edited = setup();
    edited.event.action = 'edited';
    expect(await resolvePrRun(edited.input)).toMatchObject({
      ok: true,
      value: { status: 'ignored', reason: 'unrelated-event' },
    });
    expect(edited.github.requests).toEqual([]);
    const issue = setup();
    issue.event.issue = { number: 7 };
    expect(await resolvePrRun(issue.input)).toMatchObject({
      ok: true,
      value: { status: 'ignored', reason: 'not-a-pull-request' },
    });
    expect(issue.github.requests).toEqual([]);
  });

  it('bootstraps only an actual unedited command by the dispatching actor', async () => {
    const { input } = setup('/agent-ci /fix-ci');
    expect(
      await resolvePrRun({
        ...input,
        eventName: 'workflow_dispatch',
        commentId: '99',
      }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ready', request: { prompt: '/fix-ci', headSha: HEAD } },
    });
  });

  it.each([
    ['missing comment id', {}],
    ['an invalid comment id', { commentId: '../99' }],
    ['a different dispatcher', { actor: 'other' }],
  ])('refuses a bootstrap with %s', async (_name, overrides) => {
    const { input } = setup();
    expect(
      await resolvePrRun({
        ...input,
        eventName: 'workflow_dispatch',
        ...overrides,
      }),
    ).toMatchObject({ ok: false, code: 'E_PR_RUN_REQUEST' });
  });

  it.each([
    ['different body', { body: '/agent-ci do another task' }],
    ['different actor', { user: user('other') }],
    ['different id', { id: 100 }],
    [
      'another PR',
      { issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/8` },
    ],
    [
      'another repository',
      { issue_url: 'https://api.github.com/repos/other/repo/issues/7' },
    ],
    ['an edited comment', { updated_at: '2026-11-09T12:01:00Z' }],
    ['missing timestamp', { created_at: undefined, updated_at: undefined }],
  ])('refuses when the current comment has %s', async (_name, overrides) => {
    const { input, comment } = setup();
    Object.assign(comment, overrides);
    expect(await resolvePrRun(input)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_REQUEST',
    });
  });

  it('refuses a dispatch by a different human even when the event and actor agree', async () => {
    const { input, event } = setup();
    event.sender = user('other');
    expect(
      await resolvePrRun({
        ...input,
        actor: 'other',
        eventName: 'workflow_dispatch',
        commentId: '99',
      }),
    ).toMatchObject({ ok: false, code: 'E_PR_RUN_REQUEST' });
  });

  it.each(['requester', 'author'])(
    'checks the %s current permission before collecting context',
    async (who) => {
      const { input, github } = setup();
      github.on(
        'GET',
        `${API}/collaborators/${who === 'requester' ? 'maintainer' : 'author'}/permission`,
        { body: { permission: 'read' } },
      );
      expect(await resolvePrRun(input)).toMatchObject({
        ok: false,
        code: 'E_PR_RUN_REQUEST',
      });
      expect(
        github.requests.some((request) =>
          request.path.includes('/pulls/7/comments'),
        ),
      ).toBe(false);
    },
  );

  it.each([
    ['closed', { state: 'closed' }],
    [
      'fork',
      {
        head: {
          sha: HEAD,
          ref: 'feature/fix',
          repo: { full_name: 'other/fork' },
        },
      },
    ],
    [
      'default head',
      { head: { sha: HEAD, ref: 'main', repo: { full_name: REPOSITORY } } },
    ],
    [
      'same head and base',
      {
        base: {
          sha: BASE,
          ref: 'feature/fix',
          repo: { full_name: REPOSITORY },
        },
      },
    ],
  ])('refuses a %s PR', async (_name, overrides) => {
    const { input, pull } = setup();
    Object.assign(pull, overrides);
    expect(await resolvePrRun(input)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_REQUEST',
    });
  });

  it('requires an exact allowlist grant for a bot PR author', async () => {
    const { input, pull } = setup();
    pull.user = { login: 'dependabot[bot]', type: 'Bot' };
    expect(await resolvePrRun(input)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_REQUEST',
    });
    expect(
      await resolvePrRun({ ...input, allowedPrAuthors: ['dependabot[bot]'] }),
    ).toMatchObject({ ok: true, value: { status: 'ready' } });
  });

  it.each([
    '/agent-ci',
    `/agent-ci ${'x'.repeat(16 * 1024 + 1)}`,
    '/agent-ci fix\0it',
  ])('refuses an empty or oversized or NUL task', async (body) => {
    const { input } = setup(body);
    expect(await resolvePrRun(input)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_REQUEST',
    });
  });

  it('fails closed on a malformed PR or failed current-permission lookup', async () => {
    const malformed = setup();
    malformed.pull.head = {
      sha: 'not-a-sha',
      ref: 'feature/fix',
      repo: { full_name: REPOSITORY },
    };
    expect(await resolvePrRun(malformed.input)).toMatchObject({
      ok: false,
      code: 'E_GITHUB_API',
    });
    const failed = setup();
    failed.github.on('GET', `${API}/collaborators/maintainer/permission`, {
      status: 503,
    });
    expect(await resolvePrRun(failed.input)).toMatchObject({
      ok: false,
      code: 'E_GITHUB_API',
    });
  });

  it('captures review observations with their raw resolution-state limitation and bounds UTF-8 context', async () => {
    const { input, github } = setup();
    github.on('GET', `${API}/pulls/7/comments`, {
      body: [
        {
          id: 40,
          user: user('reviewer'),
          path: 'src/app.ts',
          line: 12,
          body: 'Please fix the return value.',
        },
      ],
    });
    const first = await resolvePrRun(input);
    expect(
      first.ok && first.value.status === 'ready' && first.value.request.context,
    ).toContain('Please fix the return value.');
    expect(
      first.ok && first.value.status === 'ready' && first.value.request.context,
    ).toContain('includes resolved and unresolved');
    github.on('GET', `${API}/issues/7/comments`, {
      body: [{ id: 41, user: user('reviewer'), body: '😀'.repeat(30_000) }],
    });
    const bounded = await resolvePrRun(input);
    expect(bounded.ok && bounded.value.status).toBe('ready');
    if (!bounded.ok || bounded.value.status !== 'ready') return;
    expect(
      Buffer.byteLength(bounded.value.request.context, 'utf8'),
    ).toBeLessThanOrEqual(PR_RUN_CONTEXT_BYTES);
    expect(bounded.value.request.context).toContain('[Context truncated:');
    expect(bounded.value.request.context).not.toContain('\uFFFD');
  });

  it('discloses pagination truncation and rejects a non-list context response', async () => {
    const { input, github } = setup();
    github.on('GET', `${API}/pulls/7/reviews`, {
      body: Array.from({ length: 100 }, (_, id) => ({ id, body: 'Review' })),
      link: '<https://api.github.com/page=3>; rel="next"',
    });
    const bounded = await resolvePrRun(input);
    expect(
      bounded.ok &&
        bounded.value.status === 'ready' &&
        bounded.value.request.context,
    ).toContain('[Context truncated:');
    github.on('GET', `${API}/pulls/7/reviews`, { body: { reviews: [] } });
    expect(await resolvePrRun(input)).toMatchObject({
      ok: false,
      code: 'E_GITHUB_API',
    });
  });

  it('does not accept forged webhook repository or sender identity', async () => {
    for (const overrides of [
      { repository: { full_name: 'other/repo' } },
      { sender: user('other') },
    ]) {
      const { input, event, github } = setup();
      Object.assign(event, overrides);
      expect(await resolvePrRun(input)).toMatchObject({
        ok: false,
        code: 'E_PR_RUN_REQUEST',
      });
      expect(github.requests).toEqual([]);
    }
  });
});

describe('parsePrRunRequest', () => {
  it('rejects artifact fields that could redirect publication', async () => {
    const { input } = setup();
    const result = await resolvePrRun(input);
    if (!result.ok || result.value.status !== 'ready')
      throw new Error('expected a ready request');
    for (const overrides of [
      { repository: '../other' },
      { headRef: 'feature\nother=value' },
      { headSha: '-bad-option' },
      { prUrl: 'https://github.com/other/repo/pull/7' },
      { actor: 'some-bot[bot]' },
      { skills: ['unexpected-parser-output'] },
    ])
      expect(
        parsePrRunRequest({ ...result.value.request, ...overrides }),
      ).toMatchObject({ ok: false, code: 'E_PR_RUN_REQUEST' });
  });
});
