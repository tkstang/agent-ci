import { createHash } from 'node:crypto';

import type { ErrorCode } from '@agent-ci/result.js';

/**
 * Structured contracts for agent-ci PR review, ported from pntr's
 * `pntr-pr-review/contracts.ts` (voxmedia/pntr@e438668): the reviewer's
 * `review.json`, the adjudicator's `adjudication.json` and the findings
 * gate's `review-gated.json`. Every reviewer and adjudicator artifact is
 * untrusted model output; validation is hand-written and closed (unknown
 * fields are rejected) so the gate never acts on a shape it did not check.
 *
 * Differences from pntr: evidence is code evidence only (check evidence and
 * check ledgers arrive with `verify-review` in p04), the only mode is
 * `review`, and errors are `ReviewError`s with a closed agent-ci code.
 */

/** Severity, most severe first. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CATEGORIES = [
  'correctness',
  'security',
  'performance',
  'repo-rule',
  'test',
  'maintainability',
] as const;
export type Category = (typeof CATEGORIES)[number];
/**
 * Review modes. `verify-review` adds recorded repository checks the
 * reviewer reads through the `run_check` tool and cites as check evidence.
 */
export const REVIEW_MODES = ['review', 'verify-review'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
/** Reviewer passes, in deterministic precedence order. */
export const REVIEW_PASSES = ['primary', 'second'] as const;
export type ReviewPass = (typeof REVIEW_PASSES)[number];
export const SIDES = ['RIGHT', 'LEFT'] as const;
/** RIGHT is the PR head tree; LEFT is the merge-base tree. */
export type Side = (typeof SIDES)[number];
/** Fingerprint component used when a finding cites no verified rule. */
export const RULE_SENTINEL = 'agent-ci:no-rule';
/** Identity of the review workflow in markers and gated artifacts. */
export const REVIEW_WORKFLOW = 'agent-ci-pr-review';

/** Size and count caps. Over-cap values are rejected, never truncated. */
export const LIMITS = Object.freeze({
  summaryBytes: 4096,
  titleChars: 200,
  bodyBytes: 4096,
  codeBytes: 16384,
  findings: 50,
  evidence: 16,
  rangeLines: 200,
  pathBytes: 1024,
  ruleIdBytes: 1200,
  operations: 100,
  reasonBytes: 1024,
  reasonChars: 400,
  references: 8,
});

export const ADJUDICATION_REASONS = [
  'incorrect_claim',
  'not_reachable',
  'handled_elsewhere',
  'overstated_severity',
  'insufficient_evidence',
  'duplicate',
] as const;
export type AdjudicationReasonCode = (typeof ADJUDICATION_REASONS)[number];

/** The review error codes (a subset of the closed agent-ci set). */
export type ReviewErrorCode = Extract<
  ErrorCode,
  | 'E_REVIEW_REQUEST'
  | 'E_REVIEW_INPUT'
  | 'E_REVIEW_GUIDANCE'
  | 'E_REVIEW_STALE_HEAD'
  | 'E_DIFF_TOO_LARGE'
  | 'E_INVALID_DIFF'
  | 'E_GITHUB_API'
  | 'E_VERIFY_CONFIG'
  | 'E_VERIFY_EVIDENCE'
  | 'E_VERIFY_RUN'
>;

/**
 * A review failure with a closed code. `message` is a stable, safe reason
 * (for findings, `schema:<field>`); callers switch on `code`, never on text.
 */
export class ReviewError extends Error {
  override readonly name = 'ReviewError';
  readonly code: ReviewErrorCode;
  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function isReviewError(error: unknown): error is ReviewError {
  return error instanceof ReviewError;
}

/** Throw a contract error carrying a closed `E_*` code. */
export function contractError(code: ReviewErrorCode, message: string): never {
  throw new ReviewError(code, message);
}

export type CodeEvidence = {
  kind: 'code';
  path: string;
  line: number;
  end_line: number;
  side: Side;
  /** sha256 of the canonical quote (see {@link quoteSha256}). */
  quote_sha256: string;
};
export type Evidence = CodeEvidence;
/** One validated reviewer finding (agent-local identity). */
export type ReviewFinding = {
  id: string;
  severity: Severity;
  category: Category;
  rule_id: string | null;
  title: string;
  body: string;
  path: string;
  line: number;
  end_line: number;
  side: Side;
  original_code: string;
  suggestion: string | null;
  evidence: Evidence[];
};
/** Validated `review.json` envelope; findings are validated one by one. */
export type ReviewHeader = {
  version: 1;
  mode: ReviewMode;
  pass: ReviewPass;
  base_sha: string;
  merge_base_sha: string;
  head_sha: string;
  summary: string;
};
export type Review = ReviewHeader & { findings: ReviewFinding[] };
/** Trusted expectations a reviewer artifact must agree with. */
export type ReviewExpectation = {
  mode: ReviewMode;
  pass: ReviewPass;
  base_sha: string;
  merge_base_sha: string;
  head_sha: string;
};

export type SourceReference = {
  path: string;
  line: number;
  end_line: number;
  side: Side;
};
export type AdjudicationOperation = {
  candidate_id: string;
  op: 'drop' | 'downgrade';
  to_severity: Severity | null;
  reason: { code: AdjudicationReasonCode; detail: string };
  references: SourceReference[];
};
/** Validated `adjudication.json` envelope; operations are checked one by one. */
export type AdjudicationEnvelope = {
  version: 1;
  status: 'completed' | 'failed';
  operations: unknown[];
};

export type DiffPosition = {
  /** GitHub review-comment path (the new path, or the old path of a deletion). */
  path: string;
  side: Side;
  line: number;
  /** First line of a multi-line range; `null` for a single line. */
  start_line: number | null;
};
export type FindingDisposition =
  | 'posted'
  | 'duplicate'
  | 'below_floor'
  | 'over_budget';
/**
 * Candidate outcome. A valid candidate takes its finding's disposition when
 * the finding sits at the candidate's own position; `merged` means it shares
 * the finding's fingerprint but was cited at a different position (for
 * example the other side of an unchanged context line), so nothing was
 * posted at its own position.
 */
export type CandidateDisposition =
  | FindingDisposition
  | 'merged'
  | 'dropped_by_adjudicator'
  | `invalid:${string}`;
export type GatedEvidence = {
  kind: 'code';
  path: string;
  line: number;
  end_line: number;
  side: Side;
};
export type GatedCandidate = {
  candidate_id: string;
  pass: ReviewPass;
  local_id: string;
  /** Validated severity before adjudication; `null` when invalid. */
  severity: Severity | null;
  fingerprint: string | null;
  disposition: CandidateDisposition;
};
export type GatedFinding = {
  fingerprint: string;
  discriminator: string;
  passes: ReviewPass[];
  candidate_ids: string[];
  severity: Severity;
  category: Category;
  rule_id: string | null;
  title: string;
  body: string;
  diff_position: DiffPosition;
  /** Trusted source lines at the anchor, read from the cited side's tree. */
  code: string;
  suggestion: string | null;
  suggestion_status: 'none' | 'kept' | `suppressed:${string}`;
  evidence: GatedEvidence[];
  disposition: FindingDisposition;
};
export type GatedPass = {
  pass: ReviewPass;
  enabled: boolean;
  status: 'valid' | 'failed' | 'disabled';
  reason: string | null;
  attempt: string | null;
  candidates: number;
  valid: number;
};
export type GatedOperation = {
  /** A namespaced candidate id, or `''` when the adjudicator's was malformed. */
  candidate_id: string;
  /** `''` when the adjudicator's operation name was malformed. */
  op: 'drop' | 'downgrade' | '';
  to_severity: Severity | null;
  outcome: 'applied' | `rejected:${string}`;
};
export type GatedAdjudication = {
  enabled: boolean;
  status: 'disabled' | 'completed' | 'failed';
  reason: string | null;
  operations: GatedOperation[];
};
/** Trusted identity of one review run; fixes the marker scope. */
export type ReviewIdentity = {
  repository: string;
  workflow: string;
  pr_number: number;
  scope: string;
  run_id: string;
  run_attempt: string;
};
export type PostedMarker = { fingerprint: string; discriminator: string };
export type GatedReview = {
  version: 1;
  identity: ReviewIdentity;
  mode: ReviewMode;
  base_sha: string;
  merge_base_sha: string;
  head_sha: string;
  review_status: 'complete' | 'incomplete';
  diff_truncated: boolean;
  passes: GatedPass[];
  adjudication: GatedAdjudication;
  policy: {
    fail_on_severity: Severity | null;
    floor: Severity;
    budget: number;
  };
  fail_on_severity_triggered: boolean;
  summaries: { pass: ReviewPass; summary: string }[];
  candidates: GatedCandidate[];
  findings: GatedFinding[];
  not_reproduced: PostedMarker[];
};

type Fields = Record<string, unknown>;

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const SHA = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
/** Namespaced candidate id: `<pass>-a<attempt>-<local id>`. */
export const CANDIDATE_ID =
  /^(primary|second)-a[1-9][0-9]{0,5}-[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
// Owner, then a repository name of letters, digits, `.`, `_` and `-` that
// may start with any of them (`org/.github`) but is not `.` or `..`.
const REPOSITORY =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/u;
const ATTEMPT = /^[1-9][0-9]{0,5}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
// Control and format characters (bidi overrides, zero-width joiners) never
// belong in a path or identifier.
const CONTROL = /[\p{Cc}\p{Cf}]/u;

function record(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** True when `value` is a plain object whose keys are all in `allowed`. */
export function closedRecord(
  value: unknown,
  allowed: readonly string[],
): value is Fields {
  return record(value) && Object.keys(value).every((k) => allowed.includes(k));
}
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
  );
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function text(value: unknown, maxBytes: number, allowEmpty = false): boolean {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.trim() !== '') &&
    bytes(value) <= maxBytes
  );
}

/** Rank for comparisons: higher is more severe. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.length - SEVERITIES.indexOf(severity);
}
export function isSeverity(value: unknown): value is Severity {
  return oneOf(value, SEVERITIES);
}
export function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}
/** True for a safe repository-relative POSIX path. */
export function isRepoPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    bytes(value) <= LIMITS.pathBytes &&
    !value.includes('\\') &&
    !CONTROL.test(value) &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}
