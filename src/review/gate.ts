import type { ChecksEvidence } from '@agent-ci/review/checks.js';
import {
  type AdjudicationOperation,
  CANDIDATE_ID,
  type CandidateDisposition,
  contractError,
  type DiffPosition,
  type FindingDisposition,
  type GatedAdjudication,
  type GatedCandidate,
  type GatedEvidence,
  type GatedFinding,
  type GatedOperation,
  type GatedPass,
  type GatedReview,
  isSeverity,
  isSha,
  LIMITS,
  type PostedMarker,
  quoteSha256,
  REVIEW_MODES,
  REVIEW_PASSES,
  type ReviewFinding,
  type ReviewIdentity,
  type ReviewMode,
  type ReviewPass,
  type Severity,
  severityRank,
  sliceLines,
  validateAdjudicationEnvelope,
  validateAdjudicationOperation,
  validateFinding,
  validateIdentity,
  validateReviewEnvelope,
} from '@agent-ci/review/contracts.js';
import {
  type ParsedDiff,
  resolveAnchor,
  type SourceReader,
} from '@agent-ci/review/diff-position.js';
import {
  canonicalRuleId,
  findingIdentity,
} from '@agent-ci/review/fingerprint.js';

/**
 * The deterministic PR-review findings gate. It treats every reviewer
 * artifact and adjudication as untrusted and applies, in order: schema →
 * side-specific anchors → evidence (quote digests against the trusted
 * source; in verify-review, check citations against the pass's own
 * validated `checks.json`) → union of the passes' valid candidates →
 * adjudication (drop/downgrade only, protected severities, reasons and
 * references) → `fail_on_severity` → fingerprint grouping at the highest
 * surviving severity → dedupe against posted markers → presentation floor →
 * one shared comment budget → suggestion safety. It validates recorded
 * observations, not whether a finding is true.
 */

export type PassInput = {
  pass: ReviewPass;
  enabled: boolean;
  /** Trusted workflow run attempt that produced this pass's artifacts. */
  attempt: string;
  /** Parsed `review.json`, or `null` when the pass produced none. */
  review: unknown;
};
export type GatePolicy = {
  fail_on_severity?: Severity | null;
  floor?: Severity;
  budget?: number;
};
export type GateInput = {
  identity: ReviewIdentity;
  mode: ReviewMode;
  base_sha: string;
  merge_base_sha: string;
  head_sha: string;
  diff: ParsedDiff;
  read: SourceReader;
  passes: PassInput[];
  adjudication: { enabled: boolean; value: unknown };
  policy?: GatePolicy;
  /** Markers already posted by the validated bot identity for this scope. */
  posted?: PostedMarker[];
  /**
   * verify-review: each pass's `checks.json`, already validated against the
   * spec (repository, head, config, recomputed ids), or `null` when the
   * pass had none that validated. Check citations resolve only here.
   */
  checks?: Partial<Record<ReviewPass, ChecksEvidence | null>>;
};

export const DEFAULT_FLOOR: Severity = 'medium';
export const DEFAULT_BUDGET = 10;
const MAX_BUDGET = 100;

type Candidate = {
  id: string;
  pass: ReviewPass;
  order: number;
  finding: ReviewFinding;
  position: DiffPosition;
  code: string;
  source: string;
  evidence: GatedEvidence[];
  severity: Severity;
  dropped: boolean;
  fingerprint?: string;
  discriminator?: string;
  ruleId?: string | null;
};

