import {
  contractError,
  isRepoPath,
  isSha,
  sha256,
} from '@agent-ci/review/contracts.js';
import {
  type ParsedDiff,
  parseUnifiedDiff,
} from '@agent-ci/review/diff-position.js';
import { type GithubClient, repositoryPath } from '@agent-ci/review/github.js';
import {
  checkGuidance,
  type ReviewGuidanceInputs,
} from '@agent-ci/review/prompt.js';
import {
  type ResolvedRequestConfig,
  validateRequestConfig,
} from '@agent-ci/review/request.js';
import type { RequestRecord } from '@agent-ci/review/trigger.js';

/**
 * The review spec: the gate's bound request turned into the digest-bound
 * spec and diff that every reviewer pass, the adjudicator and the findings
 * gate consume. Ported from pntr's `pntr-pr-review/prepare.ts`
 * (voxmedia/pntr@e438668).
 *
 * GitHub's documented ceilings shape the truncation rules: the PR file
 * listing returns at most 3,000 files (100 per page), and a diff that is
 * too large to generate is refused (406 or 422) rather than cut. agent-ci
 * marks the diff truncated when the listing hit its ceiling, when the diff
 * holds fewer files than the listing, or when the parser finds a cut file
 * section; a refused or oversized diff stops the run visibly
 * (`E_DIFF_TOO_LARGE`). A diff is never reviewed silently as complete.
 */

/** File names inside the spec artifact directory. */
export const SPEC_FILES = Object.freeze({
  spec: 'spec.json',
  diff: 'pr.diff',
});

export const PREPARE_LIMITS = Object.freeze({
  /** Largest diff agent-ci accepts from GitHub. */
  diffBytes: 16 * 1024 * 1024,
  /** GitHub's PR file listing ceiling, in 100-file pages. */
  listingPages: 30,
});

const DIFF_ACCEPT = 'application/vnd.github.diff';

export type ReviewSpecDocument = {
  version: 1;
  request: ResolvedRequestConfig;
  request_id: string;
  repository: string;
  pr_number: number;
  base_ref: string;
  base_sha: string;
  merge_base_sha: string;
  head_sha: string;
  guidance: ReviewGuidanceInputs;
  diff: {
    truncated: boolean;
    files: number;
    additions: number;
    deletions: number;
    sha256: string;
  };
  changed_files: string[];
  pr: { title: string; body: string };
};

/** Read and verify a request record against its trusted digest. */
export function verifyRequest(
  text: string,
  expectedSha256: string,
  repository: string,
): RequestRecord {
  if (
    !/^[0-9a-f]{64}$/u.test(expectedSha256) ||
    sha256(text) !== expectedSha256
  )
    contractError(
      'E_REVIEW_INPUT',
      'the request record does not match its trusted digest',
    );
  let record: RequestRecord;
  try {
    record = JSON.parse(text) as RequestRecord;
  } catch {
    return contractError('E_REVIEW_INPUT', 'the request record is not JSON');
  }
  if (
    record?.version !== 1 ||
    record.repository !== repository ||
    !Number.isSafeInteger(record.pr_number) ||
    record.pr_number <= 0 ||
    !isSha(record.base_sha) ||
    !isSha(record.merge_base_sha) ||
    !isSha(record.head_sha) ||
    !/^[0-9a-f]{64}$/u.test(record.request_id)
  )
    contractError('E_REVIEW_INPUT', 'the request record is invalid');
  validateRequestConfig(record.config);
  return record;
}

async function headSha(
  github: GithubClient,
  repository: string,
  prNumber: number,
): Promise<string> {
  const pr = (await github.json({
    method: 'GET',
    path: `${repositoryPath(repository)}/pulls/${prNumber}`,
  })) as { head?: { sha?: unknown } } | null;
  const sha = pr?.head?.sha;
  if (typeof sha !== 'string' || !isSha(sha))
    contractError('E_GITHUB_API', 'the PR lookup returned no head');
  return sha;
}

/** Changed paths (head path, or the old path of a deletion) of a diff. */
export function diffPaths(diff: ParsedDiff): string[] {
  return diff.files.flatMap((file) => {
    const name = file.newPath ?? file.oldPath;
    return name === null ? [] : [name];
  });
}