/**
 * GitHub logins, in one place for every check: a regular login (letters,
 * digits, hyphens), an Enterprise Managed User login (`handle_shortcode`,
 * so `_` is allowed after the first character), and a GitHub App's
 * `name[bot]`. Bounded at 100 characters before the suffix; no control,
 * space or markup characters. Text that shows a login renders it inertly.
 */
const LOGIN_NAME = '[A-Za-z0-9][A-Za-z0-9_-]{0,99}';
const ANY_LOGIN = new RegExp(`^${LOGIN_NAME}(?:\\[bot\\])?$`, 'u');
const BOT_LOGIN = new RegExp(`^${LOGIN_NAME}\\[bot\\]$`, 'u');
const USER_LOGIN = new RegExp(`^${LOGIN_NAME}$`, 'u');
/** A user, EMU or `[bot]` login. */
export function isLogin(value: unknown): value is string {
  return typeof value === 'string' && ANY_LOGIN.test(value);
}
/** A GitHub App login (`name[bot]`). */
export function isBotLogin(value: unknown): value is string {
  return typeof value === 'string' && BOT_LOGIN.test(value);
}
/** A user or EMU login (no `[bot]` suffix). */
export function isUserLogin(value: unknown): value is string {
  return typeof value === 'string' && USER_LOGIN.test(value);
}
export function isRepository(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY.test(value);
}

