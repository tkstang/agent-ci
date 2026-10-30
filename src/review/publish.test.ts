import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { digestResultDir } from '@agent-ci/publish/digest.js';
import {
  type GatedFinding,
  type GatedReview,
  REVIEW_WORKFLOW,
  validateGatedReview,
} from '@agent-ci/review/contracts.js';
import { GATED_FILES } from '@agent-ci/review/findings.js';
import {
  type PublishContext,
  publishGated,
  publishReview,
} from '@agent-ci/review/publish.js';
import {
  ACTIONS_PUBLISHER,
  findingMarker,
  REJECTED_HEADING,
  summaryMarker,
} from '@agent-ci/review/render.js';
import { FakeGithub } from '@agent-ci/review/testing/fake-github.js';
import { describe, expect, it } from 'vitest';

const REPO = 'tkstang/app';
const API = `/repos/${REPO}`;
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const IDENTITY = {
  repository: REPO,
  workflow: REVIEW_WORKFLOW,
  pr_number: 7,
  scope: 'default',
  run_id: '500',
  run_attempt: '1',
};
const CONTEXT: PublishContext = {
  repository: REPO,
  prNumber: 7,
  headSha: HEAD,
  scope: 'default',
  runId: '500',
  runAttempt: '1',
  runUrl: 'https://github.com/tkstang/app/actions/runs/500',
};
const hex = (c: string) => c.repeat(64);

function finding(overrides: Partial<GatedFinding> = {}): GatedFinding {
  return {
    fingerprint: hex('1'),
    discriminator: hex('2'),
    passes: ['primary'],
    candidate_ids: ['primary-a1-F1'],
    severity: 'high',
    category: 'correctness',
    rule_id: null,
    title: 'Cache entry overwritten',
    body: 'Duplicate ids overwrite earlier entries.',
    diff_position: {
      path: 'src/cache.ts',
      side: 'RIGHT',
      line: 3,
      start_line: null,
    },
    code: 'x',
    suggestion: null,
    suggestion_status: 'none',
    evidence: [
      {
        kind: 'code',
        path: 'src/cache.ts',
        line: 3,
        end_line: 3,
        side: 'RIGHT',
      },
    ],
    disposition: 'posted',
    ...overrides,
  };
}
function gated(overrides: Partial<GatedReview> = {}): GatedReview {
  return validateGatedReview({
    version: 1,
    identity: IDENTITY,
    mode: 'review',
    base_sha: 'a'.repeat(40),
    merge_base_sha: 'b'.repeat(40),
    head_sha: HEAD,
    review_status: 'complete',
    diff_truncated: false,
    passes: [
      {
        pass: 'primary',
        enabled: true,
        status: 'valid',
        reason: null,
        attempt: '1',
        candidates: 1,
        valid: 1,
      },
      {
        pass: 'second',
        enabled: false,
        status: 'disabled',
        reason: null,
        attempt: null,
        candidates: 0,
        valid: 0,
      },
    ],
    adjudication: {
      enabled: false,
      status: 'disabled',
      reason: null,
      operations: [],
    },
    policy: { fail_on_severity: null, floor: 'medium', budget: 10 },
    fail_on_severity_triggered: false,
    summaries: [],
    candidates: [],
    findings: [finding()],
    not_reproduced: [],
    ...overrides,
  });
}

function github(
  options: {
    state?: string;
    head?: string;
    reviewStatus?: number;
    reviewComments?: unknown[];
    issueComments?: unknown[];
  } = {},
) {
  return new FakeGithub()
    .on('GET', `${API}/pulls/7`, {
      body: {
        state: options.state ?? 'open',
        head: { sha: options.head ?? HEAD },
      },
    })
    .on('GET', `${API}/pulls/7/comments`, {
      body: options.reviewComments ?? [],
    })
    .on('POST', `${API}/pulls/7/reviews`, {
      status: options.reviewStatus ?? 200,
      body: {},
    })
    .on('GET', `${API}/issues/7/comments`, {
      body: options.issueComments ?? [],
    })
    .on('POST', `${API}/issues/7/comments`, { status: 201, body: {} })
    .on('PATCH', `${API}/issues/comments/42`, { status: 200, body: {} });
}
const publish = (fake: FakeGithub, review: GatedReview) =>
  publishReview({
    github: fake.client(),
    context: CONTEXT,
    publisher: ACTIONS_PUBLISHER,
    gated: review,
    usage: [],
  });
const summaryOf = (fake: FakeGithub): string => {
  const last = fake.requests.filter((r) => r.path.includes('/issues/')).at(-1);
  return (last?.body as { body?: string } | undefined)?.body ?? '';
};