/** The listed changed paths of a PR file listing (untrusted entries). */
export function listingPaths(items: readonly unknown[]): string[] {
  return items
    .map((item) => (item as { filename?: unknown } | null)?.filename)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Decide truncation from the parsed diff and the file listing: a capped
 * listing, a listed file missing from the diff, or a cut file section.
 */
export function detectTruncation(input: {
  diff: ParsedDiff;
  listed: readonly string[];
  listingCapped: boolean;
}): { truncated: boolean; missing: string[] } {
  const inDiff = new Set(diffPaths(input.diff));
  const missing = input.listed.filter((name) => !inDiff.has(name));
  return {
    truncated:
      input.diff.truncated || input.listingCapped || missing.length > 0,
    missing,
  };
}

export type PrepareResult = {
  spec: ReviewSpecDocument;
  specText: string;
  specSha256: string;
  diffText: string;
};

/** Build the review spec for one request. */
export async function prepareReview(input: {
  github: GithubClient;
  request: RequestRecord;
  guidance: ReviewGuidanceInputs;
}): Promise<PrepareResult> {
  const { github, request } = input;
  // Caller configuration fails here, before any reviewer starts.
  checkGuidance(input.guidance);
  const repo = repositoryPath(request.repository);
  if (
    (await headSha(github, request.repository, request.pr_number)) !==
    request.head_sha
  )
    contractError(
      'E_REVIEW_STALE_HEAD',
      'the PR head changed after the review was requested; request the review again',
    );

  const response = await github.send(
    {
      method: 'GET',
      path: `${repo}/compare/${request.merge_base_sha}...${request.head_sha}`,
      accept: DIFF_ACCEPT,
    },
    [200, 406, 422],
  );
  if (response.status !== 200)
    contractError(
      'E_DIFF_TOO_LARGE',
      `GitHub could not produce the diff for this PR (HTTP ${response.status}); it is too large to review`,
    );
  const diffText = response.text;
  if (Buffer.byteLength(diffText, 'utf8') > PREPARE_LIMITS.diffBytes)
    contractError(
      'E_DIFF_TOO_LARGE',
      `the diff is larger than ${PREPARE_LIMITS.diffBytes} bytes; it is too large to review`,
    );

  const listing = await github.paginate(
    `${repo}/pulls/${request.pr_number}/files`,
    PREPARE_LIMITS.listingPages,
  );
  // Snapshot consistency: the listing describes the current head, so the
  // head must not have moved while it was read.
  if (
    (await headSha(github, request.repository, request.pr_number)) !==
    request.head_sha
  )
    contractError(
      'E_REVIEW_STALE_HEAD',
      'the PR head changed while the diff was read; request the review again',
    );

  let parsed: ParsedDiff;
  try {
    parsed = parseUnifiedDiff(diffText);
  } catch {
    return contractError('E_INVALID_DIFF', 'the PR diff could not be parsed');
  }
  const listed = listingPaths(listing.items);
  const truncation = detectTruncation({
    diff: parsed,
    listed,
    listingCapped: listing.truncated,
  });
  let additions = 0;
  let deletions = 0;
  for (const file of parsed.files)
    for (const hunk of file.hunks)
      for (const line of hunk.lines) {
        if (line.kind === 'add') additions += 1;
        if (line.kind === 'del') deletions += 1;
      }
  const changed = [...new Set([...diffPaths(parsed), ...listed])].filter(
    (name) => isRepoPath(name),
  );
  const spec: ReviewSpecDocument = {
    version: 1,
    request: request.config,
    request_id: request.request_id,
    repository: request.repository,
    pr_number: request.pr_number,
    base_ref: request.base_ref,
    base_sha: request.base_sha,
    merge_base_sha: request.merge_base_sha,
    head_sha: request.head_sha,
    guidance: input.guidance,
    diff: {
      truncated: truncation.truncated,
      files: Math.max(parsed.files.length, listed.length),
      additions,
      deletions,
      sha256: sha256(diffText),
    },
    changed_files: changed,
    pr: request.pr,
  };
  const specText = `${JSON.stringify(spec, null, 2)}\n`;
  return { spec, specText, specSha256: sha256(specText), diffText };
}

export type LoadedSpec = { spec: ReviewSpecDocument; diffText: string };

/**
 * The spec and diff from a downloaded spec directory, verified against the
 * gate job's digest (`specSha256`) and the diff digest inside the spec.
 */
export function verifySpec(input: {
  specText: string | null;
  diffText: string | null;
  specSha256: string;
  repository: string;
}): LoadedSpec {
  if (
    input.specText === null ||
    !/^[0-9a-f]{64}$/u.test(input.specSha256) ||
    sha256(input.specText) !== input.specSha256
  )
    contractError(
      'E_REVIEW_INPUT',
      'the review spec does not match its trusted digest',
    );
  let spec: ReviewSpecDocument;
  try {
    spec = JSON.parse(input.specText) as ReviewSpecDocument;
  } catch {
    return contractError('E_REVIEW_INPUT', 'the review spec is not JSON');
  }
  if (
    spec?.version !== 1 ||
    spec.repository !== input.repository ||
    !isSha(spec.base_sha) ||
    !isSha(spec.merge_base_sha) ||
    !isSha(spec.head_sha) ||
    !Number.isSafeInteger(spec.pr_number) ||
    spec.pr_number <= 0 ||
    typeof spec.diff?.sha256 !== 'string' ||
    !Array.isArray(spec.changed_files)
  )
    contractError('E_REVIEW_INPUT', 'the review spec is invalid');
  validateRequestConfig(spec.request);
  if (input.diffText === null || sha256(input.diffText) !== spec.diff.sha256)
    contractError(
      'E_REVIEW_INPUT',
      'the diff does not match the digest in the review spec',
    );
  return { spec, diffText: input.diffText };
}