/**
 * Split file text into lines the way git and the unified diff number them:
 * only LF ends a line, one trailing CR is dropped from each line (CRLF
 * files), and a lone CR inside a line is line content. A final newline does
 * not create an extra empty line, so `lines[n - 1]` is line `n`.
 */
export function splitLines(source: string): string[] {
  if (source === '') return [];
  const lines = source.split('\n').map((line) => line.replace(/\r$/u, ''));
  if (source.endsWith('\n')) lines.pop();
  return lines;
}
/** Lines `line..endLine` (1-based, inclusive) joined by LF, or `null`. */
export function sliceLines(
  source: string,
  line: number,
  endLine: number,
): string | null {
  const lines = splitLines(source);
  if (line < 1 || endLine < line || endLine > lines.length) return null;
  return lines.slice(line - 1, endLine).join('\n');
}
/**
 * Canonical quote form: CRLF/CR normalized to LF and one trailing newline
 * removed. The pass (digesting the agent's quote) and the gate (digesting
 * the trusted lines) both digest this form.
 */
export function canonicalQuote(quote: string): string {
  return quote.replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
}
/** sha256 hex digest of the canonical quote. */
export function quoteSha256(quote: string): string {
  return sha256(canonicalQuote(quote));
}
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidReview(message: string): never {
  return contractError('E_REVIEW_INPUT', message);
}
function invalidFinding(reason: string): never {
  return contractError('E_REVIEW_INPUT', reason);
}
function sha(
  value: unknown,
  field: string,
  fail: (m: string) => never,
): string {
  if (!isSha(value)) fail(`${field} must be a 40-character lowercase hex SHA`);
  return value as string;
}

