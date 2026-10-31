import {
  type GatedFinding,
  type GatedReview,
  validateGatedReview,
} from '@agent-ci/review/contracts.js';
import {
  ACTIONS_PUBLISHER,
  findingMarker,
  isSummaryComment,
  parsePostedMarkers,
  REJECTED_DETAIL_BYTES,
  REJECTED_HEADING,
  renderFindingBody,
  renderReview,
  renderSummary,
  scopeDigest,
  SUMMARY_MAX_CHARS,
  summaryMarker,
} from '@agent-ci/review/render.js';
import { describe, expect, it } from 'vitest';

// Publisher identities rather than a bot-only identity, harness-reported usage
// rather than price-table estimates, and code evidence only.

const IDENTITY = {
  repository: 'tkstang/app',
  workflow: 'agent-ci-pr-review',
  pr_number: 7,
  scope: 'default',
  run_id: '500',
  run_attempt: '1',
};
const BOT = ACTIONS_PUBLISHER;
const bot = (body: string) => ({
  body,
  user: { login: BOT.login, type: 'Bot' },
});
const hex = (character: string) => character.repeat(64);

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
    code: '    cache.set(item.id, item);',
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
    head_sha: '0123456789abcdef0123456789abcdef01234567',
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

describe('markers', () => {
  it('fixes the grammar and binds the scope to repository, workflow, PR and scope', () => {
    const marker = findingMarker(IDENTITY, {
      fingerprint: hex('1'),
      discriminator: hex('2'),
    });
    expect(marker).toMatch(
      new RegExp(
        `^<!-- agent-ci-pr-review:v1 scope=[0-9a-f]{64} fp=${hex('1')} occ=${hex('2')} -->$`,
        'u',
      ),
    );
    const scopes = new Set(
      [
        IDENTITY,
        { ...IDENTITY, pr_number: 8 },
        { ...IDENTITY, scope: 'nightly' },
        { ...IDENTITY, workflow: 'other.yml' },
        { ...IDENTITY, repository: 'tkstang/web' },
        { ...IDENTITY, run_id: '501', run_attempt: '2' },
      ].map(scopeDigest),
    );
    // The run id and attempt do not change the scope; the others do.
    expect(scopes.size).toBe(5);
  });

  it('round-trips markers from rendered bot comments', () => {
    const review = renderReview(
      gated({
        findings: [
          finding(),
          finding({ fingerprint: hex('3'), discriminator: hex('4') }),
        ],
      }),
    )!;
    expect(
      parsePostedMarkers(
        review.comments.map((c) => bot(c.body)),
        IDENTITY,
        BOT,
      ),
    ).toEqual([
      { fingerprint: hex('1'), discriminator: hex('2') },
      { fingerprint: hex('3'), discriminator: hex('4') },
    ]);
  });

  it('rejects spoofed markers', () => {
    const marker = findingMarker(IDENTITY, {
      fingerprint: hex('5'),
      discriminator: hex('6'),
    });
    const foreign = findingMarker(
      { ...IDENTITY, pr_number: 8 },
      { fingerprint: hex('7'), discriminator: hex('8') },
    );
    expect(
      parsePostedMarkers(
        [
          {
            body: `text\n\n${marker}`,
            user: { login: 'mallory', type: 'User' },
          },
          {
            body: `text\n\n${marker}`,
            user: { login: BOT.login, type: 'User' },
          },
          bot(`${marker}\n\nmore text after the marker`),
          bot(`text\n\n${foreign}`),
          bot(`text\n\n${marker.replace('-->', '--> ')}x`),
          null,
          { body: 42, user: { login: BOT.login, type: 'Bot' } },
        ],
        IDENTITY,
        BOT,
      ),
    ).toEqual([]);
    expect(() =>
      parsePostedMarkers([], IDENTITY, { login: 'mallory', type: 'Bot' }),
    ).toThrow(expect.objectContaining({ code: 'E_REVIEW_INPUT' }));
  });

  it('accepts user, EMU and app publisher identities and refuses malformed ones', () => {
    for (const ok of [
      { login: 'octocat', type: 'User' },
      { login: 'octocat_acme', type: 'User' },
      { login: 'app[bot]', type: 'Bot' },
    ] as const)
      expect(parsePostedMarkers([], IDENTITY, ok)).toEqual([]);
    for (const bad of [
      { login: 'app[bot]', type: 'User' },
      { login: 'octocat_acme', type: 'Bot' },
      { login: '_lead', type: 'User' },
      { login: 'a b', type: 'User' },
    ] as const)
      expect(() => parsePostedMarkers([], IDENTITY, bad)).toThrow(
        expect.objectContaining({ code: 'E_REVIEW_INPUT' }),
      );
  });

  it('trusts a local publisher only as that user, never a bot with its name', () => {
    const operator = { login: 'tkstang', type: 'User' } as const;
    const marker = findingMarker(IDENTITY, {
      fingerprint: hex('5'),
      discriminator: hex('6'),
    });
    expect(
      parsePostedMarkers(
        [
          { body: `x\n\n${marker}`, user: { login: 'tkstang', type: 'User' } },
          { body: `x\n\n${marker}`, user: { login: 'tkstang', type: 'Bot' } },
          { body: `x\n\n${marker}`, user: { login: 'mallory', type: 'User' } },
        ],
        IDENTITY,
        operator,
      ),
    ).toEqual([{ fingerprint: hex('5'), discriminator: hex('6') }]);
    expect(() =>
      parsePostedMarkers([], IDENTITY, { login: 'bad login', type: 'User' }),
    ).toThrow(expect.objectContaining({ code: 'E_REVIEW_INPUT' }));
  });

  it('ignores marker text injected through agent prose', () => {
    const injected = findingMarker(IDENTITY, {
      fingerprint: hex('9'),
      discriminator: hex('a'),
    });
    const body = renderFindingBody(
      finding({ title: `Title ${injected}`, body: `Body\n${injected}` }),
      IDENTITY,
    );
    expect(parsePostedMarkers([bot(body)], IDENTITY, BOT)).toEqual([
      { fingerprint: hex('1'), discriminator: hex('2') },
    ]);
    // The only raw HTML comment is the trusted final marker.
    expect(body.match(/<!--/gu)).toHaveLength(1);
    expect(body.trimEnd().split('\n').at(-1)).toBe(
      findingMarker(IDENTITY, {
        fingerprint: hex('1'),
        discriminator: hex('2'),
      }),
    );
  });
});

