import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import type { PrRunRequest } from '@agent-ci/pr-run/request.js';
import { digestResultDir } from '@agent-ci/publish/digest.js';
import { FakeGithub } from '@agent-ci/review/testing/fake-github.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pr-command-'));
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  git(cwd, 'init', '-q', '-b', 'topic');
  await writeFile(path.join(cwd, 'README.md'), '# test\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'test: seed');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const request: PrRunRequest = {
    version: 1,
    repository: 'test/repo',
    prNumber: 7,
    commentId: 42,
    actor: 'maintainer',
    headSha: head,
    headRef: 'topic',
    baseSha: head,
    baseRef: 'main',
    prompt:
      'Use $fix-ci and then $address-feedback; leave PHP $response unchanged.',
    context: 'Untrusted review observation.',
    prUrl: 'https://github.com/test/repo/pull/7',
  };
  const requestDir = path.join(root, 'request');
  await mkdir(requestDir);
  await writeFile(
    path.join(requestDir, 'request.json'),
    JSON.stringify(request),
  );
  const digest = await digestResultDir(requestDir);
  if (!digest.ok) throw new Error(digest.message);
  const context = {
    cwd,
    env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'test/repo' },
    log: () => {},
  };
  const flags = [
    '--request-dir',
    requestDir,
    '--request-digest',
    digest.value,
    '--cwd',
    cwd,
  ];
  return { root, cwd, requestDir, context, flags, head };
}