/**
 * Validate the `review.json` envelope against trusted expectations. Findings
 * are returned unvalidated so one malformed finding does not void the pass;
 * validate each with {@link validateFinding}.
 */
export function validateReviewEnvelope(
  value: unknown,
  expected?: ReviewExpectation,
): { header: ReviewHeader; findings: unknown[] } {
  if (
    !closedRecord(value, [
      'version',
      'mode',
      'pass',
      'base_sha',
      'merge_base_sha',
      'head_sha',
      'summary',
      'findings',
    ])
  )
    invalidReview('review must be an object with only known fields');
  if (value.version !== 1) invalidReview('unsupported review version');
  if (!oneOf(value.mode, REVIEW_MODES)) invalidReview('invalid review mode');
  if (!oneOf(value.pass, REVIEW_PASSES)) invalidReview('invalid review pass');
  const header: ReviewHeader = {
    version: 1,
    mode: value.mode,
    pass: value.pass,
    base_sha: sha(value.base_sha, 'base_sha', invalidReview),
    merge_base_sha: sha(value.merge_base_sha, 'merge_base_sha', invalidReview),
    head_sha: sha(value.head_sha, 'head_sha', invalidReview),
    summary: '',
  };
  if (!text(value.summary, LIMITS.summaryBytes, true))
    invalidReview('summary must be a string of at most 4 KiB');
  header.summary = value.summary as string;
  if (!Array.isArray(value.findings) || value.findings.length > LIMITS.findings)
    invalidReview(`findings must be an array of at most ${LIMITS.findings}`);
  if (expected) {
    for (const field of [
      'mode',
      'pass',
      'base_sha',
      'merge_base_sha',
      'head_sha',
    ] as const)
      if (header[field] !== expected[field])
        invalidReview(`${field} does not match the trusted run`);
  }
  return { header, findings: value.findings };
}

function range(
  value: Fields,
  fail: (reason: string) => never,
  prefix: string,
): { line: number; end_line: number } {
  if (!positive(value.line)) fail(`${prefix}line`);
  const end = value.end_line ?? value.line;
  if (
    !positive(end) ||
    end < (value.line as number) ||
    end - (value.line as number) + 1 > LIMITS.rangeLines
  )
    fail(`${prefix}end_line`);
  return { line: value.line as number, end_line: end };
}
function evidenceItem(value: unknown, index: number): Evidence {
  const at = `evidence.${index}`;
  if (
    !closedRecord(value, [
      'kind',
      'path',
      'line',
      'end_line',
      'side',
      'quote_sha256',
    ]) ||
    value.kind !== 'code' ||
    !isRepoPath(value.path) ||
    !oneOf(value.side, SIDES) ||
    !isHex64(value.quote_sha256)
  )
    invalidFinding(`schema:${at}`);
  return {
    kind: 'code',
    path: value.path,
    ...range(value, invalidFinding, `schema:${at}.`),
    side: value.side,
    quote_sha256: value.quote_sha256,
  };
}

