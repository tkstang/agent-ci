import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PACKAGE_ROOT } from '@agent-ci/paths.js';
import { parse } from 'yaml';

/**
 * Shared helpers for the workflow structure tests: typed views of a parsed
 * workflow, step lookup, and secret-reference scanning.
 */

export interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}
export interface Job {
  'runs-on'?: string;
  permissions?: Record<string, string>;
  needs?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  steps?: Step[];
}
export interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

export async function load<T = Workflow>(relative: string): Promise<T> {
  return parse(await readFile(path.join(PACKAGE_ROOT, relative), 'utf8')) as T;
}

export const runAgent = () => load('.github/workflows/run-agent.yml');
/** run-agent.yml's agent job, behind its own workflow_call boundary. */
export const agentJobWorkflow = () => load('.github/workflows/agent-job.yml');
export async function agentJob(): Promise<Job> {
  return (await agentJobWorkflow()).jobs.agent ?? {};
}

/** The static model-credential chain over the four model secrets. */
export function modelChain(source: string): string {
  return `\${{ ${MODEL_SECRETS.map(
    (secret) => `(${source} == '${secret}' && secrets.${secret})`,
  ).join(' || ')} || '' }}`;
}

export function step(job: Job, name: string): Step {
  const found = job.steps?.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
}

/** Every `${{ secrets.* }}` / `secrets[...]` reference in a value. */
export function secretRefs(value: unknown): string[] {
  const text = JSON.stringify(value ?? '');
  return [...text.matchAll(/secrets(?:\.([A-Z_]+)|\[)/gu)].map(
    (match) => match[1] ?? '[dynamic]',
  );
}

export const WRITE_SCOPED =
  "${{ needs.resolve.outputs.cross == 'true' && secrets.AGENT_CI_TARGET_TOKEN || github.token }}";
export const INNER_READ_SCOPED =
  "${{ inputs.cross == 'true' && secrets.AGENT_CI_TARGET_READ_TOKEN || github.token }}";
export const READ_SCOPED =
  "${{ needs.resolve.outputs.cross == 'true' && secrets.AGENT_CI_TARGET_READ_TOKEN || github.token }}";

/** job/step → target secrets it references. */
export function targetTokenUses(
  jobs: Record<string, Job>,
): Record<string, string[]> {
  const uses: Record<string, string[]> = {};
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const entry of job.steps ?? []) {
      const refs = secretRefs(entry).filter((ref) =>
        ref.startsWith('AGENT_CI_TARGET'),
      );
      if (refs.length > 0)
        uses[`${jobName}/${entry.name ?? ''}`] = refs.toSorted();
    }
  }
  return uses;
}

/** The write token: resolve and publish only; the read token: the code-running checkouts. */
export const TARGET_TOKEN_USES = {
  'resolve/Resolve the target repository, commit and base': [
    'AGENT_CI_TARGET_READ_TOKEN',
    'AGENT_CI_TARGET_TOKEN',
  ],
  'setup/Check out the target repository': ['AGENT_CI_TARGET_READ_TOKEN'],
  'publish/Check out the target repository': ['AGENT_CI_TARGET_TOKEN'],
  'publish/Publish': ['AGENT_CI_TARGET_TOKEN'],
};

export const MODEL_SECRETS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENCODE_API_KEY',
  'CURSOR_API_KEY',
  'AGENT_CI_PROXY_API_KEY',
];
