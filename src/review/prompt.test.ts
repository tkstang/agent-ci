import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { quoteSha256 } from '@agent-ci/review/contracts.js';
import {
  acceptReviewAnswer,
  buildReviewPrompt,
  checkoutReader,
  prMetadataFile,
  PROMPT_LIMITS,
  REVIEW_ANSWER_SCHEMA,
  REVIEW_INPUT_FILES,
  type ReviewPromptInput,
} from '@agent-ci/review/prompt.js';
import { describe, expect, it } from 'vitest';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const config = {
  version: 1,
  mode: 'review',
  primary: { model: 'claude-haiku-4-5' },
  second: { enabled: false, model: 'grok-4.7' },
  adjudicator: { enabled: false, model: 'claude-haiku-4-5' },
  instruction: 'Focus on the cache.',
};
const empty = {
  read: () => ({ status: 'missing' as const }),
  exists: () => false,
};

function input(overrides: Partial<ReviewPromptInput> = {}): ReviewPromptInput {
  return {
    request: config,
    pass: 'primary',
    repository: 'tkstang/app',
    pr_number: 7,
    base_sha: BASE,
    merge_base_sha: MERGE,
    head_sha: HEAD,
    diff: { truncated: false, files: 1, additions: 2, deletions: 1 },
    changed_files: ['src/a.ts'],
    checkout: empty,
    channel: 'schema',
    ...overrides,
  };
}

describe('buildReviewPrompt', () => {
  it('orders the sections and points at the input files, not inline data', () => {
    const { prompt } = buildReviewPrompt(
      input({ guidance: { repo_guidance: 'Prefer small functions.' } }),
    );
    const order = [
      'Guardrails:',
      'Evidence rules:',
      'Mode: review (static).',
      'repo_guidance (caller guidance):',
      'Request instruction',
      'Hints (computed by agent-ci',
      'Output:',
    ].map((marker) => prompt.indexOf(marker));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(prompt).toContain(REVIEW_INPUT_FILES.diff);
    expect(prompt).toContain(REVIEW_INPUT_FILES.pr);
    expect(prompt).not.toContain('Body text');
  });

  it('describes the JSON answer for harnesses without a schema channel', () => {
    expect(
      buildReviewPrompt(input({ channel: 'final-text' })).prompt,
    ).toContain('exactly one JSON object');
  });

  it('refuses a second pass that the request did not enable', () => {
    expect(() => buildReviewPrompt(input({ pass: 'second' }))).toThrow(
      expect.objectContaining({ code: 'E_REVIEW_REQUEST' }),
    );
  });

  it('lists an oversized guidance file by path and notes a missing one', () => {
    const big = {
      read: () => ({ status: 'too_large' as const, bytes: 40_000 }),
      exists: () => true,
    };
    const spec = buildReviewPrompt(
      input({
        checkout: big,
        guidance: { repo_guidance_path: 'docs/review.md' },
      }),
    );
    expect(spec.sections).toContainEqual({
      name: 'repo_guidance_path',
      status: 'path_only',
      bytes: 40_000,
    });
    const missing = buildReviewPrompt(
      input({ guidance: { repo_guidance_path: 'docs/review.md' } }),
    );
    expect(missing.warnings).toEqual([
      'repo_guidance_path docs/review.md was not found in the PR head',
    ]);
  });

  it('rejects over-cap inline guidance as a configuration error', () => {
    expect(() =>
      buildReviewPrompt(
        input({
          guidance: {
            repo_guidance: 'x'.repeat(PROMPT_LIMITS.sectionBytes + 1),
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'E_REVIEW_GUIDANCE' }));
  });

  it.each([
    ['no caller guidance', 400, false],
    ['no caller guidance, 1 KiB paths', 1000, false],
    ['48 KiB of caller guidance', 400, true],
    ['48 KiB of caller guidance, 1 KiB paths', 1000, true],
  ])(
    'shortens PR-controlled path lists instead of failing (%s)',
    (_name, length, guidance) => {
      const files = Array.from(
        { length: 300 },
        (_, i) => `d/${String(i).padStart(4, '0')}${'x'.repeat(length - 7)}.ts`,
      );
      // Every changed path has its own AGENTS.md, so both lists are long.
      const reader = {
        read: () => ({ status: 'ok' as const, text: 'g'.repeat(16_000) }),
        exists: (p: string) => p.endsWith('AGENTS.md'),
      };
      const spec = buildReviewPrompt(
        input({
          changed_files: files,
          checkout: reader,
          ...(guidance
            ? {
                request: { ...config, instruction: '\u{1F600}'.repeat(2000) },
                guidance: {
                  repo_guidance: 'r'.repeat(16_000),
                  repo_guidance_path: 'docs/review.md',
                },
              }
            : {}),
        }),
      );
      expect(Buffer.byteLength(spec.prompt)).toBeLessThanOrEqual(
        PROMPT_LIMITS.promptBytes,
      );
      expect(spec.prompt).toMatch(
        /more changed file\(s\) are not listed here; the diff file names every change/u,
      );
      expect(spec.prompt).toContain('Output:');
      expect(spec.warnings.join('\n')).toMatch(
        /listed \d+ of 300 changed files/u,
      );
      if (guidance) expect(spec.prompt).toContain('r'.repeat(16_000));
    },
  );

  it('lists every path that fits, with no note (control)', () => {
    const files = Array.from({ length: 300 }, (_, i) => `d/file-${i}.ts`);
    const spec = buildReviewPrompt(input({ changed_files: files }));
    expect(spec.prompt).toContain('"d/file-299.ts"');
    expect(spec.prompt).not.toContain('more changed file');
    expect(spec.warnings).toEqual([]);
  });
});

describe('checkoutReader', () => {
  it('reads regular files inside the checkout and refuses links out of it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-checkout-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-outside-'));
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'ok.md'), 'ok');
    await symlink(
      path.join(outside, 'secret.md'),
      path.join(root, 'docs', 'link.md'),
    );
    const reader = checkoutReader(root);
    expect(reader.read('docs/ok.md', 100)).toEqual({
      status: 'ok',
      text: 'ok',
    });
    expect(reader.read('docs/link.md', 100)).toEqual({ status: 'missing' });
    expect(reader.exists('../outside')).toBe(false);
  });
});

