import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runLocalReview } from '@agent-ci/review/local.js';
import { FakeGithub } from '@agent-ci/review/testing/fake-github.js';
import {
  completedResponse,
  responsesServer,
} from '@agent-ci/run/testing/responses.js';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';

it('local verify-review bypasses the direct adjudicator CLI pin while keeping the reviewer bridge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-local-direct-'));
  let hits = 0;
  const server = await responsesServer((_req, res) => {
    hits++;
    res.end(JSON.stringify(completedResponse()));
  });
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  try {
    await mkdir(path.join(root, '.github/agent-ci'), { recursive: true });
    await writeFile(
      path.join(root, '.github/agent-ci/checks.yaml'),
      'version: 1\nchecks:\n  - name: test\n    command: exit 1\n    description: one failing check\n',
    );
    await writeFile(path.join(root, 'a.ts'), 'const x = 1;\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'a.ts'), 'const x = 1;\nconst y = 2;\n');
    git('commit', '-qam', 'head');
    const head = git('rev-parse', 'HEAD');
    const diff = `${git('diff', `${base}...${head}`)}\n`;
    git('remote', 'add', 'origin', root);
    const repo = 'fixture/project';
    const api = `/repos/${repo}`;
    const github = new FakeGithub()
      .on('GET', `${api}/pulls/1/comments`, { body: [] })
      .on('GET', '/user', { body: { login: 'fixture', type: 'User' } })
      .on('GET', `${api}/collaborators/fixture/permission`, {
        body: { permission: 'write' },
      })
      .on('GET', `${api}/pulls/1`, {
        body: {
          number: 1,
          state: 'open',
          draft: false,
          title: 'Change',
          body: '',
          user: { login: 'fixture', type: 'User' },
          head: { sha: head, repo: { full_name: repo } },
          base: { sha: base, ref: 'main', repo: { full_name: repo } },
        },
      })
      .on('GET', `${api}/compare/${base}...${head}`, (request) =>
        request.accept === 'application/vnd.github.diff'
          ? { text: diff }
          : { body: { merge_base_commit: { sha: base } } },
      )
      .on('GET', `${api}/pulls/1/files`, {
        body: [{ filename: 'a.ts', status: 'modified' }],
      })
      .on('GET', `${api}/git/ref/heads/main`, {
        body: { object: { type: 'commit', sha: base } },
      })
      .serveGitDatabase(api, root);
    const modelsPath = path.join(root, 'models.yaml');
    await writeFile(
      modelsPath,
      stringify({
        version: 1,
        routes: [
          server.route,
          {
            id: 'fake-review',
            model: 'fake-verify-review',
            providerModel: 'verify-review',
            harness: 'fake',
            family: 'fake',
            credentials: [],
            login: false,
            billing: 'none',
            account: 'personal',
            structuredOutput: 'prompt',
            qualified: null,
          },
        ],
      }),
    );
    const outDir = path.join(root, 'output');
    const result = await runLocalReview({
      github: github.client(),
      repository: repo,
      prNumber: 1,
      cwd: root,
      reviewerModel: 'fake-verify-review',
      adjudicatorModel: 'gpt-6.1-sol-low',
      allowPool: true,
      seedLogin: false,
      publish: false,
      verify: true,
      trustPrCode: true,
      verifyConfigRef: 'main',
      scope: 'default',
      policy: {},
      outDir,
      timeoutMs: 60_000,
      modelsPath,
      git: '/usr/bin/git',
      // No codex (or node via PATH) available: only the existing absolute
      // fake reviewer/bridge executables and native fetch may run.
      env: {
        PATH: '/usr/bin:/bin',
        AGENT_CI_PROXY_API_KEY: 'opaque-local-fixture-0921',
      },
      log: () => {},
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result).toMatchObject({ ok: true });
    expect(hits).toBe(1);
    expect(
      JSON.parse(
        await readFile(
          path.join(outDir, 'adjudication/adjudicator.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      status: 'completed',
      transport: 'adjudicator-responses',
    });
    expect(
      JSON.parse(
        await readFile(path.join(outDir, 'primary/pass.json'), 'utf8'),
      ),
    ).toMatchObject({ ok: true, checks_served: ['test'] });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
