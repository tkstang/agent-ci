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
  outputs?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

async function load(relative: string): Promise<Workflow> {
  return parse(
    await readFile(path.join(PACKAGE_ROOT, relative), 'utf8'),
  ) as Workflow;
}
const review = () => load('.github/workflows/pr-review.yml');
const reviewPass = () => load('.github/workflows/review-pass.yml');
const adjudicate = () => load('.github/workflows/review-adjudicate.yml');
const reviewWorkflows = () =>
  Promise.all([review(), reviewPass(), adjudicate()]);

const MODEL_SECRETS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENCODE_API_KEY',
  'CURSOR_API_KEY',
  'AGENT_CI_PROXY_API_KEY',
];
const CREDENTIAL_STEPS = new Set(['Run the reviewer', 'Run the adjudicator']);
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
      'verify',
      'review-primary',
      'review-second',
      'adjudicate',
      'findings',
      'publish',
    ]);
    for (const entry of await reviewWorkflows()) {
      for (const job of Object.values(entry.jobs)) {
        if (job.uses !== undefined) {
          expect(job.with?.runs_on).toBe('${{ inputs.runs_on }}');
          expect(job['runs-on']).toBeUndefined();
        } else {
          expect(job['runs-on']).toBe(
            "${{ startsWith(inputs.runs_on, '[') && fromJSON(inputs.runs_on) || inputs.runs_on }}",
          );
        }
      }
    }
  });

  it('revalidates adjudicator purpose and installs only the selected harness transport', async () => {
    const workflow = await adjudicate();
    const job = workflow.jobs.adjudicate;
    expect(job?.steps?.find((step) => step.id === 'route')?.run).toContain(
      'agent-ci route --purpose adjudicator',
    );
    expect(
      job?.steps?.find((step) => step.name === 'Install the harness')?.if,
    ).toBe("steps.route.outputs.transport == 'harness'");
    const ordinary = await reviewPass();
    expect(
      ordinary.jobs.review?.steps?.find(
        (step) => step.name === 'Install the harness',
      )?.if,
    ).toBeUndefined();
  });

  it('forwards private output mode to every reviewer and adjudicator child', async () => {
    for (const workflow of await reviewWorkflows()) {
      const inputs = (
        workflow.on.workflow_call as {
          inputs: Record<string, unknown>;
        }
      ).inputs;
      expect(inputs.private_target).toMatchObject({
        type: 'boolean',
        default: false,
      });
      expect(workflow.env?.AGENT_CI_PRIVATE_TARGET).toBe(
        '${{ inputs.private_target }}',
      );
      for (const job of Object.values(workflow.jobs)) {
        if (job.uses === undefined) continue;
        expect(job.with?.private_target).toBe('${{ inputs.private_target }}');
      }
    }
  });

  it('defaults to Sol High with optional Opus High and Sol Low adjudication', async () => {
    const workflow = await review();
    const { inputs } = workflow.on.workflow_call as {
      inputs: Record<string, { default?: unknown }>;
    };
    expect(inputs.reviewer_model?.default).toBe('gpt-6.1-sol-high');
    expect(inputs.second_reviewer_model?.default).toBe('claude-opus-5-5-high');
    expect(inputs.adjudicator_model?.default).toBe('gpt-6.1-sol-low');
    expect(inputs.second_reviewer?.default).toBe(false);
    expect(inputs.adjudicator?.default).toBe(false);
    expect(inputs.allow_pool?.default).toBe(false);
    expect(inputs.runs_on?.default).toBe('ubuntu-latest');
    const allowed = String(inputs.allowed_models?.default).trim().split(/\s+/u);
    expect(allowed).toEqual([
      'gpt-6.1-sol-high',
      'claude-opus-5-5-high',
      'gpt-6.1-sol-low',
    ]);
  });

  it('grants each job only the permissions its step needs', async () => {
    const { jobs } = await review();
    expect(jobs.gate?.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
    for (const name of [
      'verify',
      'review-primary',
      'review-second',
      'adjudicate',
    ])
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

  it('selects one credential and a pool-only origin at each child workflow boundary', async () => {
    const workflow = await review();
    for (const [name, role, child] of [
      ['review-primary', 'primary', 'review-pass'],
      ['review-second', 'second', 'review-pass'],
      ['adjudicate', 'adjudicator', 'review-adjudicate'],
    ] as const) {
      const job = workflow.jobs[name];
      expect(job?.uses).toBe(`./.github/workflows/${child}.yml`);
      expect(job?.steps).toBeUndefined();
      expect(job?.with?.route_id).toBe(
        `\${{ needs.gate.outputs.${role}_route_id }}`,
      );
      const chain = `\${{ ${MODEL_SECRETS.map(
        (secret) =>
          `(needs.gate.outputs.${role}_credential == '${secret}' && secrets.${secret})`,
      ).join(' || ')} || '' }}`;
      expect(job?.secrets).toEqual({
        AGENT_CI_CREDENTIAL: chain,
        AGENT_CI_PROXY_BASE_URL: `\${{ needs.gate.outputs.${role}_account == 'pool' && secrets.AGENT_CI_PROXY_BASE_URL || '' }}`,
      });
      for (const key of ['route_id', 'credential', 'account']) {
        expect(workflow.jobs.gate?.outputs?.[`${role}_${key}`]).toBe(
          `\${{ steps.route-${role}.outputs.${key} }}`,
        );
      }
      const route = workflow.jobs.gate?.steps?.find(
        (entry) => entry.id === `route-${role}`,
      );
      expect(route?.if).toContain("steps.spec-upload.outcome == 'success'");
      if (role !== 'primary')
        expect(route?.if).toContain(
          `steps.gate.outputs.${role === 'second' ? 'second' : 'adjudicator'}_enabled == 'true'`,
        );
      expect(route?.env?.MODEL).toBe(
        `\${{ steps.gate.outputs.${role === 'primary' ? 'reviewer_model' : role === 'second' ? 'second_reviewer_model' : 'adjudicator_model'} }}`,
      );
      expect(route?.run).toContain(
        role === 'adjudicator'
          ? 'agent-ci route --purpose adjudicator --model "$MODEL"'
          : 'agent-ci route --model "$MODEL"',
      );
    }
    for (const [, step] of steps(workflow)) {
      const text = JSON.stringify(step);
      for (const secret of MODEL_SECRETS)
        expect(text, step.name).not.toContain(`secrets.${secret}`);
      expect(text, step.name).not.toContain('secrets.AGENT_CI_PROXY_BASE_URL');
    }
    for (const child of [await reviewPass(), await adjudicate()]) {
      const call = child.on.workflow_call as {
        secrets: Record<string, unknown>;
        outputs: Record<string, { value: string }>;
      };
      expect(Object.keys(call.secrets)).toEqual([
        'AGENT_CI_CREDENTIAL',
        'AGENT_CI_PROXY_BASE_URL',
      ]);
      const [jobName, job] = Object.entries(child.jobs)[0] ?? [];
      expect(call.outputs.artifact_id?.value).toBe(
        `\${{ jobs.${jobName}.outputs.artifact_id }}`,
      );
      expect(call.outputs.digest?.value).toBe(
        `\${{ jobs.${jobName}.outputs.digest }}`,
      );
      expect(job?.outputs).toEqual({
        artifact_id: '${{ steps.upload.outputs.artifact-id }}',
        digest: '${{ steps.digest.outputs.digest }}',
      });
      for (const [, step] of steps(child)) {
        const text = JSON.stringify(step);
        expect(text, step.name).not.toContain('secrets[');
        const holds = text.includes('secrets.AGENT_CI_CREDENTIAL');
        expect(
          text.includes('secrets.AGENT_CI_PROXY_BASE_URL'),
          step.name,
        ).toBe(CREDENTIAL_STEPS.has(step.name ?? ''));
        expect(holds, step.name).toBe(CREDENTIAL_STEPS.has(step.name ?? ''));
        if (holds) {
          expect(step.env?.AGENT_CI_CREDENTIAL).toBe(
            '${{ secrets.AGENT_CI_CREDENTIAL }}',
          );
          expect(step.env?.AGENT_CI_PROXY_BASE_URL).toBe(
            '${{ secrets.AGENT_CI_PROXY_BASE_URL }}',
          );
          expect(step.run).toContain('--credential-from-env');
          expect(text).not.toContain('github.token');
        }
      }
      const route = job?.steps?.find((entry) => entry.id === 'route');
      expect(route?.env?.ROUTE).toBe('${{ inputs.route_id }}');
      expect(route?.run).toContain(
        child.jobs.adjudicate !== undefined
          ? 'agent-ci route --purpose adjudicator --route "$ROUTE"'
          : 'agent-ci route --route "$ROUTE"',
      );
      expect(job?.steps?.find((entry) => entry.id === 'present')?.if).toBe(
        'always()',
      );
      expect(job?.steps?.find((entry) => entry.id === 'digest')?.if).toBe(
        "always() && steps.present.outputs.present == 'true'",
      );
      expect(
        job?.steps?.find((entry) => entry.id === 'upload')?.with,
      ).toMatchObject({ 'retention-days': 7, 'if-no-files-found': 'error' });
    }
  });

  it('passes a GitHub token only to the gate, spec, sources, findings and publish steps', async () => {
    for (const [, step] of (await reviewWorkflows()).flatMap(steps)) {
      const holds = step.env?.GITHUB_TOKEN !== undefined;
      expect(holds, step.name).toBe(TOKEN_STEPS.has(step.name ?? ''));
      if (holds) expect(step.env?.GITHUB_TOKEN).toBe('${{ github.token }}');
    }
  });

  it('checks out pull-request code only in the read-only reviewer jobs, without a persisted token', async () => {
    for (const workflow of await reviewWorkflows()) {
      for (const [job, step] of steps(workflow)) {
        if (step.uses?.startsWith('actions/checkout') !== true) continue;
        if (step.with?.repository !== undefined) {
          expect(step.with?.path).toBe('.agent-ci-src');
          expect(step.with?.ref).toBe(
            '${{ inputs.agent_ci_ref || job.workflow_sha }}',
          );
        } else {
          expect(['verify', 'review']).toContain(job);
          expect(step.with?.ref).toBe(
            job === 'verify'
              ? '${{ needs.gate.outputs.head_sha }}'
              : '${{ inputs.head_sha }}',
          );
        }
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
    const adjudication = JSON.stringify(await adjudicate());
    expect(adjudication).not.toContain('inputs.head_sha');
    expect(adjudication).not.toContain('--cwd target');
  });

  it('never runs a setup command or installs skills for a review', async () => {
    const text = JSON.stringify(await reviewWorkflows());
    expect(text).not.toContain('setup_command');
    expect(text).not.toContain('skills install');
    expect(text).not.toContain('--seed-login');
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
    for (const [, step] of (await reviewWorkflows()).flatMap(steps))
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

describe('pr-review.yml verify-review', () => {
  it('offers verify-review only through the verify input (default false), passed to the gate', async () => {
    const workflow = await review();
    const inputs = (
      workflow.on.workflow_call as {
        inputs: Record<string, { type?: string; default?: unknown }>;
      }
    ).inputs;
    expect(inputs.verify).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.verify_on_self_hosted).toMatchObject({
      type: 'boolean',
      default: false,
    });
    const gate = (workflow.jobs.gate?.steps ?? []).find((s) => s.id === 'gate');
    expect(gate?.env?.VERIFY).toBe('${{ inputs.verify }}');
    expect(gate?.run).toContain('--verify "$VERIFY"');
    // checks.yaml comes from the default branch unless the caller names one.
    expect(inputs.verify_config_ref).toMatchObject({
      type: 'string',
      default: '',
    });
    const prepare = (workflow.jobs.gate?.steps ?? []).find(
      (s) => s.id === 'prepare',
    );
    expect(prepare?.env?.VERIFY_CONFIG_REF).toBe(
      '${{ inputs.verify_config_ref }}',
    );
    expect(prepare?.run).toContain('--verify-config-ref "$VERIFY_CONFIG_REF"');
  });

  it('runs the checks in a job that holds no secret, no helper token and no GitHub token step', async () => {
    const { jobs } = await review();
    const job = jobs.verify ?? {};
    const text = JSON.stringify(job);
    expect(job.if).toContain("needs.gate.outputs.mode == 'verify-review'");
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(text).not.toContain('secrets.');
    expect(text).not.toContain('github.token');
    expect(text).not.toContain('AGENT_CI_SOURCE_TOKEN');
    expect(text).not.toContain('.agent-ci-src');
    expect(text).not.toContain('setup-agent-ci');
    const jobSteps = job.steps ?? [];
    // agent-ci comes from the gate's bundle, pinned by id and sha256, and
    // is unpacked before the pull request head is checked out.
    const names = jobSteps.map((s) => s.name ?? '');
    const unpack = names.indexOf(
      "Unpack the helpers (checked against the gate's sha256)",
    );
    const checkout = names.indexOf('Check out the pull request head');
    const run = names.indexOf('Run the configured checks');
    expect(unpack).toBeGreaterThan(-1);
    expect(unpack).toBeLessThan(checkout);
    expect(checkout).toBeLessThan(run);
    expect(jobSteps[unpack]?.run).toContain('sha256sum -c -');
    expect(jobSteps[unpack]?.env?.BUNDLE_SHA256).toBe(
      '${{ needs.gate.outputs.helpers_sha256 }}',
    );
    expect(
      jobSteps.find((s) => s.name === 'Download the helper bundle')?.with?.[
        'artifact-ids'
      ],
    ).toBe('${{ needs.gate.outputs.helpers_artifact_id }}');
    expect(jobSteps[run]?.run).toContain(
      'node "$RUNNER_TEMP/agent-ci-helpers/dist/cli.js" review verify',
    );
    expect(Object.keys(jobSteps[run]?.env ?? {})).toEqual(['SPEC_SHA256']);
    // First step: refuse a self-hosted runner unless explicitly opted in.
    expect(jobSteps[0]?.if).toBe(
      "runner.environment != 'github-hosted' && !inputs.verify_on_self_hosted",
    );
    expect(jobSteps[0]?.run).toContain('exit 1');
    // The gate packs the bundle only for verify-review requests.
    const gateSteps = jobs.gate?.steps ?? [];
    expect(gateSteps.find((s) => s.id === 'helpers')?.if).toContain(
      "steps.gate.outputs.mode == 'verify-review'",
    );
  });

  it('feeds the verify output to both reviewer passes and still runs them when verify is skipped', async () => {
    const { jobs } = await review();
    for (const name of ['review-primary', 'review-second']) {
      const job = jobs[name] ?? {};
      expect(job.needs).toEqual(['gate', 'verify']);
      expect(job.if).toContain('!cancelled()');
      expect(job.with?.checks_digest).toBe(
        '${{ needs.verify.outputs.digest }}',
      );
      expect(job.with?.checks_artifact_id).toBe(
        '${{ needs.verify.outputs.artifact_id }}',
      );
      expect(job.with?.pass).toBe(
        name === 'review-primary' ? 'primary' : 'second',
      );
    }
    const child = await reviewPass();
    const pass = child.jobs.review?.steps?.find(
      (entry) => entry.name === 'Run the reviewer',
    );
    expect(pass?.run).toContain(
      '--checks-dir "$CHECKS_DIR" --checks-digest "$CHECKS_DIGEST"',
    );
    expect(pass?.env?.CHECKS_DIGEST).toBe('${{ inputs.checks_digest }}');
    expect(
      child.jobs.review?.steps?.find((entry) =>
        entry.name?.startsWith('Download the check results'),
      )?.with?.['artifact-ids'],
    ).toBe('${{ inputs.checks_artifact_id }}');
    expect(
      child.jobs.review?.steps?.find((entry) => entry.id === 'upload')?.with
        ?.name,
    ).toBe('${{ inputs.artifact_scope }}-agent-ci-review-${{ inputs.pass }}');
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
    const verify = workflow.jobs['verify-review'] ?? {};
    expect(verify.uses).toBe('./.github/workflows/pr-review.yml');
    expect(verify.if).toContain(
      "github.event.label.name == 'agent-ci:verify-review'",
    );
    expect(verify.with).toMatchObject({
      verify: true,
      verify_config_ref: '${{ github.base_ref }}',
      reviewer_model: 'fake-verify-review',
      artifact_scope: 'selftest-verify',
    });
    expect(verify.secrets).toBeUndefined();
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
      [
        'AGENT_CI_PROXY_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'AGENT_CI_PROXY_BASE_URL',
      ],
    );
    // The template itself has no steps: nothing runs outside the gate.
    expect(job.steps).toBeUndefined();
    // Optional passes and pool use stay off until the repository opts in.
    expect(job.with?.verify).toBe(false);
    expect(job.with?.reviewer_model).toBe('gpt-6.1-sol-high');
    expect(job.with?.second_reviewer).toBe(false);
    expect(job.with?.adjudicator).toBe(false);
    expect(job.with?.allow_pool).toBeUndefined();
    expect((job.secrets as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN).toBe(
      '${{ secrets.AGENT_CI_PROXY_API_KEY }}',
    );
  });
});
