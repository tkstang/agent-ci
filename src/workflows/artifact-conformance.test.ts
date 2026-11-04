import { load, secretRefs } from '@agent-ci/workflows/testing/helpers.js';
import { describe, expect, it } from 'vitest';

const ENTRY = '.github/workflows/agent-ci-artifact-conformance.yml';
const NESTED = '.github/workflows/agent-ci-artifact-conformance-nested.yml';
const LEAF = '.github/workflows/agent-ci-artifact-conformance-leaf.yml';

describe('synthetic artifact identity probe trust boundary', () => {
  it('requires manual dispatch rather than running OIDC probes on PR or push events', async () => {
    const entry = await load(ENTRY);
    expect(Object.keys(entry.on)).toEqual(['workflow_dispatch']);
    for (const filename of [NESTED, LEAF]) {
      expect(Object.keys((await load(filename)).on)).toEqual(['workflow_call']);
    }
  });

  it('passes no secrets and grants no repository writes anywhere in the call graph', async () => {
    for (const filename of [ENTRY, NESTED, LEAF]) {
      const workflow = await load(filename);
      expect(secretRefs(workflow)).toEqual([]);
      expect(workflow.permissions).toEqual({ contents: 'read' });
      for (const job of Object.values(workflow.jobs)) {
        expect(job.secrets).toBeUndefined();
        for (const [permission, level] of Object.entries(
          job.permissions ?? {},
        )) {
          expect(['contents', 'id-token']).toContain(permission);
          expect(level).toBe(permission === 'id-token' ? 'write' : 'read');
        }
      }
    }
  });

  it('delegates through local reusable workflows without executable caller hooks', async () => {
    const entry = await load(ENTRY);
    const nested = await load(NESTED);
    for (const job of Object.values(entry.jobs)) {
      expect(job.uses).toBe(`./${NESTED}`);
      expect(job.steps).toBeUndefined();
      expect(job.permissions?.['id-token']).toBe('write');
    }
    for (const job of Object.values(nested.jobs)) {
      expect(job.uses).toBe(`./${LEAF}`);
      expect(job.steps).toBeUndefined();
      expect(job.permissions?.['id-token']).toBe('write');
    }
  });
});
