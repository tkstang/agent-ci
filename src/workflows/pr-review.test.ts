import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PACKAGE_ROOT } from '@agent-ci/paths.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Structure tests for the PR review workflow, its self-test caller and the
 * consumer template. They pin the trust boundaries: which job holds which
 * token, where the model credential appears, which jobs check out pull
 * request code, and that commenter-controlled text never reaches a `run:`
 * script.
 */

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
}
interface Job {
  'runs-on'?: string;
  permissions?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown> | string;
  steps?: Step[];
  concurrency?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

async function load(relative: string): Promise<Workflow> {
  return parse(
    await readFile(path.join(PACKAGE_ROOT, relative), 'utf8'),
  ) as Workflow;
}
const review = () => load('.github/workflows/pr-review.yml');

const MODEL_SECRETS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENCODE_API_KEY',
  'CURSOR_API_KEY',
];
const CREDENTIAL_STEPS = new Set([
  'Run the primary reviewer',
  'Run the second reviewer',
  'Run the adjudicator',
]);
const TOKEN_STEPS = new Set([
  'Authorize the request',
  'Bind the review spec and diff',
  'Fetch the cited source',
  'Gate the findings',
  'Publish the review and summary',
]);

function steps(workflow: Workflow): [string, Step][] {
  return Object.entries(workflow.jobs).flatMap(([name, job]) =>
    (job.steps ?? []).map((step): [string, Step] => [name, step]),
  );
}

