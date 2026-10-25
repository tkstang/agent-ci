import path from 'node:path';

import type { Usage } from '@agent-ci/harness/types.js';
import {
  type GatedReview,
  type PostedMarker,
  type ReviewIdentity,
  type ReviewPass,
  validateGatedReview,
} from '@agent-ci/review/contracts.js';
import {
  parseUnifiedDiff,
  type SourceReader,
} from '@agent-ci/review/diff-position.js';
import { readArtifactFile, verifyArtifactDir } from '@agent-ci/review/files.js';
import { gateReview, type PassInput } from '@agent-ci/review/gate.js';
import { type GithubClient, repositoryPath } from '@agent-ci/review/github.js';
import {
  PASS_FILES,
  parsePassRecord,
  type PassRecord,
} from '@agent-ci/review/pass.js';
import type { LoadedSpec } from '@agent-ci/review/prepare.js';
import {
  parsePostedMarkers,
  type PublisherIdentity,
  type UsageRow,
} from '@agent-ci/review/render.js';
import {
  ADJUDICATION_FILES,
  type AdjudicatorRecord,
} from '@agent-ci/review/run-adjudicator.js';
import type { ReviewPolicy } from '@agent-ci/review/trigger.js';

/**
 * The findings gate over downloaded artifacts (a job with a read-only
 * GitHub token, no model credential and no checkout of PR code). Every
 * pass's `review.json` and the adjudication are untrusted data, read only
 * from the directory whose digest the producing job reported; a directory
 * that does not match counts as no output. Writes `review-gated.json` and
 * `usage.json` for the publisher.
 */

export const GATED_FILES = Object.freeze({
  gated: 'review-gated.json',
  usage: 'usage.json',
});

const REVIEW_MAX_BYTES = 4 * 1024 * 1024;

export type LoadedPass = {
  pass: ReviewPass;
  review: unknown;
  record: PassRecord | null;
  /** Why no review was read, when none was. */
  problem: string | null;
};

/** One pass's artifact directory, verified against its job's digest. */
export async function loadPassDir(input: {
  pass: ReviewPass;
  dir: string | undefined;
  digest: string | undefined;
}): Promise<LoadedPass> {
  const empty = (problem: string): LoadedPass => ({
    pass: input.pass,
    review: null,
    record: null,
    problem,
  });
  if (input.dir === undefined || input.dir === '') return empty('no artifact');
  try {
    await verifyArtifactDir(input.dir, input.digest ?? '');
  } catch {
    return empty('artifact digest mismatch');
  }
  const record = parsePassRecord(
    await readArtifactFile(path.join(input.dir, PASS_FILES.pass), 64 * 1024),
  );
  const text = await readArtifactFile(
    path.join(input.dir, PASS_FILES.review),
    REVIEW_MAX_BYTES,
  );
  if (text === null)
    return {
      pass: input.pass,
      review: null,
      record,
      problem: 'no review.json',
    };
  try {
    return {
      pass: input.pass,
      review: JSON.parse(text),
      record,
      problem: null,
    };
  } catch {
    return {
      pass: input.pass,
      review: null,
      record,
      problem: 'review.json is not JSON',
    };
  }
}

export type LoadedAdjudication = {
  value: unknown;
  record: AdjudicatorRecord | null;
};

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The adjudicate job's directory, verified against its digest. */
export async function loadAdjudicationDir(input: {
  dir: string | undefined;
  digest: string | undefined;
}): Promise<LoadedAdjudication> {
  if (input.dir === undefined || input.dir === '')
    return { value: null, record: null };
  try {
    await verifyArtifactDir(input.dir, input.digest ?? '');
  } catch {
    return { value: null, record: null };
  }

  const value = parseJson(
    await readArtifactFile(
      path.join(input.dir, ADJUDICATION_FILES.adjudication),
      REVIEW_MAX_BYTES,
    ),
  );
  const record = parseJson(
    await readArtifactFile(
      path.join(input.dir, ADJUDICATION_FILES.record),
      64 * 1024,
    ),
  ) as AdjudicatorRecord | null;
  return { value, record };
}

/** Markers this scope already posted, from the publisher's own comments. */
export async function postedMarkers(input: {
  github: GithubClient;
  identity: ReviewIdentity;
  publisher: PublisherIdentity;
}): Promise<PostedMarker[]> {
  const { items } = await input.github.paginate(
    `${repositoryPath(input.identity.repository)}/pulls/${input.identity.pr_number}/comments`,
    30,
  );
  return parsePostedMarkers(items, input.identity, input.publisher);
}

/** Run the deterministic gate over loaded artifacts. */
export function gateArtifacts(input: {
  spec: LoadedSpec;
  identity: ReviewIdentity;
  attempt: string;
  passes: readonly LoadedPass[];
  adjudication: unknown;
  read: SourceReader;
  posted: readonly PostedMarker[];
  policy: ReviewPolicy;
}): GatedReview {
  const { spec } = input.spec;
  const passes: PassInput[] = [];
  for (const name of ['primary', 'second'] as const) {
    const enabled = name === 'primary' || spec.request.second.enabled;
    if (!enabled) continue;
    const loaded = input.passes.find((p) => p.pass === name);
    passes.push({
      pass: name,
      enabled: true,
      attempt: input.attempt,
      review: loaded?.review ?? null,
    });
  }
  return validateGatedReview(
    gateReview({
      identity: input.identity,
      mode: spec.request.mode,
      base_sha: spec.base_sha,
      merge_base_sha: spec.merge_base_sha,
      head_sha: spec.head_sha,
      diff: parseUnifiedDiff(input.spec.diffText, {
        truncated: spec.diff.truncated,
      }),
      read: input.read,
      passes,
      adjudication: {
        enabled: spec.request.adjudicator.enabled,
        value: input.adjudication,
      },
      policy: input.policy,
      posted: [...input.posted],
    }),
    input.identity,
  );
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function row(
  pass: UsageRow['pass'],
  model: string | null,
  usage: Usage | null | undefined,
  notes: unknown = [],
): UsageRow {
  const kept = Array.isArray(notes)
    ? notes
        .filter((note): note is string => typeof note === 'string')
        .slice(0, 5)
    : [];
  return {
    pass,
    ...(kept.length === 0 ? {} : { notes: kept }),
    model,
    input_tokens: count(usage?.inputTokens),
    output_tokens: count(usage?.outputTokens),
    cache_read_tokens: count(usage?.cacheReadTokens),
    cache_write_tokens: count(usage?.cacheWriteTokens),
    reported_cost_usd: count(usage?.costUsd),
  };
}

/** Usage rows for the summary, from each stage's own record. */
export function usageRows(
  passes: readonly LoadedPass[],
  adjudicator: AdjudicatorRecord | null,
): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const pass of passes)
    if (pass.record !== null)
      rows.push(
        row(
          pass.pass,
          pass.record.model,
          pass.record.usage,
          pass.record.warnings,
        ),
      );
  if (adjudicator !== null && adjudicator.status !== 'skipped')
    rows.push(row('adjudicator', adjudicator.model, adjudicator.usage));
  return rows;
}
