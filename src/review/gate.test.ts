import {
  type GatedReview,
  type PostedMarker,
  quoteSha256,
  validateGatedReview,
} from '@agent-ci/review/contracts.js';
import { parseUnifiedDiff } from '@agent-ci/review/diff-position.js';
import {
  canonicalRuleId,
  findingIdentity,
  normalizeCode,
} from '@agent-ci/review/fingerprint.js';
import { type GateInput, gateReview } from '@agent-ci/review/gate.js';
import { renderSummary } from '@agent-ci/review/render.js';
import { describe, expect, it } from 'vitest';

// Ported from pntr tests/workflows/pr-review-gate.test.ts
// (voxmedia/pntr@e438668) without check evidence and ledgers (p04).

const FILE = [
  'export function load(items) {',
  '  for (const item of items) {',
  '    cache.set(item.id, item);',
  '  }',
  '  for (const item of items) {',
  '    cache.set(item.id, item);',
  '  }',
  '}',
  '',
  'export function save(items) {',
  '  for (const item of items) {',
  '    cache.set(item.id, item);',
  '  }',
  '}',
  '',
].join('\n');

function identity(
  source: string,
  line: number,
  end_line = line,
  overrides: Partial<Parameters<typeof findingIdentity>[0]> = {},
) {
  return findingIdentity({
    path: 'src/cache.ts',
    source,
    line,
    end_line,
    category: 'correctness',
    ruleId: null,
    ...overrides,
  });
}
function insertLines(source: string, at: number, lines: string[]) {
  const all = source.split('\n');
  all.splice(at - 1, 0, ...lines);
  return all.join('\n');
}

describe('fingerprint identity', () => {
  it('normalizes whitespace and line endings conservatively', () => {
    expect(normalizeCode('\r\n  a  =\t b;\r\n\r\n    c();  \r\n\n')).toBe(
      'a = b;\n\nc();',
    );
    expect(normalizeCode('a(b)')).not.toBe(normalizeCode('a (b)'));
  });

  it('separates identical snippets by scope and by ordinal within a scope', () => {
    const first = identity(FILE, 3);
    const second = identity(FILE, 6);
    const other = identity(FILE, 12);
    expect(
      new Set([first.fingerprint, second.fingerprint, other.fingerprint]).size,
    ).toBe(3);
    expect(first.discriminator).not.toBe(second.discriminator);
  });

  it('keeps each occurrence stable when unrelated lines are inserted', () => {
    const before = [3, 6, 12].map((line) => identity(FILE, line));
    // A new top-level function above, plus an unrelated statement inside
    // the first scope between the two identical loops.
    const shifted = insertLines(
      insertLines(FILE, 5, ['  log("between");']),
      1,
      ['import { cache } from "./cache";', '', 'function helper() {}', ''],
    );
    const after = [7, 11, 17].map((line) => identity(shifted, line));
    expect(after).toEqual(before);
  });

  it('is stable under re-indentation and independent of line numbers', () => {
    const reindented = FILE.replace(
      '    cache.set(item.id, item);\n  }\n}\n\nexport function save',
      '      cache.set(item.id,   item);\n  }\n}\n\nexport function save',
    );
    expect(identity(reindented, 6)).toEqual(identity(FILE, 6));
  });

  it('ignores blank edge lines of the cited range', () => {
    const source = 'fn a() {\n    go();\n\n    go();\n\n}\n';
    expect(identity(source, 4, 5)).toEqual(identity(source, 4));
    expect(identity(source, 3, 4)).toEqual(identity(source, 4));
    expect(identity(source, 4)).not.toEqual(identity(source, 2));
  });

  it('stays linear for a long range deep in a header-less file', () => {
    // Every line is identical and indented: the worst case for window
    // comparison, since every earlier line starts a candidate match.
    const source = `${'    x();\n'.repeat(30000)}`;
    const started = performance.now();
    const deep = identity(source, 27001, 30000);
    const elapsed = performance.now() - started;
    expect(deep).not.toEqual(identity(source, 27000, 29999));
    // Quadratic matching took seconds here; linear matching takes a few
    // milliseconds, so this bound is generous.
    expect(elapsed).toBeLessThan(1000);
  });

  it('changes with path, category, rule and flagged code', () => {
    const base = identity(FILE, 3).fingerprint;
    for (const changed of [
      identity(FILE, 3, 3, { path: 'src/other.ts' }),
      identity(FILE, 3, 3, { category: 'performance' }),
      identity(FILE, 3, 3, { ruleId: 'AGENTS.md' }),
      identity(FILE, 2, 3),
    ])
      expect(changed.fingerprint).not.toBe(base);
  });
});