/**
 * Validate one untrusted finding. Throws a `ReviewError` whose message is a
 * stable `schema:<field>` reason.
 */
export function validateFinding(value: unknown): ReviewFinding {
  if (
    !closedRecord(value, [
      'id',
      'severity',
      'category',
      'rule_id',
      'title',
      'body',
      'path',
      'line',
      'end_line',
      'side',
      'original_code',
      'suggestion',
      'evidence',
    ])
  )
    invalidFinding('schema:fields');
  if (typeof value.id !== 'string' || !LOCAL_ID.test(value.id))
    invalidFinding('schema:id');
  if (!isSeverity(value.severity)) invalidFinding('schema:severity');
  if (!oneOf(value.category, CATEGORIES)) invalidFinding('schema:category');
  const ruleId = value.rule_id ?? null;
  if (
    ruleId !== null &&
    (typeof ruleId !== 'string' ||
      ruleId === '' ||
      bytes(ruleId) > LIMITS.ruleIdBytes ||
      CONTROL.test(ruleId))
  )
    invalidFinding('schema:rule_id');
  if (
    typeof value.title !== 'string' ||
    value.title.trim() === '' ||
    [...value.title].length > LIMITS.titleChars ||
    /[\r\n]/u.test(value.title)
  )
    invalidFinding('schema:title');
  if (!text(value.body, LIMITS.bodyBytes)) invalidFinding('schema:body');
  if (!isRepoPath(value.path)) invalidFinding('schema:path');
  if (!oneOf(value.side, SIDES)) invalidFinding('schema:side');
  const lines = range(value, invalidFinding, 'schema:');
  if (!text(value.original_code, LIMITS.codeBytes, true))
    invalidFinding('schema:original_code');
  const suggestion = value.suggestion ?? null;
  if (suggestion !== null && !text(suggestion, LIMITS.codeBytes, true))
    invalidFinding('schema:suggestion');
  if (!Array.isArray(value.evidence) || value.evidence.length > LIMITS.evidence)
    invalidFinding('schema:evidence');
  return {
    id: value.id,
    severity: value.severity,
    category: value.category,
    rule_id: ruleId as string | null,
    title: value.title,
    body: value.body as string,
    path: value.path,
    ...lines,
    side: value.side,
    original_code: value.original_code as string,
    suggestion: suggestion as string | null,
    evidence: value.evidence.map(evidenceItem),
  };
}

/** Strictly validate a whole review; any malformed finding throws. */
export function validateReview(
  value: unknown,
  expected?: ReviewExpectation,
): Review {
  const { header, findings } = validateReviewEnvelope(value, expected);
  const validated = findings.map((finding, index) => {
    try {
      return validateFinding(finding);
    } catch (error) {
      return invalidReview(`finding ${index}: ${(error as Error).message}`);
    }
  });
  if (new Set(validated.map((f) => f.id)).size !== validated.length)
    invalidReview('finding ids must be unique');
  return { ...header, findings: validated };
}

function invalidAdjudication(message: string): never {
  return contractError('E_REVIEW_INPUT', message);
}
/** Validate the `adjudication.json` envelope; operations are checked later. */
export function validateAdjudicationEnvelope(
  value: unknown,
): AdjudicationEnvelope {
  if (!closedRecord(value, ['version', 'status', 'operations']))
    invalidAdjudication(
      'adjudication must be an object with only known fields',
    );
  if (value.version !== 1)
    invalidAdjudication('unsupported adjudication version');
  if (!oneOf(value.status, ['completed', 'failed'] as const))
    invalidAdjudication('invalid adjudication status');
  if (
    !Array.isArray(value.operations) ||
    value.operations.length > LIMITS.operations
  )
    invalidAdjudication('operations must be a bounded array');
  return {
    version: 1,
    status: value.status,
    operations: value.operations,
  };
}
/**
 * True for a short single-line adjudication reason: at most
 * `LIMITS.reasonChars` code points, no control, format or line-separator
 * characters, and no PEM block marker. A defense-in-depth filter on text
 * copied into review artifacts, not an exfiltration control: the
 * adjudicator runs with no tools at all.
 */