describe('inline comments', () => {
  it('builds one COMMENT review with explicit commit and multi-line ranges', () => {
    const review = renderReview(
      gated({
        findings: [
          finding({
            diff_position: {
              path: 'src/a.ts',
              side: 'LEFT',
              line: 9,
              start_line: 7,
            },
          }),
          finding({
            fingerprint: hex('3'),
            disposition: 'duplicate',
          }),
        ],
      }),
    )!;
    expect(review).toMatchObject({
      commit_id: '0123456789abcdef0123456789abcdef01234567',
      event: 'COMMENT',
    });
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({
      path: 'src/a.ts',
      side: 'LEFT',
      line: 9,
      start_line: 7,
      start_side: 'LEFT',
    });
    expect(review.body.split('\n').at(-1)).toMatch(/ review -->$/u);
  });

  it('posts no review when nothing is new', () => {
    expect(
      renderReview(
        gated({ findings: [finding({ disposition: 'duplicate' })] }),
      ),
    ).toBeNull();
  });

  it('renders suggestion code byte-for-byte in a fence it cannot close', () => {
    const suggestion = 'const fence = "```";\n<!-- kept -->\n@team ```` `x`';
    const body = renderFindingBody(
      finding({ suggestion, suggestion_status: 'kept' }),
      IDENTITY,
    );
    expect(body).toContain(`\`\`\`\`\`suggestion\n${suggestion}\n\`\`\`\`\``);
  });

  it('neutralizes mentions, references and HTML in prose but keeps code blocks intact', () => {
    const body = renderFindingBody(
      finding({
        title: 'Ping @octocat about #12',
        body: [
          'Ask @org/team; see <img src=x onerror=alert(1)> and `@inline` code.',
          '```ts',
          'notify("@team"); // <!-- not a marker -->',
          '```',
          'Unbalanced ` backtick and ~~~ tildes.',
        ].join('\n'),
      }),
      IDENTITY,
    );
    expect(body).not.toMatch(/(^|[^`])@(octocat|org)/u);
    expect(body).not.toContain('#12');
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
    // Agent info strings are dropped; the content is kept verbatim.
    expect(body).toContain(
      '```\nnotify("@team"); // <!-- not a marker -->\n```',
    );
    expect(body).toContain('` @inline `');
    expect(body).toContain('Unbalanced \\` backtick and \\~\\~\\~ tildes.');
  });

  it('neutralizes references, bare URLs, links and images in prose', () => {
    const body = renderFindingBody(
      finding({
        title: 'Regression from GH-123 and tkstang/web#45',
        body: 'See https://github.com/o/r/pull/9, www.example.com, [click](https://evil.example) and ![pixel](https://evil.example/p.png).',
      }),
      IDENTITY,
    );
    expect(body).not.toMatch(/GH-\d/u);
    expect(body).not.toContain('#45');
    expect(body).not.toContain('://');
    expect(body).not.toMatch(/www\./iu);
    // Every bracket from agent prose is escaped, so no link or image forms.
    expect(body).not.toMatch(/(^|[^\\])[[\]]/u);
    expect(body).toContain('\\[click\\]');
  });

  it.each(['```js', '~~~', '````'])(
    'keeps a title starting with %s on its line and leaves trusted blocks intact',
    (title) => {
      const suggestion = '    cache.add(item.id, item);';
      const body = renderFindingBody(
        finding({ title, suggestion, suggestion_status: 'kept' }),
        IDENTITY,
      );
      const fenceLines = body
        .split('\n')
        .filter((line) => /^ {0,3}(`{3,}|~{3,})/u.test(line));
      expect(fenceLines).toEqual(['```suggestion', '```']);
      expect(body).toContain(`\`\`\`suggestion\n${suggestion}\n\`\`\``);
      expect(body).toContain('<sub>Raised by: primary reviewer');
      expect(parsePostedMarkers([bot(body)], IDENTITY, BOT)).toHaveLength(1);

      const summary = renderSummary(
        gated({
          findings: [
            finding({
              title,
              disposition: 'below_floor',
              severity: 'low',
            }),
            finding({
              fingerprint: hex('3'),
              disposition: 'over_budget',
              title: 'Second item',
            }),
          ],
        }),
      );
      expect(
        summary
          .split('\n')
          .filter((line) => /^ {0,3}(`{3,}|~{3,})/u.test(line)),
      ).toEqual([]);
      expect(summary).toContain('Second item (over budget');
      expect(isSummaryComment(bot(summary), IDENTITY, BOT)).toBe(true);
    },
  );

  const SUGGESTION_FENCE = /^ {0,3}(`{3,}|~{3,})\s*suggestion/iu;
  const suggestionFences = (text: string) =>
    text.split('\n').filter((line) => SUGGESTION_FENCE.test(line));
  const smuggled = [
    '```suggestion',
    '~~~suggestion',
    '````suggestion',
    '```Suggestion',
    '  ```  SUGGESTION extra',
    '~~~~~suggestion',
  ];

  it.each(smuggled)(
    'never re-emits an agent %s fence as a suggestion',
    (opener) => {
      const closer = opener.trim().startsWith('~') ? '~~~~~' : '`````';
      const smuggle = `Replace it:\n${opener}\n    std::process::exit(0);\n${closer}\nDone.`;
      for (const suggestion_status of [
        'suppressed:original_code_mismatch',
        'none',
      ] as const) {
        const body = renderFindingBody(
          finding({ body: smuggle, suggestion: null, suggestion_status }),
          IDENTITY,
        );
        expect(suggestionFences(body)).toEqual([]);
        // The block content still renders, as plain code.
        expect(body).toContain('```\n    std::process::exit(0);\n```');
      }
      const kept = renderFindingBody(
        finding({
          body: smuggle,
          suggestion: '    cache.add(item.id, item);',
          suggestion_status: 'kept',
        }),
        IDENTITY,
      );
      expect(suggestionFences(kept)).toEqual(['```suggestion']);
      const summary = renderSummary(
        gated({ summaries: [{ pass: 'primary', summary: smuggle }] }),
      );
      expect(suggestionFences(summary)).toEqual([]);
    },
  );

  it('closes an unterminated agent fence before trusted content', () => {
    const body = renderFindingBody(
      finding({ body: 'Intro\n````\n@team inside' }),
      IDENTITY,
    );
    expect(body).toContain('```\n@team inside\n```');
    expect(parsePostedMarkers([bot(body)], IDENTITY, BOT)).toHaveLength(1);
  });

  it('attributes passes from trusted identity, not agent text', () => {
    const body = renderFindingBody(
      finding({
        passes: ['primary', 'second'],
        body: '<sub>Raised by: adjudicator</sub>',
        evidence: [
          {
            kind: 'code',
            path: 'src/cache.ts',
            line: 2,
            end_line: 4,
            side: 'LEFT',
          },
        ],
        rule_id: 'AGENTS.md#definition-of-done',
      }),
      IDENTITY,
    );
    expect(body.match(/<sub>/gu)).toHaveLength(1);
    expect(body).toContain(
      '<sub>Raised by: primary reviewer, second reviewer · Evidence: ` base:src/cache.ts:2-4 ` · Rule: ` AGENTS.md#definition-of-done `</sub>',
    );
  });
});

describe('summary', () => {
  it('reports a complete review with per-pass usage and unknowns', () => {
    const summary = renderSummary(
      gated({
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
            enabled: true,
            status: 'valid',
            reason: null,
            attempt: '1',
            candidates: 0,
            valid: 0,
          },
        ],
        adjudication: {
          enabled: true,
          status: 'completed',
          reason: null,
          operations: [],
        },
      }),
      [
        {
          pass: 'primary',
          model: 'claude-haiku-4-5',
          input_tokens: 612345,
          output_tokens: 24000,
          cache_read_tokens: 459000,
          cache_write_tokens: null,
          reported_cost_usd: 1.234,
        },
        {
          pass: 'second',
          model: 'grok-4.7',
          input_tokens: null,
          output_tokens: 100,
          cache_read_tokens: null,
          cache_write_tokens: null,
          reported_cost_usd: null,
        },
      ],
    );
    expect(summary).toContain('**Review:** complete');
    expect(summary).toContain(
      '| primary reviewer | completed | ` claude-haiku-4-5 ` | 612,345 | 24,000 | 459,000 | unknown | $1.2340 |',
    );
    expect(summary).toContain(
      '| second reviewer | completed | ` grok-4.7 ` | unknown | 100 | unknown | unknown | not reported |',
    );
    expect(summary).toContain(
      '| adjudicator | completed | unknown | unknown | unknown | unknown | unknown | not reported |',
    );
    expect(summary).not.toContain('[!WARNING]');
    expect(summary.split('\n').at(-1)).toBe(summaryMarker(IDENTITY));
    expect(isSummaryComment(bot(summary), IDENTITY, BOT)).toBe(true);
    expect(
      isSummaryComment(
        { ...bot(summary), user: { login: 'x', type: 'User' } },
        IDENTITY,
        BOT,
      ),
    ).toBe(false);
  });

  it('lists agent-ci pass notes as inert text', () => {
    const summary = renderSummary(gated(), [
      {
        pass: 'primary',
        model: 'claude-haiku-4-5',
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: null,
        cache_write_tokens: null,
        reported_cost_usd: null,
        notes: [
          'the reviewer prompt listed 120 of 300 changed files [x](https://e.example) @team',
        ],
      },
    ]);
    expect(summary).toContain('### Pass notes');
    expect(summary).toContain(
      '- **primary reviewer:** the reviewer prompt listed 120 of 300 changed files',
    );
    expect(summary).not.toContain('](https://');
    expect(summary).not.toContain('@team');
  });

  it('flags incomplete reviews, truncation, adjudicator failure and the failure policy', () => {
    const summary = renderSummary(
      gated({
        review_status: 'incomplete',
        diff_truncated: true,
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
            enabled: true,
            status: 'failed',
            reason: 'review output missing',
            attempt: '1',
            candidates: 0,
            valid: 0,
          },
        ],
        adjudication: {
          enabled: true,
          status: 'failed',
          reason: 'adjudication output missing',
          operations: [],
        },
        policy: { fail_on_severity: 'high', floor: 'medium', budget: 10 },
        fail_on_severity_triggered: true,
      }),
    );
    expect(summary).toContain('**Review:** **incomplete**');
    expect(summary).toContain(
      'Incomplete review: the second reviewer produced no valid output',
    );
    expect(summary).toContain('The PR diff was truncated');
    expect(summary).toContain('no findings were dropped or downgraded');
    expect(summary).toContain('A finding at or above ` high ` was reported');
    expect(summary).toContain('| second reviewer | failed | unknown |');
  });

  it('counts overflow, floor, open and not-reproduced findings without claiming fixes', () => {
    const summary = renderSummary(
      gated({
        policy: { fail_on_severity: null, floor: 'medium', budget: 1 },
        findings: [
          finding(),
          finding({
            fingerprint: hex('3'),
            disposition: 'duplicate',
            severity: 'critical',
          }),
          finding({
            fingerprint: hex('4'),
            disposition: 'over_budget',
            title: 'Over @budget',
          }),
          finding({
            fingerprint: hex('5'),
            disposition: 'below_floor',
            severity: 'low',
          }),
        ],
        not_reproduced: [
          { fingerprint: hex('6'), discriminator: hex('7') },
          { fingerprint: hex('8'), discriminator: hex('9') },
        ],
        candidates: [
          {
            candidate_id: 'primary-a1-X',
            pass: 'primary',
            local_id: 'X',
            severity: 'medium',
            fingerprint: null,
            disposition: 'dropped_by_adjudicator',
          },
          {
            candidate_id: 'primary-a1-#3',
            pass: 'primary',
            local_id: '#3',
            severity: null,
            fingerprint: null,
            disposition: 'invalid:schema:id',
          },
        ],
      }),
    );
    expect(summary).toContain('| high | 2 | 1 | 0 |');
    expect(summary).toContain('| critical | 1 | 0 | 1 |');
    expect(summary).toContain('**Still open:** 2 findings');
    expect(summary).toContain(
      '**Not reproduced this run:** 2 previously posted findings were not reported by this run. That does not establish that they were fixed.',
    );
    expect(summary).toContain(
      '**Over the comment budget:** 1 (limit 1 inline comments per run)',
    );
    expect(summary).toContain('floor:** 1 (summary only)');
    expect(summary).toContain(
      '**Dropped by the adjudicator:** 1. **Rejected by validation:** 1.',
    );
    expect(summary).toContain(
      'Over ＠budget (over budget; raised by primary reviewer)',
    );
    expect(summary).not.toMatch(/\bresolved\b/iu);
  });
});

const heavy = (n: number) => '&'.repeat(n);

describe('summary size budget', () => {
  const many = (
    count: number,
    disposition: GatedFinding['disposition'],
    text: (i: number) => { title: string; body: string },
  ) =>
    Array.from({ length: count }, (_, i) =>
      finding({
        fingerprint:
          (disposition === 'posted' ? 'a' : 'b') +
          i.toString(16).padStart(63, '0'),
        candidate_ids: [`primary-a1-${disposition}${i}`],
        severity: 'medium',
        disposition,
        diff_position: {
          path: 'src/cache.ts',
          side: 'RIGHT',
          line: i + 1,
          start_line: null,
        },
        ...text(i),
      }),
    );

  it('lists every rejected inline finding up to the 100-comment maximum, explanations within their budget', () => {
    const review = gated({
      policy: { fail_on_severity: null, floor: 'medium', budget: 100 },
      findings: many(100, 'posted', (i) => ({
        title: `Rejected finding ${i}`,
        body: `Explanation ${i}. ${'word '.repeat(150)}`,
      })),
    });
    const summary = renderSummary(review, [], { inlineRejected: true });
    expect(summary).toContain(`### ${REJECTED_HEADING}`);
    for (let i = 0; i < 100; i += 1)
      expect(summary).toContain(
        `Rejected finding ${i} (inline review rejected`,
      );
    expect(summary).not.toContain('…and');
    const explained = summary.match(/<summary>Explanation<\/summary>/gu) ?? [];
    expect(explained.length).toBeGreaterThan(0);
    expect(explained.length).toBeLessThan(100);
    expect(
      explained.length *
        Buffer.byteLength(`Explanation 0. ${'word '.repeat(150)}`),
    ).toBeLessThanOrEqual(REJECTED_DETAIL_BYTES);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("always fits GitHub's comment limit with adversarial text, and says what it left out", () => {
    const review = gated({
      policy: { fail_on_severity: null, floor: 'medium', budget: 100 },
      findings: [
        ...many(100, 'posted', () => ({
          title: heavy(200),
          body: heavy(4000),
        })),
        ...many(100, 'below_floor', () => ({
          title: heavy(200),
          body: heavy(4000),
        })),
      ],
      summaries: [
        { pass: 'primary', summary: heavy(4000) },
        { pass: 'second', summary: heavy(4000) },
      ],
    });
    for (const inlineRejected of [false, true]) {
      const summary = renderSummary(review, [], { inlineRejected });
      expect(summary.length, String(inlineRejected)).toBeLessThanOrEqual(
        SUMMARY_MAX_CHARS,
      );
      expect(summary.length).toBeLessThan(65_536);
      expect(summary).toContain('**Mode:**');
      expect(summary).toMatch(
        /This summary was shortened to fit GitHub's comment size limit: \d+ more entries are in this run's gated review artifact\./u,
      );
      expect(summary.split('\n').at(-1)).toBe(summaryMarker(IDENTITY));
    }
  });
});