function invalidInput(message: string): never {
  return contractError('E_REVIEW_INPUT', message);
}
const reasonCode = (message: string): string =>
  message
    .toLowerCase()
    .replace(/[^a-z_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 40) || 'invalid';

function resolvePolicy(policy: GatePolicy = {}) {
  const floor = policy.floor ?? DEFAULT_FLOOR;
  const budget = policy.budget ?? DEFAULT_BUDGET;
  const failOn = policy.fail_on_severity ?? null;
  if (
    !isSeverity(floor) ||
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    budget > MAX_BUDGET ||
    (failOn !== null && !isSeverity(failOn))
  )
    contractError('E_REVIEW_REQUEST', 'invalid review policy');
  return { fail_on_severity: failOn, floor, budget };
}

/**
 * Resolve one check citation against the citing pass's evidence. Check
 * evidence exists only in verify-review and only for ids the verify stage
 * recorded: anything else (a review-mode citation, a pass without valid
 * evidence, an invented or altered id) is refused with a reason.
 */
function checkCitation(
  evidenceId: string,
  pass: ReviewPass,
  input: GateInput,
): { evidence: GatedEvidence } | { reason: string } {
  if (input.mode !== 'verify-review')
    return { reason: 'evidence_check_unavailable' };
  const checks = input.checks?.[pass];
  if (checks === undefined || checks === null)
    return { reason: 'evidence_check_unavailable' };
  const entry = checks.entries.find((e) => e.evidence_id === evidenceId);
  if (entry === undefined) return { reason: 'evidence_unknown_check' };
  return {
    evidence: {
      kind: 'check',
      evidence_id: entry.evidence_id,
      name: entry.name,
      exit_code: entry.exit_code,
    },
  };
}

/** Validate one finding's anchor and evidence; returns a reason on failure. */
function admit(
  finding: ReviewFinding,
  pass: ReviewPass,
  input: GateInput,
):
  | {
      position: DiffPosition;
      code: string;
      source: string;
      evidence: GatedEvidence[];
    }
  | { reason: string } {
  if (finding.evidence.length === 0) return { reason: 'evidence_missing' };
  const anchor = resolveAnchor(input.diff, finding, input.read);
  if (!anchor.ok) return { reason: anchor.reason };
  if (Buffer.byteLength(anchor.code, 'utf8') > LIMITS.codeBytes)
    return { reason: 'anchor_too_large' };
  const evidence: GatedEvidence[] = [];
  for (const item of finding.evidence) {
    if (item.kind === 'check') {
      const cited = checkCitation(item.evidence_id, pass, input);
      if ('reason' in cited) return cited;
      evidence.push(cited.evidence);
      continue;
    }
    const source = input.read(item.side, item.path);
    if (source === null) return { reason: 'evidence_source_missing' };
    const quoted = sliceLines(source, item.line, item.end_line);
    if (quoted === null) return { reason: 'evidence_out_of_range' };
    if (quoteSha256(quoted) !== item.quote_sha256)
      return { reason: 'evidence_quote_mismatch' };
    evidence.push({
      kind: 'code',
      path: item.path,
      line: item.line,
      end_line: item.end_line,
      side: item.side,
    });
  }
  return {
    position: anchor.position,
    code: anchor.code,
    source: anchor.source,
    evidence,
  };
}

/**
 * True when the agent's `original_code` is exactly the trusted lines of the
 * cited range. Both are split as git numbers lines (LF only, a trailing CR
 * dropped), and one final
 * line terminator on the original is accepted, but a blank line that is
 * part of the range must be present: the comparison is line by line, never
 * a blind trim.
 */
function sameLines(original: string, code: string): boolean {
  const expected = code.split('\n');
  // Lines as git counts them: LF ends a line, a trailing CR is dropped.
  const actual = original.split('\n').map((line) => line.replace(/\r$/u, ''));
  if (actual.length === expected.length + 1 && actual.at(-1) === '')
    actual.pop();
  return (
    actual.length === expected.length &&
    actual.every((line, index) => line === expected[index])
  );
}

// Format characters (bidi overrides, zero-width joiners), control
// characters other than tab and LF, and the Unicode line and paragraph
// separators, which several languages treat as line terminators.
const INVISIBLE = /[\p{Cf}\u2028\u2029]|[^\P{Cc}\t\n]/gu;
/**
 * True when an agent-written suggestion introduces an invisible or control
 * character that the trusted code it replaces does not already contain; a
 * committed suggestion must not smuggle Trojan-Source-style text. CRLF line
 * endings are ordinary when the head file itself uses them; a lone CR is
 * still rejected.
 */
function unsafeCharacters(
  suggestion: string,
  code: string,
  source: string,
): boolean {
  const text = source.includes('\r\n')
    ? suggestion.replace(/\r\n/gu, '\n')
    : suggestion;
  const existing = new Set(code.match(INVISIBLE) ?? []);
  return (text.match(INVISIBLE) ?? []).some((c) => !existing.has(c));
}

function protectedSeverity(
  severity: Severity,
  failOn: Severity | null,
): boolean {
  return (
    severityRank(severity) >= severityRank('high') ||
    (failOn !== null && severityRank(severity) >= severityRank(failOn))
  );
}

function adjudicate(
  input: GateInput,
  candidates: Map<string, Candidate>,
  failOn: Severity | null,
): GatedAdjudication {
  const { enabled, value } = input.adjudication;
  const result = (
    status: GatedAdjudication['status'],
    reason: string | null,
    operations: GatedOperation[] = [],
  ): GatedAdjudication => ({ enabled, status, reason, operations });
  if (!enabled) return result('disabled', null);
  if (value === null || value === undefined)
    return result('failed', 'adjudication output missing');
  let envelope;
  try {
    envelope = validateAdjudicationEnvelope(value);
  } catch {
    return result('failed', 'adjudication output invalid');
  }
  if (envelope.status === 'failed')
    return result('failed', 'adjudicator reported failure');
  const parsed: (AdjudicationOperation | string)[] = envelope.operations.map(
    (raw) => {
      try {
        return validateAdjudicationOperation(raw);
      } catch (error) {
        return reasonCode((error as Error).message);
      }
    },
  );
  const perCandidate = new Map<string, number>();
  for (const op of parsed)
    if (typeof op !== 'string')
      perCandidate.set(
        op.candidate_id,
        (perCandidate.get(op.candidate_id) ?? 0) + 1,
      );
  const operations = parsed.map((op, index): GatedOperation => {
    const raw = envelope.operations[index] as Record<string, unknown> | null;
    // A rejected operation echoes only values that already satisfy the
    // gated contract's grammar, so adjudicator text can never make
    // review-gated.json invalid and block publication.
    const row = (outcome: GatedOperation['outcome']): GatedOperation => ({
      candidate_id:
        typeof op !== 'string'
          ? op.candidate_id
          : typeof raw?.candidate_id === 'string' &&
              CANDIDATE_ID.test(raw.candidate_id)
            ? raw.candidate_id
            : '',
      op:
        typeof op !== 'string'
          ? op.op
          : raw?.op === 'drop' || raw?.op === 'downgrade'
            ? raw.op
            : '',
      to_severity:
        typeof op === 'string'
          ? isSeverity(raw?.to_severity)
            ? raw.to_severity
            : null
          : op.to_severity,
      outcome,
    });
    if (typeof op === 'string') return row(`rejected:${op}`);
    const candidate = candidates.get(op.candidate_id);
    if (!candidate) return row('rejected:unknown_candidate');
    if ((perCandidate.get(op.candidate_id) ?? 0) > 1)
      return row('rejected:conflicting_operations');
    if (protectedSeverity(candidate.finding.severity, failOn))
      return row('rejected:protected_severity');
    if (
      op.op === 'downgrade' &&
      severityRank(op.to_severity!) >= severityRank(candidate.severity)
    )
      return row('rejected:not_a_downgrade');
    for (const reference of op.references) {
      const source = input.read(reference.side, reference.path);
      if (
        source === null ||
        sliceLines(source, reference.line, reference.end_line) === null
      )
        return row('rejected:invalid_reference');
    }
    if (op.op === 'drop') candidate.dropped = true;
    else candidate.severity = op.to_severity!;
    return row('applied');
  });
  return result('completed', null, operations);
}

const byRankDesc = (a: Severity, b: Severity) =>
  severityRank(b) - severityRank(a);
const passOrder = (pass: ReviewPass) => REVIEW_PASSES.indexOf(pass);

/** Run the gate and build `review-gated.json`. */
export function gateReview(input: GateInput): GatedReview {
  const identity = validateIdentity(input.identity);
  for (const field of ['base_sha', 'merge_base_sha', 'head_sha'] as const)
    if (!isSha(input[field])) invalidInput(`${field} must be a full SHA`);
  if (!(REVIEW_MODES as readonly string[]).includes(input.mode))
    invalidInput('invalid mode');
  const seenPasses = new Set<string>();
  for (const pass of input.passes) {
    if (!REVIEW_PASSES.includes(pass.pass) || seenPasses.has(pass.pass))
      invalidInput('passes must be distinct known passes');
    if (!/^[1-9][0-9]{0,5}$/u.test(pass.attempt))
      invalidInput('invalid pass attempt');
    seenPasses.add(pass.pass);
  }
  const policy = resolvePolicy(input.policy);

  const gatedCandidates: GatedCandidate[] = [];
  const valid = new Map<string, Candidate>();
  const passes: GatedPass[] = [];
  const summaries: GatedReview['summaries'] = [];
  let order = 0;

  for (const name of REVIEW_PASSES) {
    const pass = input.passes.find((p) => p.pass === name);
    const status: GatedPass = {
      pass: name,
      enabled: pass?.enabled ?? false,
      status: 'disabled',
      reason: null,
      attempt: pass?.attempt ?? null,
      candidates: 0,
      valid: 0,
    };
    passes.push(status);
    // The primary reviewer is mandatory: a missing or disabled primary pass
    // is a failed pass, so a second-only review is never complete.
    if (name === 'primary' && !pass?.enabled) {
      status.enabled = true;
      status.status = 'failed';
      status.reason = 'primary reviewer pass missing';
      continue;
    }
    if (!pass?.enabled) continue;
    if (pass.review === null || pass.review === undefined) {
      status.status = 'failed';
      status.reason = 'review output missing';
      continue;
    }
    let envelope;
    try {
      envelope = validateReviewEnvelope(pass.review, {
        mode: input.mode,
        pass: name,
        base_sha: input.base_sha,
        merge_base_sha: input.merge_base_sha,
        head_sha: input.head_sha,
      });
    } catch (error) {
      status.status = 'failed';
      status.reason = `review output invalid: ${(error as Error).message}`;
      continue;
    }
    status.status = 'valid';
    status.candidates = envelope.findings.length;
    summaries.push({ pass: name, summary: envelope.header.summary });
    const parsed = envelope.findings.map((raw, index) => {
      try {
        return { index, finding: validateFinding(raw) };
      } catch (error) {
        return { index, reason: (error as Error).message };
      }
    });
    const idCounts = new Map<string, number>();
    for (const item of parsed)
      if (item.finding)
        idCounts.set(item.finding.id, (idCounts.get(item.finding.id) ?? 0) + 1);
    for (const item of parsed) {
      const localId = item.finding?.id ?? `#${item.index}`;
      const duplicate = (idCounts.get(localId) ?? 0) > 1;
      // Unparseable or repeated local ids get a position-based id so every
      // candidate row stays unique; `#` never occurs in a valid local id.
      const candidateId = `${name}-a${pass.attempt}-${
        duplicate ? `#${item.index}` : localId
      }`;
      const reject = (reason: string) =>
        gatedCandidates.push({
          candidate_id: candidateId,
          pass: name,
          local_id: localId,
          severity: item.finding?.severity ?? null,
          fingerprint: null,
          disposition: `invalid:${reason.replace(/[^a-z0-9_.:-]/gu, '_')}`,
        });
      if (!item.finding) {
        reject(item.reason ?? 'schema');
        continue;
      }
      if (duplicate) {
        reject('duplicate_id');
        continue;
      }
      const admitted = admit(item.finding, name, input);
      if ('reason' in admitted) {
        reject(admitted.reason);
        continue;
      }
      status.valid += 1;
      const candidate: Candidate = {
        id: candidateId,
        pass: name,
        order: order++,
        finding: item.finding,
        ...admitted,
        severity: item.finding.severity,
        dropped: false,
      };
      valid.set(candidateId, candidate);
      gatedCandidates.push({
        candidate_id: candidateId,
        pass: name,
        local_id: localId,
        severity: item.finding.severity,
        fingerprint: null,
        disposition: 'posted',
      });
    }
  }

  const adjudication = adjudicate(input, valid, policy.fail_on_severity);
  const surviving = [...valid.values()].filter((c) => !c.dropped);
  const failOn = policy.fail_on_severity;
  const failTriggered =
    failOn !== null &&
    surviving.some((c) => severityRank(c.severity) >= severityRank(failOn));

  const readHead = (path: string) => input.read('RIGHT', path);
  const groups = new Map<string, Candidate[]>();
  for (const candidate of surviving) {
    candidate.ruleId = canonicalRuleId(candidate.finding.rule_id, readHead);
    const identityOf = findingIdentity({
      path: candidate.position.path,
      source: candidate.source,
      line: candidate.finding.line,
      end_line: candidate.finding.end_line,
      category: candidate.finding.category,
      ruleId: candidate.ruleId,
    });
    candidate.fingerprint = identityOf.fingerprint;
    candidate.discriminator = identityOf.discriminator;
    const group = groups.get(identityOf.fingerprint) ?? [];
    group.push(candidate);
    groups.set(identityOf.fingerprint, group);
  }

  const postedKeys = new Set(
    (input.posted ?? []).map((m) => `${m.fingerprint}:${m.discriminator}`),
  );
  const findings: GatedFinding[] = [];
  for (const [fingerprint, group] of groups) {
    const representative = group.toSorted(
      (a, b) => byRankDesc(a.severity, b.severity) || a.order - b.order,
    )[0]!;
    const evidenceKeys = new Set<string>();
    const evidence: GatedEvidence[] = [];
    for (const candidate of group)
      for (const item of candidate.evidence) {
        const key = JSON.stringify(item);
        if (!evidenceKeys.has(key)) {
          evidenceKeys.add(key);
          evidence.push(item);
        }
      }
    let suggestion: string | null = null;
    let suggestionStatus: GatedFinding['suggestion_status'] = 'none';
    const offering = group.filter((c) => c.finding.suggestion !== null);
    const distinct = new Set(offering.map((c) => c.finding.suggestion));
    if (distinct.size > 1) suggestionStatus = 'suppressed:suggestion_conflict';
    else if (offering.length > 0) {
      const source = offering[0]!;
      const samePosition =
        JSON.stringify(source.position) ===
        JSON.stringify(representative.position);
      if (!samePosition) suggestionStatus = 'suppressed:anchor_mismatch';
      else if (source.finding.side !== 'RIGHT')
        suggestionStatus = 'suppressed:left_side';
      else if (!sameLines(source.finding.original_code, representative.code))
        suggestionStatus = 'suppressed:original_code_mismatch';
      else if (
        unsafeCharacters(
          source.finding.suggestion!,
          representative.code,
          representative.source,
        )
      )
        suggestionStatus = 'suppressed:unsafe_characters';
      else {
        suggestion = source.finding.suggestion;
        suggestionStatus = 'kept';
      }
    }
    findings.push({
      fingerprint,
      discriminator: representative.discriminator!,
      passes: [...new Set(group.map((c) => c.pass))].toSorted(
        (a, b) => passOrder(a) - passOrder(b),
      ),
      candidate_ids: group.map((c) => c.id),
      severity: representative.severity,
      category: representative.finding.category,
      rule_id: representative.ruleId ?? null,
      title: representative.finding.title,
      body: representative.finding.body,
      diff_position: representative.position,
      code: representative.code,
      suggestion,
      suggestion_status: suggestionStatus,
      evidence,
      disposition: 'posted',
    });
  }

  findings.sort(
    (a, b) =>
      byRankDesc(a.severity, b.severity) ||
      (a.diff_position.path < b.diff_position.path
        ? -1
        : a.diff_position.path > b.diff_position.path
          ? 1
          : 0) ||
      a.diff_position.line - b.diff_position.line ||
      (a.fingerprint < b.fingerprint ? -1 : 1),
  );
  let budget = policy.budget;
  for (const finding of findings) {
    let disposition: FindingDisposition;
    if (postedKeys.has(`${finding.fingerprint}:${finding.discriminator}`))
      disposition = 'duplicate';
    else if (severityRank(finding.severity) < severityRank(policy.floor))
      disposition = 'below_floor';
    else if (budget > 0) {
      disposition = 'posted';
      budget -= 1;
    } else disposition = 'over_budget';
    finding.disposition = disposition;
  }

  const byId = new Map<string, GatedFinding>();
  for (const finding of findings)
    for (const id of finding.candidate_ids) byId.set(id, finding);
  for (const candidate of gatedCandidates) {
    const source = valid.get(candidate.candidate_id);
    if (!source) continue;
    if (source.dropped) {
      candidate.disposition = 'dropped_by_adjudicator';
      continue;
    }
    const finding = byId.get(candidate.candidate_id)!;
    candidate.fingerprint = finding.fingerprint;
    candidate.disposition =
      JSON.stringify(source.position) === JSON.stringify(finding.diff_position)
        ? (finding.disposition as CandidateDisposition)
        : 'merged';
  }

  const current = new Set(
    findings.map((f) => `${f.fingerprint}:${f.discriminator}`),
  );
  const notReproduced = [
    ...new Map(
      (input.posted ?? [])
        .filter((m) => !current.has(`${m.fingerprint}:${m.discriminator}`))
        .map((m) => [`${m.fingerprint}:${m.discriminator}`, m]),
    ).entries(),
  ]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([, m]) => ({
      fingerprint: m.fingerprint,
      discriminator: m.discriminator,
    }));

  const incomplete =
    !passes.some((p) => p.enabled) ||
    passes.some((p) => p.enabled && p.status === 'failed');
  return {
    version: 1,
    identity,
    mode: input.mode,
    base_sha: input.base_sha,
    merge_base_sha: input.merge_base_sha,
    head_sha: input.head_sha,
    review_status: incomplete ? 'incomplete' : 'complete',
    diff_truncated: input.diff.truncated,
    passes,
    adjudication,
    policy,
    fail_on_severity_triggered: failTriggered,
    summaries,
    candidates: gatedCandidates,
    findings,
    not_reproduced: notReproduced,
    ...(input.mode === 'verify-review' ? { checks: gatedChecks(input) } : {}),
  };
}

/** The checks the summary shows: the primary pass's validated evidence. */
function gatedChecks(input: GateInput): GatedReview['checks'] {
  const evidence = input.checks?.primary ?? input.checks?.second ?? null;
  if (evidence === null) return null;
  return {
    status: evidence.status,
    entries: evidence.entries.map((entry) => ({
      name: entry.name,
      evidence_id: entry.evidence_id,
      exit_code: entry.exit_code,
      timed_out: entry.timed_out,
      isolation: entry.isolation,
    })),
  };
}