export function plainReason(detail: string): boolean {
  if ([...detail].length > LIMITS.reasonChars) return false;
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(detail)) return false;
  return !/-----(?:BEGIN|END) /u.test(detail);
}

/**
 * Validate one adjudication operation's shape. Throws a `ReviewError` with
 * a stable reason (`schema`, `schema:to_severity`, `reason_missing`,
 * `reason_unsafe`, `references_missing`, `references_invalid`); severity
 * and reference checks against the candidates happen in the gate.
 */
export function validateAdjudicationOperation(
  value: unknown,
): AdjudicationOperation {
  if (
    !closedRecord(value, [
      'candidate_id',
      'op',
      'to_severity',
      'reason',
      'references',
    ]) ||
    typeof value.candidate_id !== 'string' ||
    !CANDIDATE_ID.test(value.candidate_id) ||
    !oneOf(value.op, ['drop', 'downgrade'] as const)
  )
    invalidAdjudication('schema');
  const toSeverity = value.to_severity ?? null;
  if (value.op === 'downgrade' ? !isSeverity(toSeverity) : toSeverity !== null)
    invalidAdjudication('schema:to_severity');
  const reason = value.reason;
  if (
    !closedRecord(reason, ['code', 'detail']) ||
    !oneOf(reason.code, ADJUDICATION_REASONS) ||
    !text(reason.detail, LIMITS.reasonBytes)
  )
    invalidAdjudication('reason_missing');
  if (!plainReason(reason.detail as string))
    invalidAdjudication('reason_unsafe');
  if (
    !Array.isArray(value.references) ||
    value.references.length === 0 ||
    value.references.length > LIMITS.references
  )
    invalidAdjudication('references_missing');
  const references = value.references.map((reference): SourceReference => {
    if (
      !closedRecord(reference, ['path', 'line', 'end_line', 'side']) ||
      !isRepoPath(reference.path) ||
      !oneOf(reference.side, SIDES)
    )
      invalidAdjudication('references_invalid');
    return {
      path: reference.path,
      ...range(reference, () => invalidAdjudication('references_invalid'), ''),
      side: reference.side,
    };
  });
  return {
    candidate_id: value.candidate_id,
    op: value.op,
    to_severity: toSeverity as Severity | null,
    reason: {
      code: reason.code,
      detail: reason.detail as string,
    },
    references,
  };
}

function invalidGated(message: string): never {
  return contractError('E_REVIEW_INPUT', message);
}
/** Validate trusted run identity. */
export function validateIdentity(value: unknown): ReviewIdentity {
  if (
    !closedRecord(value, [
      'repository',
      'workflow',
      'pr_number',
      'scope',
      'run_id',
      'run_attempt',
    ]) ||
    !isRepository(value.repository) ||
    typeof value.workflow !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/u.test(value.workflow) ||
    !positive(value.pr_number) ||
    typeof value.scope !== 'string' ||
    !SCOPE.test(value.scope) ||
    typeof value.run_id !== 'string' ||
    !RUN_ID.test(value.run_id) ||
    typeof value.run_attempt !== 'string' ||
    !ATTEMPT.test(value.run_attempt)
  )
    contractError('E_REVIEW_INPUT', 'invalid trusted review identity');
  return {
    repository: value.repository,
    workflow: value.workflow,
    pr_number: value.pr_number,
    scope: value.scope,
    run_id: value.run_id,
    run_attempt: value.run_attempt,
  };
}
/** Artifact-safe review scope (also scopes the comment markers). */
export const SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