describe('pr-review.yml', () => {
  it('is a reusable workflow whose jobs run on the runs_on input', async () => {
    const workflow = await review();
    expect(Object.keys(workflow.on)).toEqual(['workflow_call']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual([
      'gate',
      'review-primary',
      'review-second',
      'adjudicate',
      'findings',
      'publish',
    ]);
    for (const job of Object.values(workflow.jobs))
      expect(job['runs-on']).toBe('${{ inputs.runs_on }}');
  });

  it('grants each job only the permissions its step needs', async () => {
    const { jobs } = await review();
    expect(jobs.gate?.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
    for (const name of ['review-primary', 'review-second', 'adjudicate'])
      expect(jobs[name]?.permissions).toEqual({ contents: 'read' });
    expect(jobs.findings?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(jobs.publish?.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
  });

  it('gives the model credential only to the reviewer and adjudicator steps, as one mapped secret', async () => {
    for (const [, step] of steps(await review())) {
      const text = JSON.stringify(step);
      const holds = text.includes('secrets[');
      expect(holds, step.name).toBe(CREDENTIAL_STEPS.has(step.name ?? ''));
      for (const secret of MODEL_SECRETS)
        expect(text, step.name).not.toContain(`secrets.${secret}`);
      if (holds) {
        expect(step.env?.AGENT_CI_CREDENTIAL).toBe(
          "${{ steps.route.outputs.credential != '' && secrets[steps.route.outputs.credential] || '' }}",
        );
        expect(step.run).toContain('--credential-from-env');
        // A step with the model credential never holds a GitHub token.
        expect(text).not.toContain('github.token');
      }
    }
  });

  it('passes a GitHub token only to the gate, spec, sources, findings and publish steps', async () => {
    for (const [, step] of steps(await review())) {
      const holds = step.env?.GITHUB_TOKEN !== undefined;
      expect(holds, step.name).toBe(TOKEN_STEPS.has(step.name ?? ''));
      if (holds) expect(step.env?.GITHUB_TOKEN).toBe('${{ github.token }}');
    }
  });

  it('checks out pull-request code only in the read-only reviewer jobs, without a persisted token', async () => {
    const workflow = await review();
    for (const [job, step] of steps(workflow)) {
      if (step.uses?.startsWith('actions/checkout') !== true) continue;
      if (step.with?.repository !== undefined) {
        // The agent-ci helpers, at this workflow's own commit.
        expect(step.with?.path).toBe('.agent-ci-src');
        expect(step.with?.ref).toBe(
          '${{ inputs.agent_ci_ref || job.workflow_sha }}',
        );
      } else {
        expect(['review-primary', 'review-second']).toContain(job);
        expect(step.with?.ref).toBe('${{ needs.gate.outputs.head_sha }}');
      }
      expect(step.with?.['persist-credentials']).toBe(false);
    }
  });

  it('never runs a setup command or installs skills for a review', async () => {
    const text = JSON.stringify(await review());
    expect(text).not.toContain('setup_command');
    expect(text).not.toContain('skills install');
    expect(text).not.toContain('--allow-pool');
    expect(text).not.toContain('--seed-login');
  });

  it('keeps every expression out of run scripts (inputs and outputs travel through env)', async () => {
    for (const [, step] of steps(await review()))
      if (step.run !== undefined)
        expect(step.run, step.name).not.toContain('${{');
  });

  it('wires every artifact by id and digest from the job that produced it', async () => {
    const { jobs } = await review();
    const text = JSON.stringify(jobs);
    for (const id of [
      'needs.gate.outputs.spec_artifact_id',
      'needs.review-primary.outputs.artifact_id',
      'needs.review-second.outputs.artifact_id',
      'needs.adjudicate.outputs.artifact_id',
      'needs.findings.outputs.artifact_id',
    ])
      expect(text).toContain(id);
    for (const [, step] of steps(await review()))
      if (step.uses?.startsWith('actions/download-artifact'))
        expect(step.with?.['artifact-ids'], step.name).toBeDefined();
    const findings = JSON.stringify(jobs.findings?.steps);
    expect(findings).toContain('--primary-digest');
    expect(findings).toContain('--adjudication-digest');
    expect(JSON.stringify(jobs.publish?.steps)).toContain('--gated-digest');
  });

  it('runs the stages after a skipped or failed pass, and publishes in one queue per PR and scope', async () => {
    const { jobs } = await review();
    for (const name of ['adjudicate', 'findings', 'publish'])
      expect(jobs[name]?.if).toContain('!cancelled()');
    expect(jobs.publish?.concurrency).toEqual({
      group:
        'agent-ci-pr-review-${{ github.repository }}-${{ needs.gate.outputs.pr_number }}-${{ inputs.artifact_scope }}',
      'cancel-in-progress': false,
    });
    // A spec or findings failure still reaches the publisher as a trusted code.
    const gateSteps = jobs.gate?.steps ?? [];
    expect(
      gateSteps.find((s) => s.id === 'prepare')?.['continue-on-error'],
    ).toBe(true);
    expect(
      (jobs.findings?.steps ?? []).find((s) => s.id === 'findings')?.[
        'continue-on-error'
      ],
    ).toBe(true);
  });
});

describe('agent-ci-review-selftest.yml', () => {
  it('runs pr-review.yml with the fake harness for same-repository labeled PRs only', async () => {
    const workflow = await load(
      '.github/workflows/agent-ci-review-selftest.yml',
    );
    expect(workflow.on).toEqual({ pull_request: { types: ['labeled'] } });
    const job = workflow.jobs.review ?? {};
    expect(job.uses).toBe('./.github/workflows/pr-review.yml');
    expect(job.if).toContain("github.event.label.name == 'agent-ci:review'");
    expect(job.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(job.with?.reviewer_model).toBe('fake-review');
    expect(job.with?.adjudicator_model).toBe('fake-adjudicate');
    expect(job.secrets).toBeUndefined();
  });
});

describe('consumer PR review template', () => {
  it('triggers from the default branch and passes explicit secrets to a pinned workflow', async () => {
    const workflow = await load('consumer-workflows/agent-ci-pr-review.yml');
    expect(Object.keys(workflow.on)).toEqual([
      'pull_request_target',
      'issue_comment',
      'workflow_dispatch',
    ]);
    expect(workflow.on.pull_request_target).toEqual({ types: ['labeled'] });
    expect(workflow.on.issue_comment).toEqual({ types: ['created'] });
    expect(JSON.stringify(workflow.on)).not.toContain('"pull_request"');
    const job = workflow.jobs.review ?? {};
    expect(job.uses).toMatch(
      /^tkstang\/agent-ci\/\.github\/workflows\/pr-review\.yml@/u,
    );
    expect(job.secrets).not.toBe('inherit');
    expect(Object.keys((job.secrets as Record<string, unknown>) ?? {})).toEqual(
      ['AGENT_CI_SOURCE_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENCODE_API_KEY'],
    );
    // The template itself has no steps: nothing runs outside the gate.
    expect(job.steps).toBeUndefined();
  });
});

describe('ci.yml', () => {
  it('lints the PR review consumer template', async () => {
    const workflow = await load('.github/workflows/ci.yml');
    expect(JSON.stringify(workflow.jobs.actionlint?.steps)).toContain(
      'consumer-workflows/agent-ci-pr-review.yml',
    );
  });
});