describe('canonical rule ids', () => {
  const tree = new Map([
    [
      'AGENTS.md',
      '# Agent Orientation\n\n## Definition of Done\n\n```md\n## Not A Heading\n```\n\n## Definition of Done\n',
    ],
    ['.cursor/rules/style.mdc', 'Use tabs.\n'],
    ['src/a.ts', 'code\n'],
  ]);
  const readHead = (path: string) => tree.get(path) ?? null;

  it.each([
    ['AGENTS.md', 'AGENTS.md'],
    ['./AGENTS.md', 'AGENTS.md'],
    ['AGENTS.md#Definition-of-Done', 'AGENTS.md#definition-of-done'],
    ['AGENTS.md#definition-of-done-1', 'AGENTS.md#definition-of-done-1'],
    ['.cursor/rules/style.mdc', '.cursor/rules/style.mdc'],
  ])('accepts %s as %s', (raw, canonical) => {
    expect(canonicalRuleId(raw, readHead)).toBe(canonical);
  });

  it.each([
    ['a missing file', 'docs/missing.md'],
    ['a missing heading', 'AGENTS.md#nope'],
    ['a heading inside a code fence', 'AGENTS.md#not-a-heading'],
    ['an empty anchor', 'AGENTS.md#'],
    ['a non-rule file', 'src/a.ts'],
    ['a traversal path', '../AGENTS.md'],
  ])('rejects %s', (_name, raw) => {
    expect(canonicalRuleId(raw, readHead)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gate pipeline
// ---------------------------------------------------------------------------

const BASE = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const IDENTITY = {
  repository: 'tkstang/app',
  workflow: 'agent-ci-pr-review',
  pr_number: 7,
  scope: 'default',
  run_id: '500',
  run_attempt: '1',
};
const LEGACY_BASE = 'keep\nold();\nkeep\n';
const LEGACY_HEAD = 'keep\nfresh();\nkeep\n';
const RULES = '# Rules\n\n## Error handling\n\nNever swallow errors.\n';

/** Diff that adds `cache` as a new file and modifies `src/legacy.ts`. */
function diffFor(cache: string) {
  const lines = cache.replace(/\n$/u, '').split('\n');
  return parseUnifiedDiff(
    [
      'diff --git a/src/cache.ts b/src/cache.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/cache.ts',
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      'diff --git a/src/legacy.ts b/src/legacy.ts',
      '--- a/src/legacy.ts',
      '+++ b/src/legacy.ts',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old();',
      '+fresh();',
      ' keep',
      '',
    ].join('\n'),
  );
}
function readerFor(cache: string): GateInput['read'] {
  const head = new Map([
    ['src/cache.ts', cache],
    ['src/legacy.ts', LEGACY_HEAD],
    ['AGENTS.md', RULES],
  ]);
  const base = new Map([['src/legacy.ts', LEGACY_BASE]]);
  return (side, path) => (side === 'RIGHT' ? head : base).get(path) ?? null;
}
const lineOf = (source: string, line: number, end = line) =>
  source
    .split('\n')
    .slice(line - 1, end)
    .join('\n');

type FindingSpec = Record<string, unknown> & {
  line?: number;
  end_line?: number;
};
function finding(spec: FindingSpec = {}, source = FILE) {
  const line = spec.line ?? 3;
  const end = spec.end_line ?? line;
  const side = (spec.side as string) ?? 'RIGHT';
  const path = (spec.path as string) ?? 'src/cache.ts';
  const quoteSource =
    path === 'src/legacy.ts'
      ? side === 'RIGHT'
        ? LEGACY_HEAD
        : LEGACY_BASE
      : source;
  return {
    id: 'F1',
    severity: 'high',
    category: 'correctness',
    title: 'Cache entry overwritten',
    body: 'Duplicate ids overwrite earlier entries.',
    path,
    line,
    end_line: end,
    side,
    original_code: lineOf(quoteSource, line, end),
    evidence: [
      {
        kind: 'code',
        path,
        line,
        end_line: end,
        side,
        quote_sha256: quoteSha256(lineOf(quoteSource, line, end)),
      },
    ],
    ...spec,
  };
}
function review(pass: 'primary' | 'second', findings: unknown[]) {
  return {
    version: 1,
    mode: 'review',
    pass,
    base_sha: BASE,
    merge_base_sha: MERGE,
    head_sha: HEAD,
    summary: `${pass} summary`,
    findings,
  };
}
type RunOptions = Partial<Omit<GateInput, 'passes'>> & {
  primary?: unknown[] | null;
  second?: unknown[] | null;
  source?: string;
};
function run(options: RunOptions = {}): GatedReview {
  const source = options.source ?? FILE;
  const passes: GateInput['passes'] = [
    {
      pass: 'primary',
      enabled: true,
      attempt: '1',
      review:
        options.primary === null
          ? null
          : review('primary', options.primary ?? [finding()]),
    },
  ];
  if (options.second !== undefined)
    passes.push({
      pass: 'second',
      enabled: true,
      attempt: '1',
      review: options.second === null ? null : review('second', options.second),
    });
  return gateReview({
    identity: options.identity ?? IDENTITY,
    mode: 'review',
    base_sha: BASE,
    merge_base_sha: MERGE,
    head_sha: HEAD,
    diff: options.diff ?? diffFor(source),
    read: options.read ?? readerFor(source),
    passes,
    adjudication: options.adjudication ?? { enabled: false, value: null },
    policy: options.policy,
    posted: options.posted,
  });
}
const dispositions = (gated: GatedReview) =>
  Object.fromEntries(
    gated.candidates.map((c) => [c.candidate_id, c.disposition]),
  );
const markersOf = (gated: GatedReview): PostedMarker[] =>
  gated.findings
    .filter((f) => f.disposition === 'posted')
    .map(({ fingerprint, discriminator }) => ({ fingerprint, discriminator }));

describe('gate: validation', () => {
  it('posts a valid finding and emits a valid review-gated.json', () => {
    const gated = run();
    expect(validateGatedReview(gated, IDENTITY)).toBe(gated);
    expect(gated.review_status).toBe('complete');
    expect(gated.findings).toHaveLength(2);
    expect(gated.findings[0]).toMatchObject({
      passes: ['primary'],
      candidate_ids: ['primary-a1-F1'],
      disposition: 'posted',
      diff_position: {
        path: 'src/cache.ts',
        side: 'RIGHT',
        line: 3,
        start_line: null,
      },
      code: '    cache.set(item.id, item);',
    });
  });

  it.each([
    ['schema:severity', finding({ severity: 'urgent' })],
    ['anchor_not_in_diff', finding({ path: 'src/elsewhere.ts' })],
    ['evidence_missing', finding({ evidence: [] })],
    [
      'evidence_quote_mismatch',
      finding({
        evidence: [
          {
            kind: 'code',
            path: 'src/cache.ts',
            line: 3,
            end_line: 3,
            side: 'RIGHT',
            quote_sha256: quoteSha256('cache.set(item.id, item);'),
          },
        ],
      }),
    ],
    [
      'evidence_out_of_range',
      finding({
        evidence: [
          {
            kind: 'code',
            path: 'src/cache.ts',
            line: 90,
            end_line: 90,
            side: 'RIGHT',
            quote_sha256: 'f'.repeat(64),
          },
        ],
      }),
    ],
    [
      'evidence_source_missing',
      finding({
        evidence: [
          {
            kind: 'code',
            path: 'src/cache.ts',
            line: 1,
            end_line: 1,
            side: 'LEFT',
            quote_sha256: 'f'.repeat(64),
          },
        ],
      }),
    ],
  ])('rejects a candidate as invalid:%s', (reason, candidate) => {
    const gated = run({ primary: [candidate] });
    expect(gated.candidates[0]!.disposition).toBe(`invalid:${reason}`);
    expect(() => validateGatedReview(gated)).not.toThrow();
    expect(gated.findings).toHaveLength(0);
    expect(gated.review_status).toBe('complete');
  });

  it('accepts LEFT findings against the merge-base tree', () => {
    const gated = run({
      primary: [finding({ path: 'src/legacy.ts', side: 'LEFT', line: 2 })],
    });
    expect(gated.findings[0]).toMatchObject({
      diff_position: { side: 'LEFT', line: 2 },
      code: 'old();',
    });
  });

  it('rejects duplicate local ids within a pass', () => {
    const gated = run({ primary: [finding(), finding({ line: 6 })] });
    expect(dispositions(gated)).toEqual({
      'primary-a1-#0': 'invalid:duplicate_id',
      'primary-a1-#1': 'invalid:duplicate_id',
    });
  });
});

describe('gate: multiple passes', () => {
  it('namespaces candidate ids and groups by fingerprint at the highest severity', () => {
    const gated = run({
      primary: [finding({ severity: 'medium', title: 'Primary wording' })],
      second: [finding({ severity: 'critical', title: 'Second wording' })],
    });
    expect(gated.findings).toHaveLength(1);
    expect(gated.findings[0]).toMatchObject({
      severity: 'critical',
      title: 'Second wording',
      passes: ['primary', 'second'],
      candidate_ids: ['primary-a1-F1', 'second-a1-F1'],
    });
    expect(dispositions(gated)).toEqual({
      'primary-a1-F1': 'posted',
      'second-a1-F1': 'posted',
    });
  });

  it('suppresses conflicting suggestions and keeps an agreed one', () => {
    const fix = '    cache.add(item.id, item);';
    const conflict = run({
      primary: [finding({ suggestion: fix })],
      second: [finding({ suggestion: '    cache.put(item);' })],
    });
    expect(conflict.findings[0]).toMatchObject({
      suggestion: null,
      suggestion_status: 'suppressed:suggestion_conflict',
    });
    const agreed = run({
      primary: [finding({ suggestion: fix })],
      second: [finding({ suggestion: fix })],
    });
    expect(agreed.findings[0]).toMatchObject({
      suggestion: fix,
      suggestion_status: 'kept',
    });
  });

  it('applies one comment budget across passes, most severe first', () => {
    const gated = run({
      policy: { budget: 2 },
      primary: [
        finding({ id: 'P1', line: 3, severity: 'medium' }),
        finding({ id: 'P2', line: 12, severity: 'high' }),
      ],
      second: [finding({ id: 'S1', line: 6, severity: 'critical' })],
    });
    expect(dispositions(gated)).toEqual({
      'primary-a1-P1': 'over_budget',
      'primary-a1-P2': 'posted',
      'second-a1-S1': 'posted',
    });
    expect(gated.findings.map((f) => f.severity)).toEqual([
      'critical',
      'high',
      'medium',
    ]);
  });

  it('marks the review incomplete when an enabled pass fails, keeping valid findings', () => {
    for (const second of [null, [{ not: 'a finding' }]]) {
      const gated = run({ second: second as unknown[] | null });
      if (second === null) {
        expect(gated.review_status).toBe('incomplete');
        expect(gated.passes[1]).toMatchObject({
          pass: 'second',
          status: 'failed',
          reason: 'review output missing',
        });
      } else {
        // A malformed finding invalidates only that candidate.
        expect(gated.review_status).toBe('complete');
      }
      expect(gated.findings[0]!.disposition).toBe('posted');
    }
    const wrongHead = gateReview({
      identity: IDENTITY,
      mode: 'review',
      base_sha: BASE,
      merge_base_sha: MERGE,
      head_sha: HEAD,
      diff: diffFor(FILE),
      read: readerFor(FILE),
      passes: [
        {
          pass: 'primary',
          enabled: true,
          attempt: '1',
          review: {
            ...review('primary', [finding()]),
            head_sha: 'f'.repeat(40),
          },
        },
      ],
      adjudication: { enabled: false, value: null },
    });
    expect(wrongHead.review_status).toBe('incomplete');
    expect(wrongHead.passes[0]!.reason).toMatch(/head_sha/u);
  });

  it('marks the review incomplete when the primary pass is missing or disabled', () => {
    const secondOnly = {
      pass: 'second' as const,
      enabled: true,
      attempt: '1',
      review: review('second', [finding()]),
    };
    for (const passes of [
      [secondOnly],
      [
        {
          pass: 'primary' as const,
          enabled: false,
          attempt: '1',
          review: review('primary', []),
        },
        secondOnly,
      ],
    ]) {
      const gated = gateReview({
        identity: IDENTITY,
        mode: 'review',
        base_sha: BASE,
        merge_base_sha: MERGE,
        head_sha: HEAD,
        diff: diffFor(FILE),
        read: readerFor(FILE),
        passes,
        adjudication: { enabled: false, value: null },
      });
      expect(gated.review_status).toBe('incomplete');
      expect(gated.passes[0]).toMatchObject({
        pass: 'primary',
        status: 'failed',
        reason: 'primary reviewer pass missing',
      });
      expect(gated.findings.map((f) => f.passes)).toEqual([['second']]);
      expect(() => validateGatedReview(gated, IDENTITY)).not.toThrow();
    }
  });

  it('ignores the output of a disabled pass', () => {
    const gated = gateReview({
      identity: IDENTITY,
      mode: 'review',
      base_sha: BASE,
      merge_base_sha: MERGE,
      head_sha: HEAD,
      diff: diffFor(FILE),
      read: readerFor(FILE),
      passes: [
        {
          pass: 'primary',
          enabled: true,
          attempt: '1',
          review: review('primary', []),
        },
        {
          pass: 'second',
          enabled: false,
          attempt: '1',
          review: review('second', [finding()]),
        },
      ],
      adjudication: { enabled: false, value: null },
    });
    expect(gated.findings).toHaveLength(0);
    expect(gated.passes[1]!.status).toBe('disabled');
  });
});

const op = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'primary-a1-M1',
  op: 'drop',
  reason: { code: 'incorrect_claim', detail: 'Ids are unique upstream.' },
  references: [{ path: 'src/cache.ts', line: 1, side: 'RIGHT' }],
  ...overrides,
});

describe('gate: adjudication', () => {
  const candidates = [
    finding({ id: 'M1', line: 3, severity: 'medium' }),
    finding({ id: 'H1', line: 12, severity: 'high' }),
  ];
  const adjudicated = (
    operations: unknown[] | null,
    extra: RunOptions = {},
    status = 'completed',
  ) =>
    run({
      primary: candidates,
      adjudication: {
        enabled: true,
        value: operations === null ? null : { version: 1, status, operations },
      },
      ...extra,
    });

  it('applies drop and downgrade operations to unprotected candidates', () => {
    const dropped = adjudicated([op()]);
    expect(dispositions(dropped)['primary-a1-M1']).toBe(
      'dropped_by_adjudicator',
    );
    expect(dropped.adjudication.operations[0]!.outcome).toBe('applied');
    const downgraded = adjudicated([
      op({ op: 'downgrade', to_severity: 'low' }),
    ]);
    expect(dispositions(downgraded)['primary-a1-M1']).toBe('below_floor');
  });

  it.each([
    ['protected_severity', op({ candidate_id: 'primary-a1-H1' })],
    ['unknown_candidate', op({ candidate_id: 'primary-a1-ZZ' })],
    ['not_a_downgrade', op({ op: 'downgrade', to_severity: 'critical' })],
    ['reason_missing', op({ reason: undefined })],
    ['references_missing', op({ references: [] })],
    [
      'invalid_reference',
      op({ references: [{ path: 'src/cache.ts', line: 99, side: 'RIGHT' }] }),
    ],
  ])('rejects an operation as %s', (reason, operation) => {
    const gated = adjudicated([operation]);
    expect(gated.adjudication.operations[0]!.outcome).toBe(
      `rejected:${reason}`,
    );
    expect(() => validateGatedReview(gated)).not.toThrow();
    expect(dispositions(gated)).toEqual({
      'primary-a1-M1': 'posted',
      'primary-a1-H1': 'posted',
    });
  });

  it.each([
    [
      'an over-long ASCII candidate id',
      op({ candidate_id: 'x'.repeat(300) }),
      '',
      'drop',
    ],
    ['a multibyte op', op({ op: '\u00e9'.repeat(100) }), 'primary-a1-M1', ''],
    [
      'a multibyte candidate id',
      op({ candidate_id: '\u00e9'.repeat(200) }),
      '',
      'drop',
    ],
    ['a non-object operation', 'drop everything', '', ''],
  ])(
    'rejects %s without invalidating review-gated.json',
    (_name, operation, candidateId, opName) => {
      const gated = adjudicated([operation, op()]);
      expect(() => validateGatedReview(gated, IDENTITY)).not.toThrow();
      expect(gated.adjudication.operations[0]).toEqual({
        candidate_id: candidateId,
        op: opName,
        to_severity: null,
        outcome: 'rejected:schema',
      });
      // The well-formed operation beside it still applies.
      expect(gated.adjudication.operations[1]!.outcome).toBe('applied');
      expect(gated.findings.map((f) => f.disposition)).toEqual(['posted']);
    },
  );

  it('protects findings at or above fail_on_severity', () => {
    const gated = adjudicated([op()], {
      policy: { fail_on_severity: 'medium' },
    });
    expect(gated.adjudication.operations[0]!.outcome).toBe(
      'rejected:protected_severity',
    );
  });

  it('rejects conflicting operations on one candidate', () => {
    const gated = adjudicated([
      op(),
      op({ op: 'downgrade', to_severity: 'low' }),
    ]);
    expect(gated.adjudication.operations.map((o) => o.outcome)).toEqual([
      'rejected:conflicting_operations',
      'rejected:conflicting_operations',
    ]);
  });

  it('applies nothing when the adjudicator fails or emits invalid output', () => {
    for (const gated of [
      adjudicated(null),
      adjudicated([op()], {}, 'failed'),
      run({
        primary: candidates,
        adjudication: { enabled: true, value: { operations: [op()] } },
      }),
    ]) {
      expect(() => validateGatedReview(gated, IDENTITY)).not.toThrow();
      expect(gated.adjudication.status).toBe('failed');
      expect(gated.adjudication.operations).toEqual([]);
      expect(gated.review_status).toBe('complete');
      expect(Object.values(dispositions(gated))).toEqual(['posted', 'posted']);
    }
  });

  it('ignores adjudication output when the pass is disabled', () => {
    const gated = run({
      primary: candidates,
      adjudication: {
        enabled: false,
        value: { version: 1, status: 'completed', operations: [op()] },
      },
    });
    expect(gated.adjudication.status).toBe('disabled');
    expect(dispositions(gated)['primary-a1-M1']).toBe('posted');
  });
});

describe('gate: failure policy, dedupe, floor and suggestions', () => {
  it('evaluates fail_on_severity before dedupe, floor and budget', () => {
    const first = run({ policy: { fail_on_severity: 'high' } });
    expect(first.fail_on_severity_triggered).toBe(true);
    const replay = run({
      policy: { fail_on_severity: 'high', budget: 0 },
      posted: markersOf(first),
    });
    expect(replay.findings[0]!.disposition).toBe('duplicate');
    expect(replay.fail_on_severity_triggered).toBe(true);
    const low = run({
      primary: [finding({ severity: 'low' })],
      policy: { fail_on_severity: 'low' },
    });
    expect(low.findings[0]!.disposition).toBe('below_floor');
    expect(low.fail_on_severity_triggered).toBe(true);
    expect(run().fail_on_severity_triggered).toBe(false);
  });

  it('keeps low findings for the summary unless the floor is lowered', () => {
    const low = finding({ severity: 'low' });
    expect(run({ primary: [low] }).findings[0]!.disposition).toBe(
      'below_floor',
    );
    expect(
      run({ primary: [low], policy: { floor: 'low' } }).findings[0]!
        .disposition,
    ).toBe('posted');
  });

  it('is idempotent on replay and reports vanished findings as not reproduced', () => {
    const first = run({
      primary: [
        finding(),
        finding({ id: 'F2', line: 12, category: 'performance' }),
      ],
    });
    expect(markersOf(first)).toHaveLength(2);
    const replay = run({
      primary: [finding({ title: 'Reworded title', body: 'Reworded body.' })],
      posted: markersOf(first),
    });
    expect(replay.findings.map((f) => f.disposition)).toEqual(['duplicate']);
    expect(replay.not_reproduced).toEqual([markersOf(first)[1]]);
  });

  it('keeps identical snippets distinct, posts neither on replay, and survives inserted lines', () => {
    const twins = [
      finding({ id: 'A', line: 3 }),
      finding({ id: 'B', line: 6 }),
    ];
    const first = run({ primary: twins });
    expect(first.findings.map((f) => f.disposition)).toEqual([
      'posted',
      'posted',
    ]);
    expect(new Set(first.findings.map((f) => f.fingerprint)).size).toBe(2);

    expect(
      run({ primary: twins, posted: markersOf(first) }).findings.map(
        (f) => f.disposition,
      ),
    ).toEqual(['duplicate', 'duplicate']);

    const shifted = insertLines(
      insertLines(FILE, 5, ['  log("between");']),
      1,
      ['import { cache } from "./cache";', ''],
    );
    const moved = run({
      source: shifted,
      primary: [
        finding({ id: 'A', line: 5 }, shifted),
        finding({ id: 'B', line: 9 }, shifted),
      ],
      posted: markersOf(first),
    });
    expect(moved.findings.map((f) => f.disposition)).toEqual([
      'duplicate',
      'duplicate',
    ]);
    expect(moved.not_reproduced).toEqual([]);
  });

  it('keeps twin snippets under identically named scopes distinct across runs', () => {
    const twins = [
      'struct Foo { x: Option<u32> }',
      'impl Foo {',
      '    fn get(&self) -> u32 { self.x.unwrap() }',
      '}',
      'impl Foo {',
      '    fn get(&self) -> u32 { self.x.unwrap() }',
      '}',
      '',
    ].join('\n');
    const pair = (source: string, lines: [number, number]) => [
      finding({ id: 'F1', line: lines[0] }, source),
      finding({ id: 'F2', line: lines[1] }, source),
    ];
    const first = run({ source: twins, primary: pair(twins, [3, 6]) });
    expect(
      first.findings.map((f) => [f.diff_position.line, f.disposition]),
    ).toEqual([
      [3, 'posted'],
      [6, 'posted'],
    ]);
    expect(dispositions(first)).toEqual({
      'primary-a1-F1': 'posted',
      'primary-a1-F2': 'posted',
    });
    expect(
      run({
        source: twins,
        primary: pair(twins, [3, 6]),
        posted: markersOf(first),
      }).findings.map((f) => f.disposition),
    ).toEqual(['duplicate', 'duplicate']);

    // Unrelated comment and blank lines shift both occurrences.
    const shifted = insertLines(
      insertLines(twins, 5, ['', '// unrelated note']),
      3,
      ['    // explains get'],
    );
    const moved = run({
      source: shifted,
      primary: pair(shifted, [4, 9]),
      posted: markersOf(first),
    });
    expect(moved.findings.map((f) => f.disposition)).toEqual([
      'duplicate',
      'duplicate',
    ]);
    expect(moved.not_reproduced).toEqual([]);
  });

  it.each([
    [
      'a trailing blank line',
      [
        'fn a() {',
        '    do_thing();',
        '    other();',
        '    x();',
        '    do_thing();',
        '',
        '    y();',
        '}',
        '',
      ],
      [2, 2],
      [5, 6],
    ],
    [
      'a leading blank line',
      [
        'fn a() {',
        '    do_thing();',
        '    other();',
        '',
        '    do_thing();',
        '    y();',
        '}',
        '',
      ],
      [2, 2],
      [4, 5],
    ],
  ])(
    'keeps an occurrence cited with %s distinct from an identical earlier one',
    (_name, lines, first, second) => {
      const source = (lines as string[]).join('\n');
      const [l1, e1] = first as number[];
      const [l2, e2] = second as number[];
      const gated = run({
        source,
        primary: [
          finding({ id: 'F1', line: l1, end_line: e1 }, source),
          finding({ id: 'F2', line: l2, end_line: e2 }, source),
        ],
      });
      expect(dispositions(gated)).toEqual({
        'primary-a1-F1': 'posted',
        'primary-a1-F2': 'posted',
      });
      expect(gated.findings.map((f) => f.diff_position)).toEqual([
        { path: 'src/cache.ts', side: 'RIGHT', line: e1, start_line: null },
        { path: 'src/cache.ts', side: 'RIGHT', line: e2, start_line: l2 },
      ]);
    },
  );

  it('records a candidate folded into a finding at another position as merged', () => {
    // Line 1 of src/legacy.ts is unchanged context on both sides, and the
    // side is not part of the fingerprint.
    const gated = run({
      primary: [
        finding({ id: 'R', path: 'src/legacy.ts', side: 'RIGHT', line: 1 }),
        finding({ id: 'L', path: 'src/legacy.ts', side: 'LEFT', line: 1 }),
      ],
    });
    expect(gated.findings).toHaveLength(1);
    expect(gated.findings[0]!.diff_position.side).toBe('RIGHT');
    expect(dispositions(gated)).toEqual({
      'primary-a1-R': 'posted',
      'primary-a1-L': 'merged',
    });
    expect(() => validateGatedReview(gated, IDENTITY)).not.toThrow();
  });

  it('verifies rule ids and falls back to the sentinel', () => {
    const cited = run({
      primary: [finding({ rule_id: './AGENTS.md#Error-Handling' })],
    });
    expect(cited.findings[0]!.rule_id).toBe('AGENTS.md#error-handling');
    const bogus = run({ primary: [finding({ rule_id: 'AGENTS.md#missing' })] });
    expect(bogus.findings[0]!.rule_id).toBeNull();
    expect(bogus.findings[0]!.fingerprint).toBe(run().findings[0]!.fingerprint);
    expect(cited.findings[0]!.fingerprint).not.toBe(
      run().findings[0]!.fingerprint,
    );
  });

  it('keeps only safe RIGHT-side suggestions whose original code matches', () => {
    const fix = '    cache.add(item.id, item);';
    expect(
      run({ primary: [finding({ suggestion: fix })] }).findings[0],
    ).toMatchObject({
      suggestion: fix,
      suggestion_status: 'kept',
    });
    expect(
      run({
        primary: [finding({ suggestion: fix, original_code: 'cache.set(x);' })],
      }).findings[0],
    ).toMatchObject({
      suggestion: null,
      suggestion_status: 'suppressed:original_code_mismatch',
    });
    expect(
      run({
        primary: [
          finding({
            path: 'src/legacy.ts',
            side: 'LEFT',
            line: 2,
            suggestion: 'new();',
          }),
        ],
      }).findings[0],
    ).toMatchObject({
      suggestion: null,
      suggestion_status: 'suppressed:left_side',
    });
  });

  it('suppresses suggestions that add invisible or control characters', () => {
    for (const hidden of [
      '\u202e',
      '\u200b',
      '\u2066',
      '\r',
      '\u0007',
      '\u2028',
      '\u2029',
    ]) {
      const suggestion = `    cache.add(item.id${hidden}, item);`;
      expect(
        run({ primary: [finding({ suggestion })] }).findings[0],
      ).toMatchObject({
        suggestion: null,
        suggestion_status: 'suppressed:unsafe_characters',
      });
    }
    // A tab is ordinary whitespace, and characters already in the replaced
    // code may be kept.
    expect(
      run({ primary: [finding({ suggestion: '\tcache.add(item.id, item);' })] })
        .findings[0]!.suggestion_status,
    ).toBe('kept');
    const zwsp = FILE.replace(
      'cache.set(item.id, item);\n  }\n}\n\nexport',
      'cache.set(item.id,\u200b item);\n  }\n}\n\nexport',
    );
    expect(
      run({
        source: zwsp,
        primary: [
          finding(
            { line: 6, suggestion: '    cache.add(item.id,\u200b item);' },
            zwsp,
          ),
        ],
      }).findings[0]!.suggestion_status,
    ).toBe('kept');
  });

  it('keeps CRLF suggestions on CRLF files and rejects stray carriage returns', () => {
    const crlf = FILE.replace(/\n/gu, '\r\n');
    const suggestion =
      '    cache.add(item.id, item);\r\n    cache.touch(item.id);';
    const onCrlf = (text: string) =>
      run({
        source: crlf,
        primary: [finding({ line: 3, suggestion: text }, crlf)],
      }).findings[0]!.suggestion_status;
    expect(onCrlf(suggestion)).toBe('kept');
    expect(onCrlf('    cache.add(item.id,\r item);')).toBe(
      'suppressed:unsafe_characters',
    );
    // On an LF file a CRLF suggestion still introduces a new character.
    expect(
      run({ primary: [finding({ suggestion })] }).findings[0]!
        .suggestion_status,
    ).toBe('suppressed:unsafe_characters');
  });

  it('compares original code line by line, keeping a blank last line', () => {
    // Lines 8-9 of the fixture are `}` and a blank line.
    const status = (overrides: FindingSpec) =>
      run({
        primary: [
          finding({ line: 8, end_line: 9, suggestion: '};\n', ...overrides }),
        ],
      }).findings[0]!.suggestion_status;
    expect(status({})).toBe('kept');
    expect(status({ original_code: '}\n\n' })).toBe('kept');
    expect(status({ original_code: '}\r\n' })).toBe('kept');
    expect(status({ original_code: '}' })).toBe(
      'suppressed:original_code_mismatch',
    );
  });

  it('never reports a review over a header-truncated diff as complete', () => {
    const cut = parseUnifiedDiff(
      'diff --git a/src/cache.ts b/src/cache.ts\nindex 1111111..2222222 100644\n--- a/src/cache.ts\n+++ b/src/cache.ts\n',
    );
    const gated = run({ diff: cut });
    expect(gated.diff_truncated).toBe(true);
    expect(gated.candidates[0]!.disposition).toBe(
      'invalid:anchor_outside_hunk',
    );
    const summary = renderSummary(gated);
    expect(summary).toContain('**Review:** **partial (diff truncated)**');
    expect(summary).toContain('The PR diff was truncated');
    expect(summary).not.toContain('**Review:** complete');
  });

  it('rejects untrusted policy and identity input', () => {
    expect(() => run({ policy: { budget: -1 } })).toThrow(
      expect.objectContaining({ code: 'E_REVIEW_REQUEST' }),
    );
    expect(() => run({ identity: { ...IDENTITY, pr_number: 0 } })).toThrow(
      expect.objectContaining({ code: 'E_REVIEW_INPUT' }),
    );
  });
});

describe('gate: check evidence (verify-review)', () => {
  const ID = `check-${'a'.repeat(24)}`;
  const checkFinding = finding({
    evidence: [{ kind: 'check', evidence_id: ID }],
  });

  it('refuses a check citation in review mode', () => {
    const gated = run({ primary: [checkFinding] });
    expect(dispositions(gated)['primary-a1-F1']).toBe(
      'invalid:evidence_check_unavailable',
    );
    expect(gated.checks).toBeUndefined();
  });

  it('refuses a check id that is not in the pass evidence and admits one that is', () => {
    const evidence = {
      version: 1 as const,
      repository: IDENTITY.repository,
      head_sha: HEAD,
      config_sha256: 'c'.repeat(64),
      status: 'complete' as const,
      setup: null,
      entries: [
        {
          evidence_id: ID,
          name: 'test',
          command: 'pnpm test',
          exit_code: 1,
          timed_out: false,
          truncated: false,
          output_sha256: 'd'.repeat(64),
          output_tail: 'FAIL',
          duration_ms: 1,
          isolation: 'none' as const,
        },
      ],
    };
    const verifyRun = (findings: unknown[]) =>
      gateReview({
        identity: IDENTITY,
        mode: 'verify-review',
        base_sha: BASE,
        merge_base_sha: MERGE,
        head_sha: HEAD,
        diff: diffFor(FILE),
        read: readerFor(FILE),
        passes: [
          {
            pass: 'primary',
            enabled: true,
            attempt: '1',
            review: { ...review('primary', findings), mode: 'verify-review' },
          },
        ],
        adjudication: { enabled: false, value: null },
        checks: { primary: evidence },
      });
    const admitted = verifyRun([checkFinding]);
    expect(validateGatedReview(admitted, IDENTITY)).toBe(admitted);
    expect(admitted.findings[0]?.evidence).toEqual([
      { kind: 'check', evidence_id: ID, name: 'test', exit_code: 1 },
    ]);
    expect(admitted.checks?.entries[0]).toEqual({
      name: 'test',
      evidence_id: ID,
      exit_code: 1,
      timed_out: false,
      isolation: 'none',
    });
    const forged = verifyRun([
      finding({
        evidence: [{ kind: 'check', evidence_id: `check-${'b'.repeat(24)}` }],
      }),
    ]);
    expect(dispositions(forged)['primary-a1-F1']).toBe(
      'invalid:evidence_unknown_check',
    );
    // A malformed id never reaches the lookup.
    const malformed = verifyRun([
      finding({
        evidence: [{ kind: 'check', evidence_id: 'primary-a1-chk-1' }],
      }),
    ]);
    expect(malformed.candidates[0]?.disposition).toBe(
      'invalid:schema:evidence.0',
    );
  });
});
