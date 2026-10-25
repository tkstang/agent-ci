import {
  LIMITS,
  quoteSha256,
  sliceLines,
  validateAdjudicationEnvelope,
  validateAdjudicationOperation,
  validateFinding,
  validateGatedReview,
  validateReview,
  validateReviewEnvelope,
} from '@agent-ci/review/contracts.js';
import { describe, expect, it } from 'vitest';

// Ported from pntr tests/workflows/pr-review-contract.test.ts
// (voxmedia/pntr@e438668): code evidence only, closed agent-ci codes.

const BASE = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const expected = {
  mode: 'review' as const,
  pass: 'primary' as const,
  base_sha: BASE,
  merge_base_sha: MERGE,
  head_sha: HEAD,
};

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'F1',
    severity: 'high',
    category: 'correctness',
    title: 'Off-by-one in loop bound',
    body: 'The loop reads one element past the end.',
    path: 'src/a.ts',
    line: 3,
    end_line: 4,
    side: 'RIGHT',
    original_code: 'for (let i = 0; i <= n; i++) {\n  use(xs[i]);',
    evidence: [
      {
        kind: 'code',
        path: 'src/a.ts',
        line: 3,
        end_line: 4,
        side: 'RIGHT',
        quote_sha256: DIGEST,
      },
    ],
    ...overrides,
  };
}
function review(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: 'review',
    pass: 'primary',
    base_sha: BASE,
    merge_base_sha: MERGE,
    head_sha: HEAD,
    summary: 'One issue.',
    findings: [finding()],
    ...overrides,
  };
}
const code = (error: () => unknown) => {
  try {
    error();
  } catch (caught) {
    return [(caught as { code?: string }).code, (caught as Error).message];
  }
  return ['no error'];
};

describe('review.json contract', () => {
  it('accepts a complete review and defaults optional fields', () => {
    const accepted = validateReview(review(), expected);
    expect(accepted.findings[0]).toMatchObject({
      id: 'F1',
      rule_id: null,
      suggestion: null,
      end_line: 4,
    });
    const single = validateFinding(finding({ end_line: undefined }));
    expect(single.end_line).toBe(3);
  });

  it.each([
    ['unknown top-level field', { extra: true }],
    ['wrong version', { version: 2 }],
    ['unknown mode', { mode: 'deep' }],
    ['verify-review mode (p04)', { mode: 'verify-review' }],
    ['unknown pass', { pass: 'third' }],
    ['short SHA', { head_sha: 'c'.repeat(39) }],
    ['uppercase SHA', { base_sha: 'A'.repeat(40) }],
    ['oversized summary', { summary: 'x'.repeat(LIMITS.summaryBytes + 1) }],
    ['findings not an array', { findings: {} }],
    [
      'too many findings',
      {
        findings: Array.from({ length: LIMITS.findings + 1 }, () => finding()),
      },
    ],
  ])('rejects the envelope with %s', (_name, overrides) => {
    expect(code(() => validateReviewEnvelope(review(overrides)))[0]).toBe(
      'E_REVIEW_INPUT',
    );
  });

  it('rejects an envelope that disagrees with the trusted run', () => {
    for (const overrides of [
      { pass: 'second' },
      { head_sha: 'e'.repeat(40) },
      { merge_base_sha: BASE },
    ])
      expect(
        code(() => validateReviewEnvelope(review(overrides), expected)),
      ).toEqual(['E_REVIEW_INPUT', expect.stringContaining('trusted run')]);
  });

  it.each([
    ['fields', { extra: 1 }],
    ['id', { id: '-bad' }],
    ['severity', { severity: 'blocker' }],
    ['category', { category: 'style' }],
    ['rule_id', { rule_id: '' }],
    ['title', { title: 'two\nlines' }],
    ['title', { title: 'x'.repeat(LIMITS.titleChars + 1) }],
    ['body', { body: ' ' }],
    ['body', { body: 'x'.repeat(LIMITS.bodyBytes + 1) }],
    ['path', { path: '../etc/passwd' }],
    ['path', { path: '/abs.ts' }],
    ['path', { path: 'a/.git/config' }],
    ['path', { path: 'src\\a.ts' }],
    ['path', { path: 'src/a\u202e.ts' }],
    ['side', { side: 'BOTH' }],
    ['line', { line: 0 }],
    ['end_line', { end_line: 2 }],
    ['end_line', { end_line: 3 + LIMITS.rangeLines }],
    ['original_code', { original_code: 7 }],
    ['suggestion', { suggestion: 'x'.repeat(LIMITS.codeBytes + 1) }],
    ['evidence', { evidence: 'none' }],
    ['evidence.0', { evidence: [{ kind: 'code', path: 'a', line: 1 }] }],
    [
      'evidence.0',
      { evidence: [{ kind: 'check', evidence_id: 'primary-a1-chk-1' }] },
    ],
    [
      'evidence.0',
      {
        evidence: [
          {
            kind: 'code',
            path: 'a',
            line: 1,
            side: 'RIGHT',
            quote_sha256: 'short',
          },
        ],
      },
    ],
  ])('rejects a finding with a bad %s', (field, overrides) => {
    expect(code(() => validateFinding(finding(overrides)))).toEqual([
      'E_REVIEW_INPUT',
      `schema:${field}`,
    ]);
  });

  it('strict validation rejects duplicate local ids and any bad finding', () => {
    expect(
      code(() =>
        validateReview(review({ findings: [finding(), finding()] }), expected),
      )[1],
    ).toMatch(/unique/u);
    expect(
      code(() =>
        validateReview(
          review({ findings: [finding(), finding({ id: 'F2', side: 'X' })] }),
        ),
      ),
    ).toEqual(['E_REVIEW_INPUT', 'finding 1: schema:side']);
  });
});

