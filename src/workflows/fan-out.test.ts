import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { PACKAGE_ROOT } from '@agent-ci/paths.js';
import type { MatrixEntry } from '@agent-ci/targets/select.js';
import { PRESETS } from '@agent-ci/use-cases/presets.js';
import {
  type Job,
  load,
  MODEL_SECRETS,
  READ_SCOPED,
  runAgent,
  secretRefs,
  step,
  targetTokenUses,
  type Workflow,
  WRITE_SCOPED,
} from '@agent-ci/workflows/testing/helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * Structure tests for the use-case wrappers, the deterministic tools-update
 * workflow, the fan-out workflow, their self-test and templates, plus a
 * class sweep over every workflow and template in the repository.
 */

type CallJob = Job & {
  name?: string;
  strategy?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
};

const toolsUpdate = () => load('.github/workflows/tools-update.yml');
const fanOut = () => load('.github/workflows/fan-out.yml');

async function allWorkflowFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of ['.github/workflows', 'consumer-workflows']) {
    for (const name of await readdir(path.join(PACKAGE_ROOT, dir))) {
      if (name.endsWith('.yml')) files.push(`${dir}/${name}`);
    }
  }
  return files.toSorted();
}

const normalize = (job: Job | undefined) =>
  JSON.stringify(job).replaceAll(
    /\$\{\{ inputs\.(?:target_ref|publish_base|base) \}\}/gu,
    '<ref>',
  );

