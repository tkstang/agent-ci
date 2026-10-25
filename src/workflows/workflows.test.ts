import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { WORKFLOW_MODEL_SECRETS } from '@agent-ci/commands/route.js';
import { PACKAGE_ROOT } from '@agent-ci/paths.js';
import { parseModelsFile } from '@agent-ci/routing/resolve.js';
import {
  agentJob,
  agentJobWorkflow,
  INNER_READ_SCOPED,
  type Job,
  load,
  MODEL_SECRETS,
  modelChain,
  READ_SCOPED,
  runAgent,
  secretRefs,
  step,
  TARGET_TOKEN_USES,
  targetTokenUses,
  WRITE_SCOPED,
} from '@agent-ci/workflows/testing/helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * Structure tests for the reusable workflow, the self-test caller, the
 * consumer template and this repository's CI. actionlint checks syntax and
 * shell; these pin the security-relevant structure.
 */

describe('run-agent.yml', () => {
  it('is a reusable workflow whose jobs run on the runs_on input', async () => {
    const workflow = await runAgent();
    expect(Object.keys(workflow.on)).toEqual(['workflow_call']);
    expect(Object.keys(workflow.jobs)).toEqual([
      'resolve',
      'setup',
      'agent',
      'publish',
    ]);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === 'agent') {
        expect(job.with?.runs_on).toBe('${{ inputs.runs_on }}');
      } else {
        expect(job['runs-on']).toBe('${{ inputs.runs_on }}');
      }
    }
    expect((await agentJob())['runs-on']).toBe('${{ inputs.runs_on }}');
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('separates authority: a read-only agent workflow and a write-only publish job', async () => {
    const { jobs } = await runAgent();
    const inner = await agentJobWorkflow();
    expect(jobs.agent?.uses).toBe('./.github/workflows/agent-job.yml');
    expect(jobs.agent?.permissions).toEqual({ contents: 'read' });
    expect(inner.permissions).toEqual({ contents: 'read' });
    expect(inner.jobs.agent?.permissions).toEqual({ contents: 'read' });
    expect(jobs.publish?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
    expect(jobs.publish?.needs).toEqual(['resolve', 'agent']);
    // The agent job's checkouts never persist a token for the agent to read.
    const agent = await agentJob();
    for (const name of [
      'Check out the target repository',
      'Check out the agent-ci helpers',
    ]) {
      expect(step(agent, name).with?.['persist-credentials']).toBe(false);
    }
  });

  it('gives the agent workflow exactly one model credential, chosen by a static chain', async () => {
    const { on, jobs } = await runAgent();
    const declared = Object.keys(
      (on.workflow_call as { secrets: Record<string, unknown> }).secrets,
    );
    // Every credential a CI-eligible route names is declared and selectable.
    const models = parseModelsFile(
      await readFile(path.join(PACKAGE_ROOT, 'models.yaml'), 'utf8'),
    );
    if (!models.ok) throw new Error(models.message);
    const ciCredentials = models.value.routes
      .filter((route) => route.account !== 'pool' && !route.login)
      .flatMap((route) => route.credentials);
    for (const name of ciCredentials) {
      expect(declared).toContain(name);
      expect(WORKFLOW_MODEL_SECRETS).toContain(name);
    }
    expect([...WORKFLOW_MODEL_SECRETS]).toEqual(MODEL_SECRETS);

    // The call passes the selected credential and two read-only tokens only.
    expect(jobs.agent?.secrets).toEqual({
      AGENT_CI_CREDENTIAL: modelChain('needs.resolve.outputs.credential'),
      AGENT_CI_SOURCE_TOKEN: '${{ secrets.AGENT_CI_SOURCE_TOKEN }}',
      AGENT_CI_TARGET_READ_TOKEN: '${{ secrets.AGENT_CI_TARGET_READ_TOKEN }}',
    });
    const inner = await agentJobWorkflow();
    expect(
      Object.keys(
        (inner.on.workflow_call as { secrets: Record<string, unknown> })
          .secrets,
      ),
    ).toEqual([
      'AGENT_CI_CREDENTIAL',
      'AGENT_CI_SOURCE_TOKEN',
      'AGENT_CI_TARGET_READ_TOKEN',
    ]);
    const agent = await agentJob();
    const runStep = step(agent, 'Run the agent');
    expect(runStep.env?.AGENT_CI_CREDENTIAL).toBe(
      '${{ secrets.AGENT_CI_CREDENTIAL }}',
    );
    expect(runStep.run).toContain('--credential-from-env');
    for (const entry of agent.steps ?? []) {
      if (entry === runStep) continue;
      expect(secretRefs(entry), entry.name).not.toContain(
        'AGENT_CI_CREDENTIAL',
      );
    }

    // No step anywhere in run-agent.yml sees a model credential.
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const entry of job.steps ?? []) {
        const refs = secretRefs(entry);
        for (const ref of refs) expect(MODEL_SECRETS).not.toContain(ref);
        if (refs.includes('AGENT_CI_NOTIFY_WEBHOOK')) {
          expect([jobName, entry.name]).toEqual(['publish', 'Notify']);
        }
        if (refs.includes('AGENT_CI_SOURCE_TOKEN')) {
          expect(entry.name).toBe('Check out the agent-ci helpers');
        }
      }
    }
  });

  it('resolves the route once in the resolve job and re-resolves it under policy in the agent job', async () => {
    const { jobs } = await runAgent();
    const route = step(jobs.resolve ?? {}, 'Resolve the route');
    expect(route.run).toBe(
      'agent-ci route --model "$MODEL" --harness "$HARNESS" --route "$ROUTE" --github-output',
    );
    expect(jobs.agent?.with?.route_id).toBe(
      '${{ needs.resolve.outputs.route_id }}',
    );
    const inner = step(await agentJob(), 'Resolve the route');
    expect(inner.run).toBe('agent-ci route --route "$ROUTE" --github-output');
    expect(inner.env?.ROUTE).toBe('${{ inputs.route_id }}');
  });

  it("checks out helpers at the reusable workflow's own repository and commit by default", async () => {
    const { jobs } = await runAgent();
    for (const job of [jobs.resolve, await agentJob(), jobs.publish]) {
      const helpers = step(job ?? {}, 'Check out the agent-ci helpers');
      // job.workflow_*: the called workflow's own commit (verified live);
      // github.workflow_sha would be the consumer's commit.
      expect(helpers.with?.repository).toBe(
        '${{ inputs.agent_ci_repository || job.workflow_repository }}',
      );
      expect(helpers.with?.ref).toBe(
        '${{ inputs.agent_ci_ref || job.workflow_sha }}',
      );
      expect(helpers.with?.token).toBe(
        '${{ secrets.AGENT_CI_SOURCE_TOKEN || github.token }}',
      );
    }
    for (const job of [jobs.resolve, await agentJob()]) {
      expect(job?.steps?.[0]?.name).toBe('Require a resolvable helper ref');
    }
    expect(JSON.stringify(jobs)).not.toContain('github.workflow_sha');
  });

  it('builds and publishes against the same ref', async () => {
    const { jobs } = await runAgent();
    // One commit, resolved by a trusted job that checks out only the helpers.
    const resolve = jobs.resolve ?? {};
    expect(resolve.permissions).toEqual({ contents: 'read' });
    const checkouts = (resolve.steps ?? []).filter((entry) =>
      entry.uses?.startsWith('actions/checkout'),
    );
    expect(checkouts.map((entry) => entry.name)).toEqual([
      'Check out the agent-ci helpers',
    ]);
    const resolveStep = step(
      resolve,
      'Resolve the target repository, commit and base',
    );
    expect(resolveStep.run).toContain('agent-ci targets resolve');
    expect(resolveStep.env).toMatchObject({
      GITHUB_TOKEN: '${{ github.token }}',
      AGENT_CI_TARGET_TOKEN: '${{ secrets.AGENT_CI_TARGET_TOKEN }}',
      AGENT_CI_TARGET_READ_TOKEN: '${{ secrets.AGENT_CI_TARGET_READ_TOKEN }}',
      REPOSITORY: '${{ inputs.target_repository }}',
      REF: '${{ inputs.target_ref }}',
      BASE: '${{ inputs.publish_base }}',
      COMMENT_PR: '${{ inputs.comment_pr }}',
      EVENT_REF: '${{ github.event.pull_request.head.sha || github.sha }}',
      EVENT_BASE:
        "${{ github.head_ref || (github.ref_type == 'branch' && github.ref_name) || '' }}",
      EVENT_PR: "${{ github.event.pull_request.number || '' }}",
    });
    for (const name of ['setup', 'publish']) {
      const target = step(jobs[name] ?? {}, 'Check out the target repository');
      expect(target.with?.ref).toBe('${{ needs.resolve.outputs.sha }}');
      expect(target.with?.repository).toBe(
        '${{ needs.resolve.outputs.repository }}',
      );
    }
    expect(jobs.agent?.with).toMatchObject({
      repository: '${{ needs.resolve.outputs.repository }}',
      cross: '${{ needs.resolve.outputs.cross }}',
      sha: '${{ needs.resolve.outputs.sha }}',
      base: '${{ needs.resolve.outputs.base }}',
    });
    const innerTarget = step(
      await agentJob(),
      'Check out the target repository',
    );
    expect(innerTarget.with?.ref).toBe('${{ inputs.sha }}');
    expect(innerTarget.with?.repository).toBe('${{ inputs.repository }}');
    expect(jobs.agent?.if).toContain("needs.resolve.result == 'success'");
    const publish = step(jobs.publish ?? {}, 'Publish');
    expect(publish.env?.BASE).toBe('${{ needs.resolve.outputs.base }}');
    expect(publish.env?.COMMENT_PR).toBe(
      '${{ needs.resolve.outputs.comment_pr }}',
    );
    expect(publish.env?.TARGET_REPOSITORY).toBe(
      '${{ needs.resolve.outputs.repository }}',
    );
    expect(publish.run).toContain('--repo "$TARGET_REPOSITORY"');
    expect(step(await agentJob(), 'Run the agent').run).toContain(
      '--target-repo "$TARGET_REPOSITORY"',
    );
  });

  it('references the write-capable target token only in jobs that run no repository code and no agent', async () => {
    const { on, jobs } = await runAgent();
    const secrets = (on.workflow_call as { secrets: Record<string, unknown> })
      .secrets;
    expect(Object.keys(secrets)).toEqual(
      expect.arrayContaining([
        'AGENT_CI_TARGET_TOKEN',
        'AGENT_CI_TARGET_READ_TOKEN',
      ]),
    );
    expect(targetTokenUses(jobs)).toEqual(TARGET_TOKEN_USES);
    const setup = step(jobs.setup ?? {}, 'Check out the target repository');
    expect(setup.with?.token).toBe(READ_SCOPED);
    expect(setup.with?.['persist-credentials']).toBe(false);
    const inner = step(await agentJob(), 'Check out the target repository');
    expect(inner.with?.token).toBe(INNER_READ_SCOPED);
    expect(targetTokenUses((await agentJobWorkflow()).jobs)).toEqual({
      'agent/Check out the target repository': ['AGENT_CI_TARGET_READ_TOKEN'],
    });
    expect(
      step(jobs.publish ?? {}, 'Check out the target repository').with?.token,
    ).toBe(WRITE_SCOPED);
    expect(step(jobs.publish ?? {}, 'Publish').env?.GITHUB_TOKEN).toBe(
      WRITE_SCOPED,
    );
  });

  it('writes the preset or custom prompt through agent-ci and enforces the path policy at publish', async () => {
    const { on, jobs } = await runAgent();
    const inputs = (
      on.workflow_call as { inputs: Record<string, Record<string, unknown>> }
    ).inputs;
    expect(inputs.prompt?.required).toBeUndefined();
    expect(inputs.model?.required).toBeUndefined();
    expect(inputs.adopt_branch?.default).toBe(false);
    const prompt = step(await agentJob(), 'Write the prompt');
    expect(prompt.run).toContain(
      'agent-ci preset prompt --preset "$PRESET" --prompt-env PROMPT',
    );
    expect(prompt.env).toMatchObject({
      PROMPT: '${{ inputs.prompt }}',
      PRESET: '${{ inputs.preset }}',
      BASE: '${{ inputs.base }}',
    });
    expect(jobs.agent?.with).toMatchObject({
      prompt: '${{ inputs.prompt }}',
      preset: '${{ inputs.preset }}',
    });
    const publish = step(jobs.publish ?? {}, 'Publish');
    expect(publish.env?.PATH_POLICY).toBe(
      '${{ inputs.path_policy || inputs.preset }}',
    );
    expect(publish.env?.ADOPT).toBe('${{ inputs.adopt_branch }}');
    expect(publish.run).toContain('--path-policy "$PATH_POLICY"');
    expect(publish.run).toContain('--adopt "$ADOPT"');
  });

  it('keeps the home root and outputs outside the workspace and trusts the checkout for git', async () => {
    const agent = await agentJob();
    const names = (agent.steps ?? []).map((entry) => entry.name);
    const runStep = step(agent, 'Run the agent');
    expect(runStep.run).toContain('--home-root "$RUNNER_TEMP/agent-ci-home"');
    expect(runStep.run).toContain('--out "$RUNNER_TEMP/agent-ci-out"');
    expect(runStep.run).toContain('--cwd target');
    expect(step(agent, 'Install skills into the per-job home').run).toContain(
      '--home-root "$RUNNER_TEMP/agent-ci-home"',
    );
    expect(step(agent, 'Trust the target checkout for git').run).toBe(
      'git config --global --add safe.directory "$GITHUB_WORKSPACE/target"',
    );
    expect(names.indexOf('Trust the target checkout for git')).toBeLessThan(
      names.indexOf('Run the agent'),
    );
    expect(names.indexOf('Install skills into the per-job home')).toBeLessThan(
      names.indexOf('Run the agent'),
    );
  });

  it('runs the setup command in its own credential-free job and hands over only the working tree', async () => {
    const { jobs } = await runAgent();
    const setup = jobs.setup ?? {};
    const agent = await agentJob();
    expect(setup.if).toBe("inputs.setup_command != ''");
    expect(setup.permissions).toEqual({ contents: 'read' });
    // Only the read-only target token, only for the checkout.
    expect(secretRefs(setup)).toEqual(['AGENT_CI_TARGET_READ_TOKEN']);
    expect(
      step(setup, 'Check out the target repository').with?.[
        'persist-credentials'
      ],
    ).toBe(false);
    expect(step(setup, 'Run the setup command').env?.SETUP_COMMAND).toBe(
      '${{ inputs.setup_command }}',
    );
    expect(
      step(setup, 'Pack the prepared working tree (without .git)').run,
    ).toContain('--exclude=.git');
    // The agent waits for setup but never runs the command itself.
    expect(jobs.agent?.needs).toContain('setup');
    expect(jobs.agent?.if).toContain(
      "needs.setup.outputs.prepared_artifact_id != ''",
    );
    expect(jobs.agent?.with).toMatchObject({
      prepared_artifact_id: '${{ needs.setup.outputs.prepared_artifact_id }}',
      prepared_sha256: '${{ needs.setup.outputs.prepared_sha256 }}',
    });
    expect(JSON.stringify(jobs.agent)).not.toContain('setup_command');
    expect(JSON.stringify(agent)).not.toContain('SETUP_COMMAND');
    // No tar in the credential job: agent-ci parses the archive itself.
    for (const entry of agent.steps ?? []) {
      expect(entry.run ?? '').not.toMatch(/\btar\b/u);
    }
    const download = step(agent, 'Download the prepared working tree');
    expect(download.if).toBe("inputs.prepared_artifact_id != ''");
    expect(download.with?.['artifact-ids']).toBe(
      '${{ inputs.prepared_artifact_id }}',
    );
    expect(download.with?.name).toBeUndefined();
    const restore = step(agent, 'Restore the prepared working tree');
    expect(restore.run).toBe(
      'agent-ci workspace restore --archive "$RUNNER_TEMP/agent-ci-prepared/agent-ci-prepared.tgz" --target target --sha256 "$PREPARED_SHA256"',
    );
    expect(restore.env?.PREPARED_SHA256).toBe('${{ inputs.prepared_sha256 }}');
    const names = (agent.steps ?? []).map((entry) => entry.name);
    expect(names.indexOf('Set up agent-ci')).toBeLessThan(
      names.indexOf('Restore the prepared working tree'),
    );
    expect(names.indexOf('Restore the prepared working tree')).toBeLessThan(
      names.indexOf('Resolve the route'),
    );
  });

  it('enables the Codex sandbox only on GitHub-hosted Linux runners and checks it before the agent', async () => {
    const agent = await agentJob();
    const names = (agent.steps ?? []).map((entry) => entry.name);
    const enable = step(
      agent,
      'Enable the Codex sandbox (GitHub-hosted Linux)',
    );
    expect(enable.if).toBe(
      "steps.route.outputs.harness == 'codex' && runner.os == 'Linux' && runner.environment == 'github-hosted'",
    );
    expect(enable.run).toContain(
      'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    );
    const check = step(agent, 'Check the Codex sandbox');
    expect(check.if).toBe("steps.route.outputs.harness == 'codex'");
    expect(check.run).toBe('agent-ci harness smoke --harness codex');
    expect(
      names.indexOf('Enable the Codex sandbox (GitHub-hosted Linux)'),
    ).toBeLessThan(names.indexOf('Check the Codex sandbox'));
    expect(names.indexOf('Check the Codex sandbox')).toBeLessThan(
      names.indexOf('Run the agent'),
    );
  });

  it('installs repository skills only for edit runs, never for read-only runs', async () => {
    const agent = await agentJob();
    const oat = step(agent, 'Install skills into the per-job home');
    expect(oat.run).not.toContain('--source');
    expect(oat.run).not.toContain('--allow-workspace-source');
    const repo = step(agent, 'Install repository skills (edit runs only)');
    expect(repo.if).toBe("inputs.skills_source != '' && inputs.mode == 'edit'");
    expect(repo.run).toContain('--allow-workspace-source');
    for (const entry of agent.steps ?? []) {
      if (entry !== repo) {
        expect(entry.run ?? '').not.toContain('--allow-workspace-source');
      }
    }
  });

  it('publishes only from the canonical result directory', async () => {
    const { jobs } = await runAgent();
    const publish = jobs.publish ?? {};
    const download = step(publish, 'Download the run result');
    expect(download.with?.path).toBe('${{ runner.temp }}/agent-ci-result');
    expect(step(publish, 'Publish').run).toContain(
      '--result-dir "$RUNNER_TEMP/agent-ci-result"',
    );
    expect(step(publish, 'Publish').run).toContain(
      '--comment-author "$PUBLISHER_LOGIN"',
    );
    expect(step(publish, 'Publish').env?.PUBLISHER_LOGIN).toBe(
      '${{ inputs.publisher_login }}',
    );
    expect(step(publish, 'Notify').run).toContain(
      '--result-dir "$RUNNER_TEMP/agent-ci-result"',
    );
    const upload = step(await agentJob(), 'Upload the run result');
    expect(upload.with?.path).toBe('${{ runner.temp }}/agent-ci-out');
    expect(jobs.publish?.if).toBe(
      "${{ !cancelled() && needs.agent.outputs.result_artifact_id != '' }}",
    );
  });

  it("publishes only the agent job's own upload, verified by digest", async () => {
    const workflow = await runAgent();
    const inner = await agentJobWorkflow();
    const agent = inner.jobs.agent as Job & {
      outputs?: Record<string, string>;
    };
    const upload = step(agent, 'Upload the run result');
    expect(upload.id).toBe('upload');
    expect(upload.if).toBe("always() && steps.digest.outcome == 'success'");
    expect(agent.outputs?.result_artifact_id).toBe(
      '${{ steps.upload.outputs.artifact-id }}',
    );
    expect(agent.outputs?.result_digest).toBe(
      '${{ steps.digest.outputs.digest }}',
    );
    expect(
      (inner.on.workflow_call as { outputs: Record<string, { value: string }> })
        .outputs,
    ).toMatchObject({
      result_artifact_id: {
        value: '${{ jobs.agent.outputs.result_artifact_id }}',
      },
      result_digest: { value: '${{ jobs.agent.outputs.result_digest }}' },
    });
    expect(step(agent, 'Digest the run result').run).toBe(
      'agent-ci digest --dir "$RUNNER_TEMP/agent-ci-out" --github-output',
    );
    const publish = workflow.jobs.publish ?? {};
    const download = step(publish, 'Download the run result');
    expect(download.with?.['artifact-ids']).toBe(
      '${{ needs.agent.outputs.result_artifact_id }}',
    );
    expect(download.with?.name).toBeUndefined();
    for (const name of ['Publish', 'Notify']) {
      const entry = step(publish, name);
      expect(entry.run).toContain('--result-digest "$RESULT_DIGEST"');
      expect(entry.env?.RESULT_DIGEST).toBe(
        '${{ needs.agent.outputs.result_digest }}',
      );
    }
    for (const job of [...Object.values(workflow.jobs), agent]) {
      for (const entry of job.steps ?? []) {
        if (entry.uses?.startsWith('actions/download-artifact')) {
          expect(entry.with?.name).toBeUndefined();
        }
      }
    }
  });
});

