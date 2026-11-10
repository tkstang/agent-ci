import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agentJob,
  load,
  secretRefs,
  step,
  modelChain,
} from '@agent-ci/workflows/testing/helpers.js';
import { describe, expect, it } from 'vitest';

describe('PR command workflow authority and transport', () => {
  it('rejects a published single-parent fix that leaves the actual base outside its history', async () => {
    const selftest = await load('.github/workflows/agent-ci-selftest.yml');
    const assertion = step(
      selftest.jobs['pr-command-assert'] ?? {},
      'Assert published history',
    );
    expect(assertion.run).toBeTypeOf('string');
    expect(assertion.env?.BASE_SHA).toBe(
      '${{ needs.pr-command.outputs.base_sha }}',
    );
    expect(assertion.env?.ORIGINAL_HEAD_SHA).toBe(
      '${{ needs.pr-command.outputs.head_sha }}',
    );
    expect(assertion.env?.EXPECT_BASE_MERGED).toBe(
      "${{ inputs.command_model == 'grok-4.7' }}",
    );
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-ci-history-proof-'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
      )
        .toString()
        .trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(cwd, 'file.txt'), 'initial\n');
    git('add', '.');
    git('commit', '-qm', 'test: initial');
    git('checkout', '-qb', 'topic');
    writeFileSync(path.join(cwd, 'file.txt'), 'feature\n');
    git('commit', '-qam', 'test: feature');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    writeFileSync(path.join(cwd, 'file.txt'), 'base\n');
    git('commit', '-qam', 'test: base');
    const base = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', `${head}^{tree}`);
    const singleParent = git(
      'commit-tree',
      tree,
      '-p',
      head,
      '-m',
      'fix: incomplete ancestry',
    );
    const merged = git(
      'commit-tree',
      tree,
      '-p',
      head,
      '-p',
      base,
      '-m',
      'fix: preserve base ancestry',
    );
    const execute = (final: string, expectMerge = 'true') =>
      execFileSync(
        'bash',
        ['-eu', '-o', 'pipefail', '-c', assertion.run ?? ''],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            FINAL_SHA: final,
            ORIGINAL_HEAD_SHA: head,
            BASE_SHA: base,
            CHANGED: 'true',
            EXPECT_BASE_MERGED: expectMerge,
          },
        },
      );
    expect(() => execute(singleParent)).toThrow();
    expect(() => execute(merged)).not.toThrow();
    expect(() => execute(singleParent, 'false')).not.toThrow();
  });
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