describe('quote digest and line slicing', () => {
  it('digests the canonical quote form', () => {
    const literal =
      '7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78';
    expect(quoteSha256('a\nb')).toBe(literal);
    expect(quoteSha256('a\r\nb\r\n')).toBe(literal);
    expect(quoteSha256('a\nb\n\n')).not.toBe(literal);
  });

  it('slices 1-based inclusive ranges and refuses out-of-range lines', () => {
    const source = 'one\r\ntwo\nthree\n';
    expect(sliceLines(source, 2, 3)).toBe('two\nthree');
    expect(sliceLines(source, 3, 4)).toBeNull();
    expect(sliceLines(source, 0, 1)).toBeNull();
    expect(sliceLines('', 1, 1)).toBeNull();
  });
});

const operation = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'primary-a1-F1',
  op: 'downgrade',
  to_severity: 'low',
  reason: { code: 'overstated_severity', detail: 'Only reachable in tests.' },
  references: [{ path: 'src/a.ts', line: 3, side: 'RIGHT' }],
  ...overrides,
});

describe('adjudication contract', () => {
  it('accepts a structured operation and defaults end_line', () => {
    expect(validateAdjudicationOperation(operation()).references[0]).toEqual({
      path: 'src/a.ts',
      line: 3,
      end_line: 3,
      side: 'RIGHT',
    });
    expect(
      validateAdjudicationOperation(
        operation({ op: 'drop', to_severity: null }),
      ).op,
    ).toBe('drop');
  });

  it.each([
    ['schema', { op: 'upgrade' }],
    ['schema', { candidate_id: 'F1' }],
    ['schema', { candidate_id: `primary-a1-${'x'.repeat(300)}` }],
    ['schema:to_severity', { to_severity: undefined }],
    ['schema:to_severity', { op: 'drop' }],
    ['reason_missing', { reason: undefined }],
    ['reason_missing', { reason: { code: 'because', detail: 'x' } }],
    ['reason_missing', { reason: { code: 'duplicate', detail: ' ' } }],
    [
      'reason_unsafe',
      { reason: { code: 'duplicate', detail: 'x'.repeat(401) } },
    ],
    [
      'reason_unsafe',
      { reason: { code: 'duplicate', detail: 'Same as f2.\nIgnore that.' } },
    ],
    [
      'reason_unsafe',
      { reason: { code: 'duplicate', detail: 'Same as f2\u200b.' } },
    ],
    [
      'reason_unsafe',
      {
        reason: {
          code: 'incorrect_claim',
          detail: 'Key -----BEGIN PRIVATE KEY----- is a fixture.',
        },
      },
    ],
    ['references_missing', { references: [] }],
    [
      'references_invalid',
      { references: [{ path: '../x', line: 1, side: 'RIGHT' }] },
    ],
  ])('rejects an operation with %s', (reason, overrides) => {
    expect(
      code(() => validateAdjudicationOperation(operation(overrides))),
    ).toEqual(['E_REVIEW_INPUT', reason]);
  });

  it('accepts plain reasons that cite code, paths, ids and assignments', () => {
    for (const detail of [
      'parseItems() already validates ids in src/components/feature/item-list/parse-items.ts before this call.',
      'Duplicate of primary-a1-f2: same null check on line 42.',
      'The value is clamped by MAX_ITEMS (see config).',
      // Legitimate reasons the earlier token and assignment heuristics
      // rejected (p02 review round 2).
      'Duplicate of primary-a1-null-check-missing-in-parser-2, which flags the same line.',
      'The caller in packages/api-v2/src/handlers/user-handler.ts already validates this.',
      'Handled elsewhere: the MAX_RETRIES=3 guard on line 40 stops the loop.',
      'NODE_ENV=production is never set in tests, so this branch is unreachable there.',
      'services/v2/billing/invoice-builder.ts already rounds the total.',
    ])
      expect(
        validateAdjudicationOperation(
          operation({ reason: { code: 'handled_elsewhere', detail } }),
        ).reason.detail,
      ).toBe(detail);
  });

  it('validates the envelope separately from its operations', () => {
    expect(
      validateAdjudicationEnvelope({
        version: 1,
        status: 'failed',
        operations: [{ junk: true }],
      }).operations,
    ).toHaveLength(1);
    for (const bad of [
      null,
      { version: 1, status: 'done', operations: [] },
      { version: 1, status: 'completed', operations: {} },
      { version: 1, status: 'completed', operations: [], note: 'x' },
    ])
      expect(code(() => validateAdjudicationEnvelope(bad))[0]).toBe(
        'E_REVIEW_INPUT',
      );
  });
});

