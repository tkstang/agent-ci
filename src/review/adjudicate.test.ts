import {
  acceptAdjudicationAnswer,
  adjudicatorPrompt,
  buildAdjudicationSources,
  checkAdjudication,
  collectCandidates,
  promptCandidates,
} from '@agent-ci/review/adjudicate.js';
import { quoteSha256 } from '@agent-ci/review/contracts.js';
import { PROMPT_LIMITS } from '@agent-ci/review/prompt.js';
import { describe, expect, it } from 'vitest';

const SHAS = {
  mode: 'review' as const,
  base_sha: 'a'.repeat(40),
  merge_base_sha: 'b'.repeat(40),
  head_sha: 'c'.repeat(40),
};
const SOURCE = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
  '\n',
);
const read = (side: string, file: string) =>
  side === 'RIGHT' && file === 'src/a.ts' ? SOURCE : null;

function finding(id: string, severity: string, line = 10) {
  return {
    id,
    severity,
    category: 'correctness',
    rule_id: null,
    title: `Finding ${id}`,
    body: 'Body.',
    path: 'src/a.ts',
    line,
    end_line: line,
    side: 'RIGHT',
    original_code: `line ${line}`,
    suggestion: null,
    evidence: [
      {
        kind: 'code',
        path: 'src/a.ts',
        line,
        end_line: line,
        side: 'RIGHT',
        quote_sha256: quoteSha256(`line ${line}`),
      },
    ],
  };
}
function review(findings: unknown[]) {
  return { version: 1, pass: 'primary', summary: 's', findings, ...SHAS };
}
const candidates = collectCandidates(
  [
    {
      pass: 'primary',
      attempt: '1',
      review: review([finding('m1', 'medium'), finding('h1', 'high', 150)]),
    },
  ],
  SHAS,
  null,
);
const sources = buildAdjudicationSources(candidates, read);
const op = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'primary-a1-m1',
  op: 'drop',
  to_severity: null,
  reason: { code: 'incorrect_claim', detail: 'Handled above.' },
  references: [{ path: 'src/a.ts', line: 12, end_line: 12, side: 'RIGHT' }],
  ...overrides,
});

describe('adjudication candidates and sources', () => {
  it('namespaces candidates and protects high and critical findings', () => {
    expect(candidates.map((c) => [c.candidate_id, c.protected])).toEqual([
      ['primary-a1-m1', false],
      ['primary-a1-h1', true],
    ]);
  });

  it('shows windows only around reducible candidates', () => {
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      side: 'RIGHT',
      path: 'src/a.ts',
      status: 'excerpt',
      windows: [[1, 70]],
    });
  });
});

describe('checkAdjudication', () => {
  const provided = promptCandidates(candidates).provided;

  it('keeps a supported drop', () => {
    expect(
      checkAdjudication({ operations: [op()] }, candidates, sources, provided),
    ).toEqual({
      operations: [
        expect.objectContaining({ candidate_id: 'primary-a1-m1', op: 'drop' }),
      ],
      rejections: [],
    });
  });

  it.each([
    [
      'a protected candidate (shown only as a summary)',
      op({ candidate_id: 'primary-a1-h1' }),
      'cannot be reduced',
    ],
    [
      'an unknown candidate',
      op({ candidate_id: 'primary-a1-zz' }),
      'unknown candidate',
    ],
    [
      'a reference outside the excerpt',
      op({
        references: [
          { path: 'src/a.ts', line: 150, end_line: 150, side: 'RIGHT' },
        ],
      }),
      'not within a provided source excerpt',
    ],
    [
      'an upgrade dressed as a downgrade',
      op({ op: 'downgrade', to_severity: 'high' }),
      'must lower',
    ],
  ])('rejects %s', (_name, operation, message) => {
    expect(() =>
      checkAdjudication(
        { operations: [operation] },
        candidates,
        sources,
        provided,
      ),
    ).toThrow(message);
  });

  it('rejects every operation on a candidate named twice', () => {
    expect(() =>
      checkAdjudication(
        { operations: [op(), op({ op: 'downgrade', to_severity: 'low' })] },
        candidates,
        sources,
        provided,
      ),
    ).toThrow('more than one operation');
  });

  it('refuses anything but {operations: [...]}', () => {
    for (const bad of [
      null,
      [],
      { operations: {} },
      { operations: [], note: 'x' },
    ])
      expect(() =>
        checkAdjudication(bad, candidates, sources, provided),
      ).toThrow(expect.objectContaining({ code: 'E_REVIEW_INPUT' }));
  });

  it('is strict on the first answer and keeps the valid operations at the last chance', () => {
    const answer = {
      operations: [op(), op({ candidate_id: 'primary-a1-h1' })],
    };
    expect(
      acceptAdjudicationAnswer(answer, false, candidates, sources, provided),
    ).toMatchObject({ ok: false, code: 'E_REVIEW_INPUT' });
    expect(
      acceptAdjudicationAnswer(answer, true, candidates, sources, provided),
    ).toMatchObject({
      ok: true,
      value: {
        version: 1,
        status: 'completed',
        operations: [
          expect.objectContaining({ candidate_id: 'primary-a1-m1' }),
        ],
      },
    });
  });
});

describe('adjudicatorPrompt', () => {
  it('stays under the argv-safe prompt cap with maximal candidates and sources', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      ...finding(`f${i}`, 'medium', 1 + i * 3),
      body: 'x'.repeat(4000),
    }));
    const many = collectCandidates(
      [{ pass: 'primary', attempt: '1', review: review(big) }],
      SHAS,
      null,
    );
    const longSource = Array.from({ length: 200 }, () => 'y'.repeat(200)).join(
      '\n',
    );
    const prompt = adjudicatorPrompt(
      many,
      buildAdjudicationSources(many, () => longSource),
    );
    expect(Buffer.byteLength(prompt)).toBeLessThan(PROMPT_LIMITS.promptBytes);
    expect(prompt).toContain('you have no file, shell or network tools');
  });
});
