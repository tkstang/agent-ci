import {
  agentJob,
  load,
  secretRefs,
  step,
  modelChain,
} from '@agent-ci/workflows/testing/helpers.js';
import { describe, expect, it } from 'vitest';

describe('PR command workflow authority and transport', () => {
  it('passes one route-selected credential to the read-only agent boundary', async () => {
    const { jobs, on } = await load('.github/workflows/pr-agent.yml');
    expect(Object.keys(on)).toEqual(['workflow_call']);
    expect(jobs.agent?.uses).toBe('./.github/workflows/agent-job.yml');
    expect(jobs.agent?.permissions).toEqual({ contents: 'read' });
    expect(jobs.agent?.secrets?.AGENT_CI_CREDENTIAL).toBe(
      modelChain('needs.gate.outputs.credential'),
    );
    expect(JSON.stringify(jobs.agent)).not.toContain('AGENT_CI_PUBLISH_TOKEN');
    expect(jobs.agent?.with?.sha).toBe('${{ needs.gate.outputs.head_sha }}');
    const inner = await agentJob();
    for (const entry of inner.steps ?? []) {
      if (entry.uses?.startsWith('actions/checkout'))
        expect(entry.with?.['persist-credentials']).toBe(false);
    }
  });

  it('moves task context by exact artifact ID and binds every reader to its digest', async () => {
    const { jobs } = await load('.github/workflows/pr-agent.yml');
    expect(JSON.stringify(jobs.gate?.outputs)).not.toMatch(/prompt|context/u);
    expect(jobs.agent?.with?.pr_request_artifact_id).toBe(
      '${{ needs.gate.outputs.request_artifact_id }}',
    );
    expect(jobs.agent?.with?.pr_request_digest).toBe(
      '${{ needs.gate.outputs.request_digest }}',
    );
    for (const name of ['verify', 'publish']) {
      const job = jobs[name] ?? {};
      expect(step(job, 'Download the request').with?.['artifact-ids']).toBe(
        '${{ needs.gate.outputs.request_artifact_id }}',
      );
      expect(step(job, 'Download the result').with?.['artifact-ids']).toBe(
        '${{ needs.agent.outputs.result_artifact_id }}',
      );
      const command = step(
        job,
        name === 'verify'
          ? 'Materialize the resulting tree'
          : 'Publish the PR update',
      );
      expect(command.run).toContain('--request-digest "$REQUEST_DIGEST"');
      expect(command.run).toContain('--result-digest "$RESULT_DIGEST"');
    }
  });

  it('runs required final checks on a fresh hosted runner without model or write credentials', async () => {
    const { jobs, on } = await load('.github/workflows/pr-agent.yml');
    const inputs = (on.workflow_call as { inputs: Record<string, unknown> })
      .inputs;
    expect(inputs.check_command).toMatchObject({ required: true });
    const verify = jobs.verify ?? {};
    expect(verify['runs-on']).toBe('ubuntu-latest');
    expect(verify.permissions).toEqual({ contents: 'read' });
    expect(verify.secrets).toBeUndefined();
    for (const entry of verify.steps ?? [])
      expect(secretRefs(entry)).toEqual([]);
    expect(jobs.publish?.needs).toEqual(['gate', 'agent', 'verify']);
    const publish = step(jobs.publish ?? {}, 'Publish the PR update');
    expect(publish.env?.VERIFICATION).toBe('${{ needs.verify.result }}');
    expect(publish.run).toContain('--verification "$VERIFICATION"');
  });

  it('keeps publishing credentials out of every repository-executing job', async () => {
    const { jobs } = await load('.github/workflows/pr-agent.yml');
    for (const name of ['gate', 'setup', 'agent', 'verify']) {
      expect(JSON.stringify(jobs[name]), name).not.toContain(
        'secrets.AGENT_CI_PUBLISH_TOKEN',
      );
      for (const entry of jobs[name]?.steps ?? [])
        expect(secretRefs(entry), entry.name).toEqual([]);
    }
    expect(jobs.publish?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
  });

  it('provides comment and real-comment replay consumers without authority overrides', async () => {
    const consumer = await load('consumer-workflows/agent-ci-pr-command.yml');
    expect(consumer.on.issue_comment).toEqual({ types: ['created'] });
    const dispatch = consumer.on.workflow_dispatch as {
      inputs: Record<string, unknown>;
    };
    expect(Object.keys(dispatch.inputs)).toEqual(['comment_id']);
    const selftest = await load('.github/workflows/agent-ci-selftest.yml');
    expect(selftest.jobs['pr-command']?.uses).toBe(
      './.github/workflows/pr-agent.yml',
    );
    expect(selftest.jobs['pr-command']?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.comment_id != ''",
    );
    expect(selftest.jobs['pr-command']?.with?.comment_id).toBe(
      '${{ inputs.comment_id }}',
    );
  });
});
