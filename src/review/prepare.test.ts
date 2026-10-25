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
