import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PACKAGE_ROOT } from '@agent-ci/paths.js';
import { parseModelsFile } from '@agent-ci/routing/resolve.js';
import {
  type Job,
  load,
  MODEL_SECRETS,
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
    for (const job of Object.values(workflow.jobs)) {
      expect(job['runs-on']).toBe('${{ inputs.runs_on }}');
    }
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('separates authority: a read-only agent job and a write-only publish job', async () => {
    const { jobs } = await runAgent();
    expect(jobs.agent?.permissions).toEqual({ contents: 'read' });
    expect(jobs.publish?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
    expect(jobs.publish?.needs).toEqual(['resolve', 'agent']);
    // The agent job's checkout never persists a token for the agent to read.
    const target = step(jobs.agent ?? {}, 'Check out the target repository');
    expect(target.with?.['persist-credentials']).toBe(false);
    const helpers = step(jobs.agent ?? {}, 'Check out the agent-ci helpers');
    expect(helpers.with?.['persist-credentials']).toBe(false);
  });

  it('passes exactly one model credential, only to the agent step', async () => {
    const { on, jobs } = await runAgent();
    const declared = Object.keys(
      (on.workflow_call as { secrets: Record<string, unknown> }).secrets,
    );
    // Every credential a CI-eligible route names is declared.
    const models = parseModelsFile(
      await readFile(path.join(PACKAGE_ROOT, 'models.yaml'), 'utf8'),
    );
    if (!models.ok) throw new Error(models.message);
    const ciCredentials = models.value.routes
      .filter((route) => route.account !== 'pool' && !route.login)
      .flatMap((route) => route.credentials);
    for (const name of ciCredentials) expect(declared).toContain(name);

    const runStep = step(jobs.agent ?? {}, 'Run the agent');
    expect(Object.keys(runStep.env ?? {})).toContain('AGENT_CI_CREDENTIAL');
    expect(secretRefs(runStep.env)).toEqual(['[dynamic]']);
    expect(String(runStep.env?.AGENT_CI_CREDENTIAL)).toBe(
      "${{ steps.route.outputs.credential != '' && secrets[steps.route.outputs.credential] || '' }}",
    );
    expect(runStep.run).toContain('--credential-from-env');

    // No other step, in either job, sees a model credential.
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const entry of job.steps ?? []) {
        if (entry === runStep) continue;
        const refs = secretRefs(entry);
        for (const ref of refs) {
          expect(MODEL_SECRETS).not.toContain(ref);
          expect(ref).not.toBe('[dynamic]');
        }
        if (refs.includes('AGENT_CI_NOTIFY_WEBHOOK')) {
          expect([jobName, entry.name]).toEqual(['publish', 'Notify']);
        }
        if (refs.includes('AGENT_CI_SOURCE_TOKEN')) {
          expect(entry.name).toBe('Check out the agent-ci helpers');
        }
      }
    }
  });

  it("checks out helpers at the reusable workflow's own repository and commit by default", async () => {
    const { jobs } = await runAgent();
    for (const job of [jobs.resolve, jobs.agent, jobs.publish]) {
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
    expect(JSON.stringify(jobs)).not.toContain('github.workflow_sha');
    const guard = jobs.agent?.steps?.[0];
    expect(guard?.name).toBe('Require a resolvable helper ref');
    expect(guard?.run).toContain('exit 1');
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
      REPOSITORY: '${{ inputs.target_repository }}',
      REF: '${{ inputs.target_ref }}',
      BASE: '${{ inputs.publish_base }}',
      COMMENT_PR: '${{ inputs.comment_pr }}',
      EVENT_REF: '${{ github.event.pull_request.head.sha || github.sha }}',
      EVENT_BASE:
        "${{ github.head_ref || (github.ref_type == 'branch' && github.ref_name) || '' }}",
      EVENT_PR: "${{ github.event.pull_request.number || '' }}",
    });
    for (const name of ['setup', 'agent', 'publish']) {
      const job = jobs[name] ?? {};
      const target = step(job, 'Check out the target repository');
      expect(target.with?.ref).toBe('${{ needs.resolve.outputs.sha }}');
      expect(target.with?.repository).toBe(
        '${{ needs.resolve.outputs.repository }}',
      );
      expect(JSON.stringify(job.needs)).toContain('resolve');
    }
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
    expect(step(jobs.agent ?? {}, 'Run the agent').run).toContain(
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
    for (const name of ['setup', 'agent']) {
      const checkout = step(
        jobs[name] ?? {},
        'Check out the target repository',
      );
      expect(checkout.with?.token).toBe(READ_SCOPED);
      expect(checkout.with?.['persist-credentials']).toBe(false);
    }
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
    const prompt = step(jobs.agent ?? {}, 'Write the prompt');
    expect(prompt.run).toContain(
      'agent-ci preset prompt --preset "$PRESET" --prompt-env PROMPT',
    );
    expect(prompt.env).toMatchObject({
      PROMPT: '${{ inputs.prompt }}',
      PRESET: '${{ inputs.preset }}',
      BASE: '${{ needs.resolve.outputs.base }}',
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
    const { jobs } = await runAgent();
    const agent = jobs.agent ?? {};
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
    const agent = jobs.agent ?? {};
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
    // The agent job waits for setup but never runs the command itself.
    expect(agent.needs).toContain('setup');
    expect(agent.if).toContain(
      "needs.setup.outputs.prepared_artifact_id != ''",
    );
    expect(JSON.stringify(agent)).not.toContain('setup_command }}');
    expect(JSON.stringify(agent)).not.toContain('SETUP_COMMAND');
    // No tar in the credential job: agent-ci parses the archive itself.
    for (const entry of agent.steps ?? []) {
      expect(entry.run ?? '').not.toMatch(/\btar\b/u);
    }
    const download = step(agent, 'Download the prepared working tree');
    expect(download.with?.['artifact-ids']).toBe(
      '${{ needs.setup.outputs.prepared_artifact_id }}',
    );
    expect(download.with?.name).toBeUndefined();
    const restore = step(agent, 'Restore the prepared working tree');
    expect(restore.run).toBe(
      'agent-ci workspace restore --archive "$RUNNER_TEMP/agent-ci-prepared/agent-ci-prepared.tgz" --target target --sha256 "$PREPARED_SHA256"',
    );
    expect(restore.env?.PREPARED_SHA256).toBe(
      '${{ needs.setup.outputs.prepared_sha256 }}',
    );
    const names = (agent.steps ?? []).map((entry) => entry.name);
    expect(names.indexOf('Set up agent-ci')).toBeLessThan(
      names.indexOf('Restore the prepared working tree'),
    );
    expect(names.indexOf('Restore the prepared working tree')).toBeLessThan(
      names.indexOf('Resolve the route'),
    );
  });

  it('enables the Codex sandbox only on GitHub-hosted Linux runners and checks it before the agent', async () => {
    const { jobs } = await runAgent();
    const agent = jobs.agent ?? {};
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
    const { jobs } = await runAgent();
    const agent = jobs.agent ?? {};
    const oat = step(agent, 'Install skills into the per-job home');
    expect(oat.run).not.toContain('--source');
    expect(oat.run).not.toContain('--allow-workspace-source');
    const repo = step(agent, 'Install repository skills (edit runs only)');
    expect(repo.if).toBe("inputs.skills_source != '' && inputs.mode == 'edit'");
    expect(repo.run).toContain('--allow-workspace-source');
    // No other step can bring workspace skills in.
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
    const upload = step(jobs.agent ?? {}, 'Upload the run result');
    expect(upload.with?.path).toBe('${{ runner.temp }}/agent-ci-out');
    expect(jobs.publish?.if).toBe(
      "${{ !cancelled() && needs.agent.outputs.result_artifact_id != '' }}",
    );
  });

  it("publishes only the agent job's own upload, verified by digest", async () => {
    const workflow = await runAgent();
    const agent = workflow.jobs.agent as Job & {
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
    // No artifact is downloaded by name anywhere.
    for (const job of Object.values(workflow.jobs)) {
      for (const entry of job.steps ?? []) {
        if (entry.uses?.startsWith('actions/download-artifact')) {
          expect(entry.with?.name).toBeUndefined();
        }
      }
    }
  });

  it('keeps step logic in agent-ci subcommands and inputs out of scripts', async () => {
    const { jobs } = await runAgent();
    for (const job of Object.values(jobs)) {
      for (const entry of job.steps ?? []) {
        if (entry.run === undefined) continue;
        // About a dozen lines at most; anything longer is a subcommand.
        expect(entry.run.trim().split('\n').length).toBeLessThanOrEqual(12);
        // Inputs reach scripts through env, never by expression expansion.
        expect(entry.run).not.toContain('${{');
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