const DISPOSITIONS = ['posted', 'duplicate', 'below_floor', 'over_budget'];
function candidateDisposition(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (DISPOSITIONS.includes(value) ||
      value === 'dropped_by_adjudicator' ||
      value === 'merged' ||
      /^invalid:[a-z0-9_.:-]{1,80}$/u.test(value))
  );
}
function diffPosition(value: unknown): boolean {
  return (
    closedRecord(value, ['path', 'side', 'line', 'start_line']) &&
    isRepoPath(value.path) &&
    oneOf(value.side, SIDES) &&
    positive(value.line) &&
    (value.start_line === null ||
      (positive(value.start_line) && value.start_line < value.line))
  );
}
function gatedEvidence(value: unknown): boolean {
  return (
    closedRecord(value, ['kind', 'path', 'line', 'end_line', 'side']) &&
    value.kind === 'code' &&
    isRepoPath(value.path) &&
    positive(value.line) &&
    positive(value.end_line) &&
    (value.end_line as number) >= (value.line as number) &&
    oneOf(value.side, SIDES)
  );
}
function marker(value: unknown): value is PostedMarker {
  return (
    closedRecord(value, ['fingerprint', 'discriminator']) &&
    isHex64(value.fingerprint) &&
    isHex64(value.discriminator)
  );
}
function passes(value: unknown): value is ReviewPass[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((p) => oneOf(p, REVIEW_PASSES)) &&
    new Set(value).size === value.length
  );
}
function gatedFinding(value: unknown): boolean {
  return (
    closedRecord(value, [
      'fingerprint',
      'discriminator',
      'passes',
      'candidate_ids',
      'severity',
      'category',
      'rule_id',
      'title',
      'body',
      'diff_position',
      'code',
      'suggestion',
      'suggestion_status',
      'evidence',
      'disposition',
    ]) &&
    marker({
      fingerprint: value.fingerprint,
      discriminator: value.discriminator,
    }) &&
    passes(value.passes) &&
    Array.isArray(value.candidate_ids) &&
    value.candidate_ids.length > 0 &&
    value.candidate_ids.every(
      (id) => typeof id === 'string' && CANDIDATE_ID.test(id),
    ) &&
    isSeverity(value.severity) &&
    oneOf(value.category, CATEGORIES) &&
    (value.rule_id === null ||
      (typeof value.rule_id === 'string' && value.rule_id !== '')) &&
    typeof value.title === 'string' &&
    [...value.title].length <= LIMITS.titleChars &&
    text(value.body, LIMITS.bodyBytes) &&
    diffPosition(value.diff_position) &&
    text(value.code, LIMITS.codeBytes, true) &&
    (value.suggestion === null ||
      text(value.suggestion, LIMITS.codeBytes, true)) &&
    typeof value.suggestion_status === 'string' &&
    /^(none|kept|suppressed:[a-z_]{1,40})$/u.test(value.suggestion_status) &&
    (value.suggestion_status === 'kept') === (value.suggestion !== null) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(gatedEvidence) &&
    oneOf(value.disposition, DISPOSITIONS)
  );
}

/**
 * Validate `review-gated.json` before publication. With `identity`, the
 * artifact must belong to exactly that repository, workflow, PR, scope and
 * run attempt.
 */