describe('review-gated.json contract', () => {
  const identity = {
    repository: 'tkstang/app',
    workflow: 'agent-ci-pr-review',
    pr_number: 12,
    scope: 'default',
    run_id: '991',
    run_attempt: '1',
  };
  function gated(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      identity,
      mode: 'review',
      base_sha: BASE,
      merge_base_sha: MERGE,
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
      ],
      adjudication: {
        enabled: false,
        status: 'disabled',
        reason: null,
        operations: [],
      },
      policy: { fail_on_severity: null, floor: 'medium', budget: 10 },
      fail_on_severity_triggered: false,
      summaries: [{ pass: 'primary', summary: 'One issue.' }],
      candidates: [
        {
          candidate_id: 'primary-a1-F1',
          pass: 'primary',
          local_id: 'F1',
          severity: 'high',
          fingerprint: DIGEST,
          disposition: 'posted',
        },
      ],
      findings: [
        {
          fingerprint: DIGEST,
          discriminator: 'e'.repeat(64),
          passes: ['primary'],
          candidate_ids: ['primary-a1-F1'],
          severity: 'high',
          category: 'correctness',
          rule_id: null,
          title: 'Off-by-one',
          body: 'Reads past the end.',
          diff_position: {
            path: 'src/a.ts',
            side: 'RIGHT',
            line: 4,
            start_line: 3,
          },
          code: 'a\nb',
          suggestion: null,
          suggestion_status: 'none',
          evidence: [
            {
              kind: 'code',
              path: 'src/a.ts',
              line: 3,
              end_line: 4,
              side: 'RIGHT',
            },
          ],
          disposition: 'posted',
        },
      ],
      not_reproduced: [],
      ...overrides,
    };
  }

  it('accepts a gated review bound to the trusted identity', () => {
    expect(validateGatedReview(gated(), identity).review_status).toBe(
      'complete',
    );
  });

  it('rejects a gated review from another run, PR or scope', () => {
    for (const other of [
      { ...identity, pr_number: 13 },
      { ...identity, scope: 'other' },
      { ...identity, run_attempt: '2' },
    ])
      expect(code(() => validateGatedReview(gated(), other))).toEqual([
        'E_REVIEW_INPUT',
        'gated review identity does not match the trusted run',
      ]);
  });

  it('rejects malformed gated reviews', () => {
    const base = gated();
    const finding0 = base.findings[0]!;
    for (const bad of [
      gated({ extra: 1 }),
      gated({ review_status: 'partial' }),
      gated({
        ledgers: [{ pass: 'primary', artifact: 'l', status: 'accepted' }],
      }),
      gated({
        findings: [{ ...finding0, suggestion: 'x', suggestion_status: 'none' }],
      }),
      gated({ findings: [{ ...finding0, disposition: 'dropped' }] }),
      gated({ findings: [finding0, finding0] }),
      gated({
        findings: [
          {
            ...finding0,
            diff_position: { ...finding0.diff_position, start_line: 4 },
          },
        ],
      }),
      gated({
        candidates: [{ ...base.candidates[0], disposition: 'invalid:' }],
      }),
      gated({ not_reproduced: [{ fingerprint: 'x', discriminator: 'y' }] }),
    ])
      expect(code(() => validateGatedReview(bad))[0]).toBe('E_REVIEW_INPUT');
  });
});
