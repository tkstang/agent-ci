import {
  buildFailedRunResult,
  parseVerdictItems,
  validateRunResult,
} from '@agent-ci/contracts/run-result.js';
import { describe, expect, it } from 'vitest';

const base = {
  ok: true,
  status: 'no-op',
  useCase: 'generic-prompt',
  targetRepo: 'tkstang/agent-ci',
  summary: 'done',
  artifacts: [],
  materializedArtifacts: [],
  changedFiles: [],
  errors: [],
};

describe('validateRunResult', () => {
  it('accepts a report result and tags the contract', () => {
    const result = validateRunResult({
      ...base,
      report: { title: 'T', markdown: 'M' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outputContract).toBe('report');
  });

  it('preserves unknown fields', () => {
    const result = validateRunResult(
      { ...base, extra: { nested: 1 } },
      { outputContract: 'changes' },
    );
    expect(result.ok && result.value.extra).toEqual({ nested: 1 });
  });

  it('names every invalid envelope field', () => {
    const result = validateRunResult(
      { ...base, ok: 'yes', summary: '  ' },
      { outputContract: 'changes' },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'E_INVALID_RUN_RESULT',
      message: 'run result has invalid fields: ok, summary',
    });
  });

  it('rejects a malformed report unless the run failed', () => {
    expect(
      validateRunResult(
        { ...base, report: { title: '' } },
        { outputContract: 'report' },
      ).ok,
    ).toBe(false);
    expect(
      validateRunResult(
        { ...base, ok: false, status: 'failed' },
        { outputContract: 'report' },
      ).ok,
    ).toBe(true);
  });

  it('validates issues', () => {
    const issue = { title: 't', body: 'b', labels: ['x'], dedupeKey: 'k' };
    expect(validateRunResult({ ...base, issues: [issue] }).ok).toBe(true);
    expect(
      validateRunResult({ ...base, issues: [{ ...issue, labels: 'x' }] }).ok,
    ).toBe(false);
  });

  it('rejects unknown contracts and non-objects', () => {
    expect(validateRunResult(base, { outputContract: 'poem' })).toMatchObject({
      message: 'unknown output contract',
    });
    expect(
      validateRunResult('text', { outputContract: 'report' }),
    ).toMatchObject({ message: 'run result must be an object' });
  });

  it('requires directory artifact counts', () => {
    const artifact = {
      label: 'l',
      originalPath: 'a',
      artifactPath: 'b',
      kind: 'directory',
    };
    expect(
      validateRunResult(
        { ...base, materializedArtifacts: [artifact] },
        { outputContract: 'changes' },
      ).ok,
    ).toBe(false);
    expect(
      validateRunResult(
        {
          ...base,
          materializedArtifacts: [{ ...artifact, entryCount: 1, byteCount: 2 }],
        },
        { outputContract: 'changes' },
      ).ok,
    ).toBe(true);
  });
});

describe('verdict contract', () => {
  const verdictItems = [{ id: 'a', description: 'A works' }];

  it('accepts a passing verdict with evidence', () => {
    const result = validateRunResult(
      {
        ...base,
        verdict: {
          items: [{ id: 'a', status: 'pass', summary: 'ok', evidence: ['f'] }],
        },
      },
      { outputContract: 'verdict', verdictItems },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects contradictory status, missing evidence and unknown ids', () => {
    const run = (items: unknown[], overrides = {}) =>
      validateRunResult(
        { ...base, ...overrides, verdict: { items } },
        { outputContract: 'verdict', verdictItems },
      );
    expect(
      run([{ id: 'a', status: 'fail', summary: 's', evidence: ['f'] }]),
    ).toMatchObject({ message: 'contradictory verdict status' });
    expect(
      run([{ id: 'a', status: 'pass', summary: 's', evidence: [] }]),
    ).toMatchObject({ message: 'invalid scored verdict item' });
    expect(
      run([{ id: 'b', status: 'pass', summary: 's', evidence: ['f'] }]),
    ).toMatchObject({ message: 'invalid scored verdict item' });
    expect(run([])).toMatchObject({
      message: 'requested verdict item missing',
    });
  });

  it('parses trusted verdict items from JSON text and rejects duplicates', () => {
    expect(parseVerdictItems(JSON.stringify(verdictItems))).toEqual({
      ok: true,
      value: verdictItems,
    });
    expect(parseVerdictItems([...verdictItems, ...verdictItems]).ok).toBe(
      false,
    );
    expect(parseVerdictItems('{bad').ok).toBe(false);
  });
});

describe('buildFailedRunResult', () => {
  it('builds a valid failed result for every contract', () => {
    for (const outputContract of [
      'report',
      'changes',
      'issues',
      'verdict',
    ] as const) {
      const failed = buildFailedRunResult({
        outputContract,
        verdictItems: [{ id: 'a', description: 'd' }],
        code: 'E_HARNESS_TIMEOUT',
        message: 'took too long',
      });
      expect(failed.errors).toEqual(['E_HARNESS_TIMEOUT: took too long']);
      expect(
        validateRunResult(failed, {
          outputContract,
          verdictItems: [{ id: 'a', description: 'd' }],
        }).ok,
      ).toBe(true);
    }
  });
});