export function validateGatedReview(
  value: unknown,
  identity?: ReviewIdentity,
): GatedReview {
  if (
    !closedRecord(value, [
      'version',
      'identity',
      'mode',
      'base_sha',
      'merge_base_sha',
      'head_sha',
      'review_status',
      'diff_truncated',
      'passes',
      'adjudication',
      'policy',
      'fail_on_severity_triggered',
      'summaries',
      'candidates',
      'findings',
      'not_reproduced',
    ])
  )
    invalidGated('gated review must be an object with only known fields');
  if (value.version !== 1) invalidGated('unsupported gated review version');
  const actual = validateIdentity(value.identity);
  if (
    identity &&
    JSON.stringify(Object.entries(actual).toSorted()) !==
      JSON.stringify(Object.entries(validateIdentity(identity)).toSorted())
  )
    invalidGated('gated review identity does not match the trusted run');
  if (!oneOf(value.mode, REVIEW_MODES)) invalidGated('invalid mode');
  for (const field of ['base_sha', 'merge_base_sha', 'head_sha'] as const)
    sha(value[field], field, invalidGated);
  if (!oneOf(value.review_status, ['complete', 'incomplete'] as const))
    invalidGated('invalid review_status');
  if (
    typeof value.diff_truncated !== 'boolean' ||
    typeof value.fail_on_severity_triggered !== 'boolean'
  )
    invalidGated('invalid flags');
  if (
    !Array.isArray(value.passes) ||
    !value.passes.every(
      (p) =>
        closedRecord(p, [
          'pass',
          'enabled',
          'status',
          'reason',
          'attempt',
          'candidates',
          'valid',
        ]) &&
        oneOf(p.pass, REVIEW_PASSES) &&
        typeof p.enabled === 'boolean' &&
        oneOf(p.status, ['valid', 'failed', 'disabled'] as const) &&
        (p.reason === null || text(p.reason, 512)) &&
        (p.attempt === null ||
          (typeof p.attempt === 'string' && ATTEMPT.test(p.attempt))) &&
        Number.isSafeInteger(p.candidates) &&
        Number.isSafeInteger(p.valid),
    ) ||
    new Set(value.passes.map((p) => (p as Fields).pass)).size !==
      value.passes.length
  )
    invalidGated('invalid passes');
  const adjudication = value.adjudication;
  if (
    !closedRecord(adjudication, [
      'enabled',
      'status',
      'reason',
      'operations',
    ]) ||
    typeof adjudication.enabled !== 'boolean' ||
    !oneOf(adjudication.status, ['disabled', 'completed', 'failed'] as const) ||
    !(adjudication.reason === null || text(adjudication.reason, 512)) ||
    !Array.isArray(adjudication.operations) ||
    !adjudication.operations.every(
      (op) =>
        closedRecord(op, ['candidate_id', 'op', 'to_severity', 'outcome']) &&
        typeof op.candidate_id === 'string' &&
        (op.candidate_id === '' || CANDIDATE_ID.test(op.candidate_id)) &&
        oneOf(op.op, ['drop', 'downgrade', ''] as const) &&
        (op.to_severity === null || isSeverity(op.to_severity)) &&
        typeof op.outcome === 'string' &&
        /^(applied|rejected:[a-z_]{1,40})$/u.test(op.outcome),
    )
  )
    invalidGated('invalid adjudication');
  const policy = value.policy;
  if (
    !closedRecord(policy, ['fail_on_severity', 'floor', 'budget']) ||
    !(
      policy.fail_on_severity === null || isSeverity(policy.fail_on_severity)
    ) ||
    !isSeverity(policy.floor) ||
    !Number.isSafeInteger(policy.budget) ||
    (policy.budget as number) < 0
  )
    invalidGated('invalid policy');
  if (
    !Array.isArray(value.summaries) ||
    !value.summaries.every(
      (s) =>
        closedRecord(s, ['pass', 'summary']) &&
        oneOf(s.pass, REVIEW_PASSES) &&
        text(s.summary, LIMITS.summaryBytes, true),
    )
  )
    invalidGated('invalid summaries');
  if (
    !Array.isArray(value.candidates) ||
    !value.candidates.every(
      (c) =>
        closedRecord(c, [
          'candidate_id',
          'pass',
          'local_id',
          'severity',
          'fingerprint',
          'disposition',
        ]) &&
        typeof c.candidate_id === 'string' &&
        bytes(c.candidate_id) <= 256 &&
        oneOf(c.pass, REVIEW_PASSES) &&
        typeof c.local_id === 'string' &&
        bytes(c.local_id) <= 256 &&
        (c.severity === null || isSeverity(c.severity)) &&
        (c.fingerprint === null || isHex64(c.fingerprint)) &&
        candidateDisposition(c.disposition),
    )
  )
    invalidGated('invalid candidates');
  if (!Array.isArray(value.findings) || !value.findings.every(gatedFinding))
    invalidGated('invalid findings');
  if (
    new Set(value.findings.map((f) => (f as Fields).fingerprint)).size !==
    value.findings.length
  )
    invalidGated('findings must have unique fingerprints');
  if (
    !Array.isArray(value.not_reproduced) ||
    !value.not_reproduced.every(marker)
  )
    invalidGated('invalid not_reproduced');
  return value as unknown as GatedReview;
}
