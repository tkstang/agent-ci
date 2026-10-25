import path from 'node:path';

import {
  contractError,
  type GatedReview,
  isReviewError,
  REVIEW_WORKFLOW,
  type ReviewIdentity,
  validateGatedReview,
  validateIdentity,
} from '@agent-ci/review/contracts.js';
import { readArtifactFile, verifyArtifactDir } from '@agent-ci/review/files.js';
import { GATED_FILES } from '@agent-ci/review/findings.js';
import { type GithubClient, repositoryPath } from '@agent-ci/review/github.js';
import {
  findingMarker,
  isSummaryComment,
  parsePostedMarkers,
  type PublisherIdentity,
  REJECTED_HEADING,
  renderReview,
  renderSummary,
  type ReviewPayload,
  summaryMarker,
  type UsageRow,
} from '@agent-ci/review/render.js';

/**
 * Publishing a gated review, ported from pntr's
 * `pntr-pr-review/publish-review.ts` (voxmedia/pntr@e438668). The publish
 * job holds a GitHub token and no model credential. It reads only the
 * gate's exact `review-gated.json` (by digest), rechecks the PR before
 * posting, refreshes dedupe from the publisher's own markers, posts one
 * `COMMENT` review with an explicit `commit_id`, then updates the single
 * summary comment.
 */

/** Trusted error codes from earlier jobs, mapped to reader-facing text. */
const FAILURE_TEXT: Record<string, string> = {
  E_DIFF_TOO_LARGE:
    'GitHub could not produce the diff for this PR because it is too large, so no review ran.',
  E_INVALID_DIFF:
    'the PR diff could not be parsed safely, so no review was published.',
  E_REVIEW_STALE_HEAD:
    'the PR head changed after the review was requested. Request the review again.',
  E_REVIEW_GUIDANCE:
    "this workflow's review guidance inputs are invalid or larger than agent-ci's caps. A maintainer needs to fix the workflow file.",
  E_VERIFY_CONFIG:
    'verify-review needs a valid checks configuration at `.github/agent-ci/checks.yaml` on the base branch. A maintainer needs to add or fix it.',
};

export type PublishContext = {
  repository: string;
  prNumber: number;
  headSha: string;
  scope: string;
  runId: string;
  runAttempt: string;
  /** Link to the workflow run; `null` for a local run. */
  runUrl: string | null;
};

export type PublishOutcome = {
  status:
    | 'published'
    | 'summary-only'
    | 'nothing-new'
    | 'stale'
    | 'closed'
    | 'failed-run';
  reviewPosted: boolean;
  /** True when the job must fail after publishing. */
  fail: boolean;
  reasons: string[];
};

/** Trusted identity of this run, built from the workflow context. */
export function trustedIdentity(context: PublishContext): ReviewIdentity {
  return validateIdentity({
    repository: context.repository,
    workflow: REVIEW_WORKFLOW,
    pr_number: context.prNumber,
    scope: context.scope,
    run_id: context.runId,
    run_attempt: context.runAttempt,
  });
}

/**
 * Load the gate's artifact: the exact directory the findings job reported
 * (content digest), a valid gated review, bound to this repository, PR,
 * scope and captured head.
 */
export async function loadGated(input: {
  dir: string;
  digest: string;
  context: PublishContext;
}): Promise<{ gated: GatedReview; usage: UsageRow[] }> {
  await verifyArtifactDir(input.dir, input.digest);
  const text = await readArtifactFile(
    path.join(input.dir, GATED_FILES.gated),
    32 * 1024 * 1024,
  );
  if (text === null)
    contractError('E_REVIEW_INPUT', 'no gated review to publish');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return contractError('E_REVIEW_INPUT', 'the gated review is not JSON');
  }
  const gated = validateGatedReview(raw);
  const trusted = trustedIdentity(input.context);
  if (
    gated.identity.repository !== trusted.repository ||
    gated.identity.workflow !== trusted.workflow ||
    gated.identity.pr_number !== trusted.pr_number ||
    gated.identity.scope !== trusted.scope ||
    gated.head_sha !== input.context.headSha
  )
    contractError(
      'E_REVIEW_INPUT',
      'the gated review belongs to another repository, PR, scope or head',
    );
  let usage: UsageRow[] = [];
  try {
    const rows = JSON.parse(
      (await readArtifactFile(
        path.join(input.dir, GATED_FILES.usage),
        1024 * 1024,
      )) ?? '[]',
    ) as unknown;
    if (Array.isArray(rows)) usage = rows as UsageRow[];
  } catch {
    usage = [];
  }
  return { gated, usage };
}