describe('publishReview', () => {
  it('posts one COMMENT review for the head, then the summary', async () => {
    const fake = github();
    expect(await publish(fake, gated())).toEqual({
      status: 'published',
      reviewPosted: true,
      fail: false,
      reasons: [],
    });
    expect(fake.sent('POST').map((r) => r.path)).toEqual([
      `${API}/pulls/7/reviews`,
      `${API}/issues/7/comments`,
    ]);
  });

  it('updates the existing summary comment instead of adding one', async () => {
    const fake = github({
      issueComments: [
        {
          id: 42,
          body: `old\n\n${summaryMarker(IDENTITY)}`,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
        // A look-alike from another account is never updated.
        {
          id: 43,
          body: `x\n\n${summaryMarker(IDENTITY)}`,
          user: { login: 'mallory', type: 'User' },
        },
      ],
    });
    await publish(fake, gated());
    expect(fake.sent('PATCH').map((r) => r.path)).toEqual([
      `${API}/issues/comments/42`,
    ]);
  });

  it('posts nothing inline for a finding the publisher already posted since the gate ran', async () => {
    const marker = findingMarker(IDENTITY, {
      fingerprint: hex('1'),
      discriminator: hex('2'),
    });
    const fake = github({
      reviewComments: [
        {
          body: `text\n\n${marker}`,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
      ],
    });
    expect((await publish(fake, gated())).status).toBe('nothing-new');
    expect(fake.sent('POST').map((r) => r.path)).toEqual([
      `${API}/issues/7/comments`,
    ]);
  });

  it('lists the findings in the summary when GitHub rejects the inline review', async () => {
    const fake = github({ reviewStatus: 422 });
    expect((await publish(fake, gated())).status).toBe('summary-only');
    expect(summaryOf(fake)).toContain(REJECTED_HEADING);
  });

  it('publishes nothing on a stale head and fails the run', async () => {
    const fake = github({ head: 'f'.repeat(40) });
    expect(await publish(fake, gated())).toMatchObject({
      status: 'stale',
      fail: true,
    });
    expect(fake.sent('POST').map((r) => r.path)).toEqual([
      `${API}/issues/7/comments`,
    ]);
    expect(summaryOf(fake)).toContain('the PR head moved');
  });

  it('posts nothing to a closed PR but still fails an incomplete review', async () => {
    const fake = github({ state: 'closed' });
    expect(
      await publish(fake, gated({ review_status: 'incomplete' })),
    ).toMatchObject({
      status: 'closed',
      fail: true,
      reasons: ['the review is incomplete'],
    });
    expect(fake.sent('POST')).toEqual([]);
  });

  it('fails the run after publishing when fail_on_severity triggered', async () => {
    const fake = github();
    expect(
      await publish(
        fake,
        gated({
          policy: { fail_on_severity: 'high', floor: 'medium', budget: 10 },
          fail_on_severity_triggered: true,
        }),
      ),
    ).toMatchObject({ status: 'published', fail: true });
  });
});

async function gatedDir(review: GatedReview) {
  const dir = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'agent-ci-gated-')),
    'gated',
  );
  await mkdir(dir);
  await writeFile(
    path.join(dir, GATED_FILES.gated),
    `${JSON.stringify(review, null, 2)}\n`,
  );
  await writeFile(path.join(dir, GATED_FILES.usage), '[]\n');
  const digest = await digestResultDir(dir);
  if (!digest.ok) throw new Error(digest.message);
  return { dir, digest: digest.value };
}

describe('publishGated', () => {
  it('publishes the exact directory the findings job reported', async () => {
    const fake = github();
    const { dir, digest } = await gatedDir(gated());
    expect(
      (
        await publishGated({
          github: fake.client(),
          context: CONTEXT,
          publisher: ACTIONS_PUBLISHER,
          dir,
          digest,
          errorCodes: [],
        })
      ).status,
    ).toBe('published');
  });

  it('posts a failure summary for a foreign directory or an earlier error code', async () => {
    for (const input of [
      {
        digest: hex('f'),
        errorCodes: [] as string[],
        expect: 'E_REVIEW_INPUT',
      },
      {
        digest: undefined,
        errorCodes: ['E_DIFF_TOO_LARGE'],
        expect: 'too large',
      },
    ]) {
      const fake = github();
      const { dir, digest } = await gatedDir(gated());
      const outcome = await publishGated({
        github: fake.client(),
        context: CONTEXT,
        publisher: ACTIONS_PUBLISHER,
        dir,
        digest: input.digest ?? digest,
        errorCodes: input.errorCodes,
      });
      expect(outcome).toMatchObject({
        status: 'failed-run',
        fail: true,
        reviewPosted: false,
      });
      expect(fake.sent('POST').map((r) => r.path)).toEqual([
        `${API}/issues/7/comments`,
      ]);
      expect(summaryOf(fake)).toContain(input.expect);
    }
  });

  it('refuses a gated review bound to another PR or head', async () => {
    const fake = github();
    const { dir, digest } = await gatedDir(
      gated({ identity: { ...IDENTITY, pr_number: 8 } }),
    );
    expect(
      await publishGated({
        github: fake.client(),
        context: CONTEXT,
        publisher: ACTIONS_PUBLISHER,
        dir,
        digest,
        errorCodes: [],
      }),
    ).toMatchObject({ status: 'failed-run', reasons: ['E_REVIEW_INPUT'] });
    expect(fake.sent('POST').some((r) => r.path.endsWith('/reviews'))).toBe(
      false,
    );
  });
});