describe('agent-ci-selftest.yml', () => {
  it('runs the fake harness through run-agent.yml for same-repository labeled PRs only', async () => {
    const workflow = await load('.github/workflows/agent-ci-selftest.yml');
    expect(Object.keys(workflow.on)).toEqual([
      'pull_request',
      'workflow_dispatch',
    ]);
    expect(JSON.stringify(workflow)).not.toContain('pull_request_target');
    const fake = workflow.jobs['fake-run'] ?? {};
    expect(fake.uses).toBe('./.github/workflows/run-agent.yml');
    expect(fake.with?.model).toBe('fake-edit');
    expect(fake.with?.publish_pr).toBe(true);
    expect(fake.secrets).toBeUndefined();
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toContain(
        'github.event.pull_request.head.repo.full_name == github.repository',
      );
      expect(job.if).toContain("'agent-ci-selftest'");
    }
    const smoke = workflow.jobs['harness-smoke'] ?? {};
    expect(smoke.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(smoke.steps)).toContain(
      '--harness claude,codex,opencode,cursor',
    );
    expect(JSON.stringify(smoke.steps)).toContain(
      'harness smoke --harness codex',
    );
  });
});

describe('consumer template', () => {
  it('pins the helpers and passes only the source token and one model credential', async () => {
    const workflow = await load('consumer-workflows/agent-ci-run.yml');
    const job = workflow.jobs.run ?? {};
    expect(job.uses).toMatch(
      /^tkstang\/agent-ci\/\.github\/workflows\/run-agent\.yml@/u,
    );
    // Helpers follow the uses: pin; no second pin to drift.
    expect(job.with?.agent_ci_ref).toBeUndefined();
    expect(Object.keys(job.secrets ?? {})).toEqual([
      'AGENT_CI_SOURCE_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(job.secrets).not.toBe('inherit');
  });
});

describe('ci.yml', () => {
  it('runs actionlint over the workflows and the consumer template', async () => {
    const workflow = await load('.github/workflows/ci.yml');
    const steps = JSON.stringify(workflow.jobs.actionlint?.steps);
    expect(steps).toContain('docker://rhysd/actionlint:');
    expect(steps).toContain('consumer-workflows/agent-ci-run.yml');
  });
});
