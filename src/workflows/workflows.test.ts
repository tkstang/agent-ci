import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PACKAGE_ROOT } from '@agent-ci/paths.js';
import { parseModelsFile } from '@agent-ci/routing/resolve.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Structure tests for the reusable workflow, the self-test caller, the
 * consumer template and this repository's CI. actionlint checks syntax and
 * shell; these pin the security-relevant structure.
 */

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}
interface Job {
  'runs-on'?: string;
  permissions?: Record<string, string>;
  needs?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

async function load<T = Workflow>(relative: string): Promise<T> {
  return parse(await readFile(path.join(PACKAGE_ROOT, relative), 'utf8')) as T;
}

const runAgent = () => load('.github/workflows/run-agent.yml');

function step(job: Job, name: string): Step {
  const found = job.steps?.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
}

/** Every `${{ secrets.* }}` / `secrets[...]` reference in a value. */
function secretRefs(value: unknown): string[] {
  const text = JSON.stringify(value ?? '');
  return [...text.matchAll(/secrets(?:\.([A-Z_]+)|\[)/gu)].map(
    (match) => match[1] ?? '[dynamic]',
  );
}

const MODEL_SECRETS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENCODE_API_KEY',
  'CURSOR_API_KEY',
];

describe('run-agent.yml', () => {
  it('is a reusable workflow whose jobs run on the runs_on input', async () => {
    const workflow = await runAgent();
    expect(Object.keys(workflow.on)).toEqual(['workflow_call']);
    expect(Object.keys(workflow.jobs)).toEqual(['agent', 'publish']);
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
    expect(jobs.publish?.needs).toBe('agent');
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

  it('checks out helpers at the calling workflow SHA by default and requires a pin elsewhere', async () => {
    const { jobs } = await runAgent();
    for (const job of [jobs.agent, jobs.publish]) {
      const helpers = step(job ?? {}, 'Check out the agent-ci helpers');
      expect(helpers.with?.ref).toBe(
        '${{ inputs.agent_ci_ref || github.workflow_sha }}',
      );
      expect(helpers.with?.token).toBe(
        '${{ secrets.AGENT_CI_SOURCE_TOKEN || github.token }}',
      );
    }
    const guard = jobs.agent?.steps?.[0];
    expect(guard?.if).toBe(
      "inputs.agent_ci_ref == '' && github.repository != inputs.agent_ci_repository",
    );
    expect(guard?.run).toContain('exit 1');
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
    // The setup command runs in the target and gets no secret.
    expect(
      secretRefs(step(agent, 'Run the setup command (no secrets)')),
    ).toEqual([]);
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

  it('publishes only from the canonical result directory', async () => {
    const { jobs } = await runAgent();
    const publish = jobs.publish ?? {};
    const download = step(publish, 'Download the run result');
    expect(download.with?.path).toBe('${{ runner.temp }}/agent-ci-result');
    expect(step(publish, 'Publish').run).toContain(
      '--result-dir "$RUNNER_TEMP/agent-ci-result"',
    );
    expect(step(publish, 'Notify').run).toContain(
      '--result-dir "$RUNNER_TEMP/agent-ci-result"',
    );
    const upload = step(jobs.agent ?? {}, 'Upload the run result');
    expect(upload.with?.path).toBe('${{ runner.temp }}/agent-ci-out');
    expect(jobs.publish?.if).toBe(
      "${{ !cancelled() && needs.agent.outputs.result_uploaded == 'true' }}",
    );
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
    const ref = /@([^\s]+)$/u.exec(job.uses ?? '')?.[1];
    expect(job.uses).toMatch(
      /^tkstang\/agent-ci\/\.github\/workflows\/run-agent\.yml@/u,
    );
    expect(job.with?.agent_ci_ref).toBe(ref);
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