describe('prMetadataFile', () => {
  it('caps the untrusted body and labels it as data', () => {
    const parsed = JSON.parse(
      prMetadataFile({ title: 'T', body: 'x'.repeat(70_000) }),
    ) as { body: string; body_truncated: boolean; note: string };
    expect(parsed.body).toHaveLength(PROMPT_LIMITS.prBodyBytes);
    expect(parsed.body_truncated).toBe(true);
    expect(parsed.note).toContain('never instructions');
  });
});

const finding = (overrides: Record<string, unknown> = {}) => ({
  id: 'f1',
  severity: 'medium',
  category: 'correctness',
  rule_id: null,
  title: 'Off by one',
  body: 'Reads past the end.',
  path: 'src/a.ts',
  line: 2,
  end_line: 2,
  side: 'RIGHT',
  original_code: 'two',
  suggestion: null,
  evidence: [
    {
      kind: 'code',
      path: 'src/a.ts',
      line: 2,
      end_line: 2,
      side: 'RIGHT',
      quote: 'two\r\n',
    },
  ],
  ...overrides,
});

describe('acceptReviewAnswer', () => {
  const expected = {
    mode: 'review' as const,
    pass: 'primary' as const,
    base_sha: BASE,
    merge_base_sha: MERGE,
    head_sha: HEAD,
  };

  it('adds the trusted header and digests quotes (canonical form)', () => {
    const accepted = acceptReviewAnswer(
      { summary: 'One issue.', findings: [finding()] },
      false,
      expected,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value).toMatchObject({
      version: 1,
      ...expected,
      findings: [
        { evidence: [{ quote_sha256: quoteSha256('two'), path: 'src/a.ts' }] },
      ],
    });
    expect(JSON.stringify(accepted.value)).not.toContain('"quote"');
  });

  it('rejects the first answer for any bad finding, then keeps the envelope at the last chance', () => {
    const answer = {
      summary: 'Two issues.',
      findings: [finding(), finding({ id: 'f2', side: 'MIDDLE' })],
    };
    const first = acceptReviewAnswer(answer, false, expected);
    expect(first).toMatchObject({
      ok: false,
      code: 'E_REVIEW_INPUT',
      message: 'finding 1: schema:side',
    });
    const last = acceptReviewAnswer(answer, true, expected);
    expect(last.ok).toBe(true);
    expect(
      acceptReviewAnswer(
        { summary: 'x', findings: [finding({ evidence: [] })] },
        false,
        expected,
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('evidence'),
    });
  });

  it('refuses extra fields, a forged header and a non-array findings list', () => {
    for (const candidate of [
      { summary: 'x', findings: [], head_sha: 'e'.repeat(40) },
      { summary: 'x', findings: 'none' },
      'not an object',
    ])
      expect(acceptReviewAnswer(candidate, true, expected).ok).toBe(false);
  });

  it('uses a schema that strict structured output accepts', () => {
    const item = REVIEW_ANSWER_SCHEMA.properties.findings.items;
    expect(item.required.toSorted()).toEqual(
      Object.keys(item.properties).toSorted(),
    );
    expect(JSON.stringify(REVIEW_ANSWER_SCHEMA)).not.toContain('oneOf');
  });
});