describe('tools-update.yml', () => {
  it('declares no model credential anywhere and runs no agent', async () => {
    const workflow = await toolsUpdate();
    const secrets = Object.keys(
      (workflow.on.workflow_call as { secrets: Record<string, unknown> })
        .secrets,
    );
    expect(secrets.toSorted()).toEqual([
      'AGENT_CI_NOTIFY_WEBHOOK',
      'AGENT_CI_SOURCE_TOKEN',
      'AGENT_CI_TARGET_READ_TOKEN',
      'AGENT_CI_TARGET_TOKEN',
    ]);
    const text = JSON.stringify(workflow);
    for (const name of MODEL_SECRETS) expect(text).not.toContain(name);
    expect(text).not.toContain('agent-ci run ');
    expect(text).not.toContain('harness install');
    expect(Object.keys(workflow.jobs)).toEqual(['resolve', 'run', 'publish']);
  });

  it('runs the update in a read-only job and publishes under the tools-update policy', async () => {
    const { jobs } = await toolsUpdate();
    expect(jobs.run?.permissions).toEqual({ contents: 'read' });
    expect(jobs.publish?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
    const update = step(jobs.run ?? {}, 'Run the tools update');
    expect(update.run).toContain('agent-ci tools-update --cwd target');
    expect(update.run).toContain('--out "$RUNNER_TEMP/agent-ci-out"');
    const publish = step(jobs.publish ?? {}, 'Publish');
    expect(publish.env?.PATH_POLICY).toBe(
      "${{ inputs.dependency_policy == 'include-lockfile' && 'tools-update-lockfile' || 'tools-update' }}",
    );
    expect(publish.env?.PUBLISH_PR).toBe('true');
    expect(publish.env?.RESULT_DIGEST).toBe(
      '${{ needs.run.outputs.result_digest }}',
    );
    expect(
      step(jobs.publish ?? {}, 'Download the run result').with?.[
        'artifact-ids'
      ],
    ).toBe('${{ needs.run.outputs.result_artifact_id }}');
  });

  it('shares the resolve job with run-agent.yml and scopes the target tokens the same way', async () => {
    const tools = await toolsUpdate();
    const agent = await runAgent();
    expect(normalize(tools.jobs.resolve)).toBe(normalize(agent.jobs.resolve));
    expect(targetTokenUses(tools.jobs)).toEqual({
      'resolve/Resolve the target repository, commit and base': [
        'AGENT_CI_TARGET_READ_TOKEN',
        'AGENT_CI_TARGET_TOKEN',
      ],
      'run/Check out the target repository': ['AGENT_CI_TARGET_READ_TOKEN'],
      'publish/Check out the target repository': ['AGENT_CI_TARGET_TOKEN'],
      'publish/Publish': ['AGENT_CI_TARGET_TOKEN'],
    });
    const checkout = step(
      tools.jobs.run ?? {},
      'Check out the target repository',
    );
    expect(checkout.with?.token).toBe(READ_SCOPED);
    expect(checkout.with?.['persist-credentials']).toBe(false);
    expect(step(tools.jobs.publish ?? {}, 'Publish').env?.GITHUB_TOKEN).toBe(
      WRITE_SCOPED,
    );
  });
});

describe('use-case wrappers', () => {
  for (const [file, preset] of [
    ['.github/workflows/docs-update.yml', PRESETS['docs-update']],
    [
      '.github/workflows/instructions-update.yml',
      PRESETS['instructions-update'],
    ],
  ] as const) {
    it(`${file} calls run-agent.yml with the ${preset.name} preset's identity, packs and policy`, async () => {
      const workflow = await load(file);
      expect(Object.keys(workflow.on)).toEqual(['workflow_call']);
      expect(workflow.permissions).toEqual({ contents: 'read' });
      const job = workflow.jobs.run as CallJob;
      expect(job.uses).toBe('./.github/workflows/run-agent.yml');
      expect(job.permissions).toEqual({
        contents: 'write',
        'pull-requests': 'write',
      });
      expect(job.with).toMatchObject({
        preset: preset.name,
        use_case: preset.useCase,
        mode: preset.mode,
        output_contract: preset.outputContract,
        path_policy: preset.name,
        publish_pr: true,
        target_ref: '${{ inputs.base }}',
        publish_base: '${{ inputs.base }}',
      });
      expect(job.with?.prompt).toBeUndefined();
      const inputs = (
        workflow.on.workflow_call as {
          inputs: Record<string, { default?: unknown }>;
        }
      ).inputs;
      expect(inputs.skills_oat_packs?.default).toBe(preset.skillsOatPacks);
      expect(inputs.pr_title?.default).toBe(preset.prTitle);
      // Explicit secrets, each mapped to itself (never inherit).
      expect(job.secrets).not.toBe('inherit');
      for (const [name, value] of Object.entries(job.secrets ?? {})) {
        expect(value).toBe(`\${{ secrets.${name} }}`);
      }
    });
  }
});

describe('fan-out.yml', () => {
  it('selects targets in a read-only job, refusing fork pull requests', async () => {
    const { jobs, permissions } = await fanOut();
    expect(permissions).toEqual({ contents: 'read' });
    const targets = jobs.targets ?? {};
    expect(targets.permissions).toEqual({ contents: 'read' });
    expect(targets.if).toBe(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    );
    const select = step(targets, 'Select the target matrix');
    expect(select.run).toContain('agent-ci targets matrix --root caller');
    expect(select.run).toContain('--github-output');
    expect(
      step(targets, 'Check out the calling repository (targets file)').with?.[
        'persist-credentials'
      ],
    ).toBe(false);
    for (const ref of secretRefs(targets)) {
      expect(ref).toBe('AGENT_CI_SOURCE_TOKEN');
    }
  });

  it('calls run-agent.yml or tools-update.yml once per matrix entry, mapping every field to an input', async () => {
    const { jobs } = await fanOut();
    const agent = jobs.agent as CallJob;
    const tools = jobs.tools as CallJob;
    expect(agent.uses).toBe('./.github/workflows/run-agent.yml');
    expect(tools.uses).toBe('./.github/workflows/tools-update.yml');
    expect(agent.if).toBe("inputs.preset != 'tools-update'");
    expect(tools.if).toBe("inputs.preset == 'tools-update'");
    for (const job of [agent, tools]) {
      expect(job.needs).toBe('targets');
      expect(job.steps).toBeUndefined();
      expect(job.strategy).toMatchObject({
        'fail-fast': false,
        matrix: '${{ fromJSON(needs.targets.outputs.matrix) }}',
      });
      expect(job.concurrency).toEqual({
        group: 'agent-ci-${{ matrix.use_case }}-${{ matrix.id }}',
        'cancel-in-progress': false,
      });
      expect(job.permissions).toEqual({
        contents: 'write',
        'pull-requests': 'write',
      });
    }
    // Every matrix reference names a field the targets command emits.
    const fields: (keyof MatrixEntry)[] = [
      'id',
      'repository',
      'base',
      'preset',
      'use_case',
      'model',
      'harness',
      'route',
      'mode',
      'output_contract',
      'skills_oat_packs',
      'setup_command',
      'publish_branch',
      'pr_title',
      'path_policy',
      'timeout_minutes',
      'max_attempts',
      'artifact_name',
      'adopt_branch',
      'oat_cli_version',
      'dependency_policy',
    ];
    const text = JSON.stringify([agent, tools]);
    for (const match of text.matchAll(/(?<![\w.])matrix\.([a-z_]+)/gu)) {
      expect(fields).toContain(match[1]);
    }
    expect(agent.with).toMatchObject({
      target_repository: '${{ matrix.repository }}',
      target_ref: '${{ matrix.base }}',
      publish_base: '${{ matrix.base }}',
      preset: '${{ matrix.preset }}',
      path_policy: '${{ matrix.path_policy }}',
      adopt_branch: '${{ matrix.adopt_branch }}',
      publish_pr: true,
    });
    expect(tools.with).toMatchObject({
      target_repository: '${{ matrix.repository }}',
      base: '${{ matrix.base }}',
      dependency_policy: '${{ matrix.dependency_policy }}',
    });
    // The deterministic job gets no model credential.
    expect(Object.keys(tools.secrets ?? {}).toSorted()).toEqual([
      'AGENT_CI_NOTIFY_WEBHOOK',
      'AGENT_CI_SOURCE_TOKEN',
      'AGENT_CI_TARGET_READ_TOKEN',
      'AGENT_CI_TARGET_TOKEN',
    ]);
    for (const job of [agent, tools]) {
      for (const [name, value] of Object.entries(job.secrets ?? {})) {
        expect(value).toBe(`\${{ secrets.${name} }}`);
      }
    }
  });
});

describe('agent-ci-fanout-selftest.yml', () => {
  it('runs fan-out.yml with the fake harness for same-repository labeled PRs only, without secrets', async () => {
    const workflow = await load(
      '.github/workflows/agent-ci-fanout-selftest.yml',
    );
    expect(Object.keys(workflow.on)).toEqual([
      'pull_request',
      'workflow_dispatch',
    ]);
    const job = workflow.jobs['fan-out'] as CallJob;
    expect(job.uses).toBe('./.github/workflows/fan-out.yml');
    expect(job.with).toMatchObject({
      preset: 'docs-update',
      targets_file: 'targets.yaml',
      model: 'fake-edit',
    });
    expect(job.secrets).toBeUndefined();
    expect(job.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(job.if).toContain("'agent-ci-fanout-selftest'");
    expect(job.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
  });
});

describe('fleet and consumer templates', () => {
  it('pin the reusable workflows, grant the publish scopes and pass explicit secrets', async () => {
    const cases: [string, string, string[]][] = [
      [
        'consumer-workflows/agent-ci-fleet.yml',
        'fan-out.yml',
        [
          'AGENT_CI_SOURCE_TOKEN',
          'AGENT_CI_TARGET_TOKEN',
          'AGENT_CI_TARGET_READ_TOKEN',
          'CLAUDE_CODE_OAUTH_TOKEN',
        ],
      ],
      [
        'consumer-workflows/agent-ci-docs-update.yml',
        'docs-update.yml',
        ['AGENT_CI_SOURCE_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      ],
      [
        'consumer-workflows/agent-ci-tools-update.yml',
        'tools-update.yml',
        ['AGENT_CI_SOURCE_TOKEN'],
      ],
    ];
    for (const [file, called, secrets] of cases) {
      const workflow = await load(file);
      expect(Object.keys(workflow.on), file).toEqual([
        'schedule',
        'workflow_dispatch',
      ]);
      expect(workflow.permissions, file).toEqual({
        contents: 'write',
        'pull-requests': 'write',
      });
      const [job] = Object.values(workflow.jobs);
      expect(job?.uses, file).toMatch(
        new RegExp(
          `^tkstang/agent-ci/\\.github/workflows/${called.replace('.', '\\.')}@`,
          'u',
        ),
      );
      expect(Object.keys(job?.secrets ?? {}), file).toEqual(secrets);
    }
  });

  it('are all linted by CI', async () => {
    const ci = await load('.github/workflows/ci.yml');
    const steps = JSON.stringify(ci.jobs.actionlint?.steps);
    for (const file of (await allWorkflowFiles()).filter((name) =>
      name.startsWith('consumer-workflows/'),
    )) {
      expect(steps).toContain(file);
    }
  });
});

describe('workflow class sweep', () => {
  it('keeps every expression out of run scripts and every script short', async () => {
    for (const file of await allWorkflowFiles()) {
      const workflow = await load<Workflow>(file);
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        for (const entry of job.steps ?? []) {
          if (entry.run === undefined) continue;
          const where = `${file} ${jobName}/${entry.name ?? ''}`;
          expect(entry.run, where).not.toContain('${{');
          expect(
            entry.run.trim().split('\n').length,
            where,
          ).toBeLessThanOrEqual(12);
        }
      }
    }
  });

  it('uses matrix values only as reusable-workflow inputs, job names and concurrency groups', async () => {
    for (const file of await allWorkflowFiles()) {
      const workflow = await load<Workflow>(file);
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const {
          with: _with,
          name: _name,
          concurrency: _group,
          ...rest
        } = job as CallJob;
        const leaked =
          JSON.stringify(rest).match(/(?<![\w.])matrix\.[a-z_]+/gu) ?? [];
        expect(leaked, `${file} ${jobName}`).toEqual([]);
      }
    }
  });

  it('references a write-capable target token only in resolve and publish jobs', async () => {
    for (const file of await allWorkflowFiles()) {
      const workflow = await load<Workflow>(file);
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (job.uses !== undefined) continue;
        for (const entry of job.steps ?? []) {
          if (secretRefs(entry).includes('AGENT_CI_TARGET_TOKEN')) {
            expect(['resolve', 'publish'], `${file} ${jobName}`).toContain(
              jobName,
            );
          }
        }
      }
    }
  });

  it('never passes secrets: inherit to a reusable workflow', async () => {
    for (const file of await allWorkflowFiles()) {
      const text = await readFile(path.join(PACKAGE_ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/secrets:\s*inherit/u);
    }
  });
});
