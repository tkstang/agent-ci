import { finalizeRunResult } from '@agent-ci/contracts/finalize.js';
import { describe, expect, it } from 'vitest';

const config = {
  useCase: 'generic-prompt',
  targetRepo: 'tkstang/agent-ci',
  outputContract: 'report' as const,
  secrets: [],
};

describe('finalizeRunResult', () => {
  it('fills boilerplate and trusted identity over agent claims', () => {
    const result = finalizeRunResult(
      {
        useCase: 'agent-claimed',
        targetRepo: 'evil/repo',
        summary: 'Looked around.',
        report: { title: 'T', markdown: 'M' },
      },
      config,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      ok: true,
      status: 'no-op',
      useCase: 'generic-prompt',
      targetRepo: 'tkstang/agent-ci',
      artifacts: [],
      materializedArtifacts: [],
      changedFiles: [],
      errors: [],
      outputContract: 'report',
    });
  });

  it('derives changed status from detected workspace changes', () => {
    const result = finalizeRunResult(
      {
        summary: 's',
        changedFiles: ['b.ts'],
        report: { title: 'T', markdown: 'M' },
      },
      { ...config, detectedChangedFiles: ['a.ts', 'b.ts'] },
    );
    expect(result.ok && result.value.status).toBe('changed');
    expect(result.ok && result.value.changedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps an agent failure as failed', () => {
    const result = finalizeRunResult(
      { ok: false, status: 'failed', summary: 'could not' },
      config,
    );
    expect(result.ok && result.value.status).toBe('failed');
  });

  it('rejects output that copies a credential value', () => {
    const secret = 'synthetic-secret-value-0002';
    const result = finalizeRunResult(
      { summary: `leaked ${secret}`, report: { title: 'T', markdown: 'M' } },
      { ...config, secrets: [secret] },
    );
    expect(result).toMatchObject({ ok: false, code: 'E_SECRET_COPY' });
  });

  it('completes an omitted verdict envelope from the items', () => {
    const result = finalizeRunResult(
      {
        verdict: {
          items: [{ id: 'a', status: 'pass', summary: 's', evidence: ['f'] }],
        },
      },
      {
        ...config,
        outputContract: 'verdict',
        verdictItems: [{ id: 'a', description: 'd' }],
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.summary).toBe(
        'Verdict: 1 of 1 requested items passed (0 fail, 0 blocked).',
      );
  });

  it('rejects non-object candidates', () => {
    expect(finalizeRunResult(['x'], config)).toMatchObject({
      code: 'E_INVALID_RUN_RESULT',
    });
  });
});