/** Insert notes just above the summary's final marker line. */
function withNotes(summary: string, notes: readonly string[]): string {
  if (notes.length === 0) return summary;
  const lines = summary.split('\n');
  const marker = lines.pop()!;
  return [...lines, ...notes.flatMap((note) => [note, '']), marker].join('\n');
}

async function upsertSummary(
  github: GithubClient,
  context: PublishContext,
  identity: ReviewIdentity,
  publisher: PublisherIdentity,
  body: string,
): Promise<void> {
  const repo = repositoryPath(context.repository);
  const { items } = await github.paginate(
    `${repo}/issues/${context.prNumber}/comments`,
    30,
  );
  const existing = items.find((comment) =>
    isSummaryComment(comment, identity, publisher),
  ) as { id?: unknown } | undefined;
  if (existing && typeof existing.id === 'number' && existing.id > 0)
    await github.send({
      method: 'PATCH',
      path: `${repo}/issues/comments/${existing.id}`,
      body: { body },
    });
  else
    await github.send({
      method: 'POST',
      path: `${repo}/issues/${context.prNumber}/comments`,
      body: { body },
    });
}

type PullState = { open: boolean; headSha: string | null };
async function pullState(
  github: GithubClient,
  context: PublishContext,
): Promise<PullState> {
  const pr = (await github.json({
    method: 'GET',
    path: `${repositoryPath(context.repository)}/pulls/${context.prNumber}`,
  })) as { state?: unknown; head?: { sha?: unknown } } | null;
  const head = pr?.head?.sha;
  return {
    open: pr?.state === 'open',
    headSha: typeof head === 'string' ? head : null,
  };
}

/** Drop findings whose markers the publisher posted since the gate ran. */
export function refreshDedupe(
  gated: GatedReview,
  postedComments: readonly unknown[],
  publisher: PublisherIdentity,
): GatedReview {
  const posted = new Set(
    parsePostedMarkers(postedComments, gated.identity, publisher).map((m) =>
      findingMarker(gated.identity, m),
    ),
  );
  return {
    ...gated,
    findings: gated.findings.map((finding) =>
      finding.disposition === 'posted' &&
      posted.has(findingMarker(gated.identity, finding))
        ? { ...finding, disposition: 'duplicate' }
        : finding,
    ),
  };
}