describe('pr-run command artifact and execution boundary', () => {
  it('executes the pinned PR task and independently materializes the same resulting files', async () => {
    const f = await fixture();
    const out = path.join(f.root, 'result');
    const executed = await run(
      [
        'pr-run',
        'execute',
        ...f.flags,
        '--route',
        'fake-edit',
        '--out',
        out,
        '--home-root',
        path.join(f.root, 'home'),
        '--max-attempts',
        '1',
      ],
      f.context,
    );
    expect(executed.envelope).toMatchObject({
      ok: true,
      data: { status: 'changed', headSha: f.head },
    });
    const content = await readFile(
      path.join(f.cwd, 'agent-ci-fake-edit.md'),
      'utf8',
    );
    const prompt = await readFile(path.join(out, 'prompt.md'), 'utf8');
    expect(prompt).toContain(
      'Use $fix-ci and then $address-feedback; leave PHP $response unchanged.',
    );
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.head);
    git(f.cwd, 'clean', '-fd');
    const digest = await digestResultDir(out);
    if (!digest.ok) throw new Error(digest.message);
    const restored = await run(
      [
        'pr-run',
        'materialize',
        ...f.flags,
        '--result-dir',
        out,
        '--result-digest',
        digest.value,
      ],
      f.context,
    );
    expect(restored.envelope).toMatchObject({
      ok: true,
      data: { status: 'ready' },
    });
    expect(
      await readFile(path.join(f.cwd, 'agent-ci-fake-edit.md'), 'utf8'),
    ).toBe(content);
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it('refuses a modified request before editing the checkout', async () => {
    const f = await fixture();
    await writeFile(path.join(f.requestDir, 'request.json'), '{}');
    const result = await run(
      [
        'pr-run',
        'execute',
        ...f.flags,
        '--route',
        'fake-edit',
        '--out',
        path.join(f.root, 'out'),
        '--home-root',
        path.join(f.root, 'home'),
      ],
      f.context,
    );
    expect(result.envelope).toMatchObject({ ok: false, code: 'E_PUBLISH' });
    expect(git(f.cwd, 'status', '--porcelain')).toBe('');
  });

  it('refuses to run on a different head or a checkout with tracked setup edits', async () => {
    for (const mode of ['different-head', 'dirty']) {
      const f = await fixture();
      await writeFile(path.join(f.cwd, 'README.md'), '# changed\n');
      if (mode === 'different-head') {
        git(f.cwd, 'add', '.');
        git(f.cwd, 'commit', '-qm', 'test: another head');
      }
      const result = await run(
        [
          'pr-run',
          'execute',
          ...f.flags,
          '--route',
          'fake-edit',
          '--out',
          path.join(f.root, 'out'),
          '--home-root',
          path.join(f.root, 'home'),
        ],
        f.context,
      );
      expect(result.envelope, mode).toMatchObject({
        ok: false,
        code: 'E_PR_RUN_REQUEST',
      });
    }
  });
});

async function gateFixture(body: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pr-profile-'));
  const api = '/repos/test/repo';
  const user = { login: 'maintainer', type: 'User' };
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const comment = {
    id: 42,
    body,
    user,
    issue_url: 'https://api.github.com/repos/test/repo/issues/7',
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
  };
  const eventFile = path.join(root, 'event.json');
  await writeFile(
    eventFile,
    JSON.stringify({
      action: 'created',
      repository: { full_name: 'test/repo' },
      sender: user,
      issue: { number: 7, pull_request: {} },
      comment,
    }),
  );
  const github = new FakeGithub()
    .on('GET', `${api}/issues/comments/42`, { body: comment })
    .on('GET', `${api}/collaborators/maintainer/permission`, {
      body: { permission: 'write' },
    })
    .on('GET', `${api}/pulls/7`, {
      body: {
        number: 7,
        state: 'open',
        title: 'Profile test',
        body: '',
        user,
        head: { sha: head, ref: 'topic', repo: { full_name: 'test/repo' } },
        base: { sha: base, ref: 'main', repo: { full_name: 'test/repo' } },
        html_url: 'https://github.com/test/repo/pull/7',
      },
    })
    .on('GET', api, { body: { default_branch: 'main' } })
    .on('GET', `${api}/git/ref/heads/topic`, {
      body: { ref: 'refs/heads/topic', object: { type: 'commit', sha: head } },
    })
    .on('GET', `${api}/git/ref/heads/main`, {
      body: { ref: 'refs/heads/main', object: { type: 'commit', sha: base } },
    })
    .on('GET', `${api}/issues/7/comments`, { body: [] })
    .on('GET', `${api}/pulls/7/reviews`, { body: [] })
    .on('GET', `${api}/pulls/7/comments`, { body: [] })
    .on('POST', `${api}/issues/comments/42/reactions`, { body: { id: 1 } });
  vi.stubGlobal('fetch', github.fetch());
  const output = path.join(root, 'github-output');
  await writeFile(output, '');
  const request = path.join(root, 'request');
  const context = {
    cwd: root,
    env: {
      GITHUB_TOKEN: 'synthetic-token',
      GITHUB_REPOSITORY: 'test/repo',
      GITHUB_ACTOR: 'maintainer',
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_OUTPUT: output,
      GITHUB_ACTIONS: 'true',
    },
    log: () => {},
  };
  const flags = [
    'pr-run',
    'gate',
    '--model',
    'fake-edit',
    '--harness',
    'fake',
    '--route',
    'fake-edit',
    '--allowed-models',
    'fake-edit fake-echo',
    '--out',
    request,
    '--github-output',
  ];
  return { root, github, output, request, context, flags };
}

describe('pr-run gate profile routing and credential boundary', () => {
  it.each([
    { body: '/agent-ci use $fix-ci', model: 'fake-edit', profile: undefined },
    {
      body: '/agent-ci --model-profile=balance use $fix-ci',
      model: 'fake-echo',
      profile: 'balance',
    },
  ])(
    'resolves $body before acknowledging and persisting the task',
    async ({ body, model, profile }) => {
      const f = await gateFixture(body);
      const result = await run(
        [...f.flags, '--model-profiles', 'balance: {model: fake-echo}'],
        f.context,
      );
      expect(result.envelope).toMatchObject({
        ok: true,
        data: { status: 'ready', model, routeId: model },
      });
      const outputs = await readFile(f.output, 'utf8');
      expect(outputs).toContain(`route_id=${model}\n`);
      expect(outputs).toContain('account=personal\n');
      expect(outputs).toContain('credential=\n');
      const request = JSON.parse(
        await readFile(path.join(f.request, 'request.json'), 'utf8'),
      ) as PrRunRequest;
      expect(request.prompt).toBe('use $fix-ci');
      expect(request.modelProfile).toBe(profile);
      expect(f.github.sent('POST')).toHaveLength(1);
    },
  );

  it.each([
    {
      body: '/agent-ci --model-profile=intelligence fix it',
      config: 'balance: {model: fake-echo}',
    },
    { body: '/agent-ci fix it', config: 'balance: {model: unlisted}' },
    {
      body: '/agent-ci fix it',
      config: 'balance: {model: fake-echo, credential: CUSTOM_TOKEN}',
    },
  ])(
    'refuses unavailable or invalid profile configuration before acknowledgement',
    async ({ body, config }) => {
      const f = await gateFixture(body);
      const result = await run(
        [...f.flags, '--model-profiles', config],
        f.context,
      );
      expect(result.envelope).toMatchObject({
        ok: false,
        code: 'E_PR_RUN_REQUEST',
      });
      expect(f.github.sent('POST')).toEqual([]);
      expect(await readFile(f.output, 'utf8')).toBe('');
      await expect(
        readFile(path.join(f.request, 'request.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([
    { credentials: '[CURSOR_API_KEY, OPENCODE_API_KEY]' },
    { credentials: '[CUSTOM_TOKEN]' },
  ])(
    'refuses a selected route with unsupported credentials $credentials',
    async ({ credentials }) => {
      const f = await gateFixture('/agent-ci fix it');
      const models = path.join(f.root, 'models.yaml');
      await writeFile(
        models,
        `version: 1
routes:
  - id: fake-edit
    model: fake-edit
    harness: fake
    family: fake
    providerModel: edit
    credentials: ${credentials}
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
`,
      );
      const result = await run([...f.flags, '--models', models], f.context);
      expect(result.envelope).toMatchObject({
        ok: false,
        code: 'E_ROUTE_CONFIG',
      });
      expect(f.github.sent('POST')).toEqual([]);
      expect(await readFile(f.output, 'utf8')).toBe('');
    },
  );

  it('ignores unrelated events without attempting route resolution', async () => {
    const f = await gateFixture('/agent-ci-review');
    const result = await run(
      [...f.flags, '--models', '/missing/models.yaml'],
      f.context,
    );
    expect(result.envelope).toMatchObject({
      ok: true,
      data: { status: 'ignored' },
    });
    expect(f.github.requests).toEqual([]);
    expect(await readFile(f.output, 'utf8')).toBe('status=ignored\n');
  });
});