/** Publish a gated review. */
export async function publishReview(input: {
  github: GithubClient;
  context: PublishContext;
  publisher: PublisherIdentity;
  gated: GatedReview;
  usage: UsageRow[];
  log?: (line: string) => void;
}): Promise<PublishOutcome> {
  const { github, context, publisher } = input;
  const log = input.log ?? (() => undefined);
  const identity = input.gated.identity;
  const repo = repositoryPath(context.repository);
  const reasons: string[] = [];
  if (input.gated.fail_on_severity_triggered)
    reasons.push('fail_on_severity was triggered');
  if (input.gated.review_status === 'incomplete')
    reasons.push('the review is incomplete');

  const state = await pullState(github, context);
  if (!state.open) {
    // Nothing is posted to a closed PR, but an incomplete or failing review
    // still fails the run.
    log(
      `::notice title=agent-ci PR review::PR #${context.prNumber} is no longer open, so the review was not posted.`,
    );
    return {
      status: 'closed',
      reviewPosted: false,
      fail: reasons.length > 0,
      reasons,
    };
  }
  if (state.headSha !== input.gated.head_sha) {
    await upsertSummary(
      github,
      context,
      identity,
      publisher,
      [
        '## agent-ci PR review',
        '',
        `This run reviewed head \`${input.gated.head_sha.slice(0, 12)}\`, but the PR head moved${
          state.headSha ? ` to \`${state.headSha.slice(0, 12)}\`` : ''
        } before it could publish, so its findings were not posted. Request the review again.${context.runUrl === null ? '' : ` [Run](${context.runUrl})`}`,
        '',
        summaryMarker(identity),
      ].join('\n'),
    );
    return {
      status: 'stale',
      reviewPosted: false,
      fail: true,
      reasons: [...reasons, 'the PR head moved before publication'],
    };
  }

  const { items } = await github.paginate(
    `${repo}/pulls/${context.prNumber}/comments`,
    30,
  );
  const gated = refreshDedupe(input.gated, items, publisher);
  const payload: ReviewPayload | null = renderReview(gated);
  const notes: string[] = [
    context.runUrl === null ? '' : `<sub>[Run](${context.runUrl})</sub>`,
  ].filter((note) => note !== '');
  let status: PublishOutcome['status'] = 'nothing-new';
  let reviewPosted = false;
  if (payload !== null) {
    const response = await github.send(
      {
        method: 'POST',
        path: `${repo}/pulls/${context.prNumber}/reviews`,
        body: payload,
      },
      [200, 201, 422],
    );
    if (response.status === 422) {
      status = 'summary-only';
      notes.unshift(
        `> [!WARNING]\n> GitHub rejected the inline review for this run, so its new findings were not posted inline. They are listed in this summary under "${REJECTED_HEADING}".`,
      );
    } else {
      status = 'published';
      reviewPosted = true;
    }
  }
  await upsertSummary(
    github,
    context,
    identity,
    publisher,
    withNotes(
      renderSummary(gated, input.usage, {
        inlineRejected: status === 'summary-only',
      }),
      notes,
    ),
  );
  return { status, reviewPosted, fail: reasons.length > 0, reasons };
}

/** A visible failure summary when no gated review exists. */
export function failureSummary(
  context: PublishContext,
  codes: readonly string[],
): string {
  const known = codes.find((code) => Object.hasOwn(FAILURE_TEXT, code));
  const text =
    known !== undefined
      ? FAILURE_TEXT[known]!
      : `the review did not complete${
          codes.length ? ` (${codes.map((c) => `\`${c}\``).join(', ')})` : ''
        }. No findings were published.`;
  return [
    '## agent-ci PR review',
    '',
    `**Review:** **incomplete** · **Head:** \`${context.headSha.slice(0, 12)}\``,
    '',
    `> [!WARNING]\n> The review could not be published: ${text}${context.runUrl === null ? '' : ` [Run](${context.runUrl})`}`,
    '',
    summaryMarker(trustedIdentity(context)),
  ].join('\n');
}

/**
 * Publish a gated review directory, or a failure summary from trusted
 * error codes when earlier jobs reported one or the directory is unusable.
 */
export async function publishGated(input: {
  github: GithubClient;
  context: PublishContext;
  publisher: PublisherIdentity;
  dir: string | undefined;
  digest: string | undefined;
  errorCodes: readonly string[];
  log?: (line: string) => void;
}): Promise<PublishOutcome> {
  const codes = input.errorCodes
    .map((code) => code.trim())
    .filter((code) => ERROR_CODE.test(code));
  let loaded: { gated: GatedReview; usage: UsageRow[] } | null = null;
  if (codes.length === 0) {
    if (input.dir === undefined || input.dir === '')
      codes.push('E_REVIEW_INPUT');
    else
      try {
        loaded = await loadGated({
          dir: input.dir,
          digest: input.digest ?? '',
          context: input.context,
        });
      } catch (error) {
        if (!isReviewError(error)) throw error;
        codes.push(error.code);
      }
  }
  if (loaded === null) {
    const identity = trustedIdentity(input.context);
    await upsertSummary(
      input.github,
      input.context,
      identity,
      input.publisher,
      failureSummary(input.context, codes),
    );
    return {
      status: 'failed-run',
      reviewPosted: false,
      fail: true,
      reasons: codes,
    };
  }
  return await publishReview({
    github: input.github,
    context: input.context,
    publisher: input.publisher,
    ...loaded,
    ...(input.log === undefined ? {} : { log: input.log }),
  });
}

const ERROR_CODE = /^E_[A-Z0-9_]{1,63}$/u;
