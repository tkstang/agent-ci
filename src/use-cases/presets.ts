import type { OutputContract } from '@agent-ci/contracts/run-result.js';
import type { RunMode } from '@agent-ci/harness/types.js';
import { DEFAULT_BRANCH_PREFIX } from '@agent-ci/publish/static-branch.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import type { PathPolicy } from '@agent-ci/use-cases/policy.js';

/**
 * The use-case wrappers, ported from pntr's OAT maintenance wrappers
 * (voxmedia/pntr@e438668, `scripts/github-actions/oat-*`): each preset owns
 * its prompt, run identity, output contract, OAT skill packs and the path
 * policy the publish job enforces. Consumers select a preset; they never
 * copy the prompt (pntr's prompt-ownership rule).
 *
 * `docs-update` and `instructions-update` run an agent through run-agent.yml;
 * `tools-update` is deterministic (no model, no credential) and runs
 * `agent-ci tools-update` instead.
 */

export const PRESET_NAMES = [
  'docs-update',
  'instructions-update',
  'tools-update',
] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const DEPENDENCY_POLICIES = ['skills-only', 'include-lockfile'] as const;
export type DependencyPolicy = (typeof DEPENDENCY_POLICIES)[number];

/** Publish-time path policies: one per preset, plus the lockfile variant. */
export const PATH_POLICY_NAMES = [
  'docs-update',
  'instructions-update',
  'tools-update',
  'tools-update-lockfile',
] as const;
export type PathPolicyName = (typeof PATH_POLICY_NAMES)[number];

export interface PromptContext {
  readonly targetRepo: string;
  readonly baseBranch: string;
  readonly staticBranch: string;
}

export interface Preset {
  readonly name: PresetName;
  /** Run identity (`run-result.json` useCase) and default static branch suffix. */
  readonly useCase: string;
  readonly kind: 'agent' | 'deterministic';
  readonly outputContract: OutputContract;
  readonly mode: RunMode;
  /** OAT packs installed into the per-job home (agent presets). */
  readonly skillsOatPacks: string;
  readonly prTitle: string;
  /** Agent presets only. */
  readonly prompt?: (context: PromptContext) => string;
}

const AGENT_BOUNDARY = [
  '- Do not run git commands other than the read-only git commands that .oat/scripts/resolve-tracking.sh runs.',
  '- Do not use gh.',
  '- Do not create branches.',
  '- Do not push.',
  '- Do not open or update pull requests.',
  '- Do not post notifications.',
];

const TRACKING = [
  'Tracking:',
  '- When .oat/scripts/resolve-tracking.sh exists, treat it as the source of truth for tracking and delta behavior.',
  '- Do not reimplement OAT tracking manifest behavior or invent a separate last-run manifest.',
  '- After applying changes, run .oat/scripts/resolve-tracking.sh (when it exists) so .oat/tracking.json records lastRunAt.',
  '- That helper may run read-only git commands. Those commands are allowed.',
];

const APPLY_POLICY = [
  'Apply policy:',
  '- Treat this workflow configuration as approval to apply all recommendations from the just-written analysis artifact.',
  '- Skip a recommendation only when it is genuinely ambiguous, contradicted by current repo state, or requires owner judgment.',
  '- If a recommendation requires live user input, skip it and report it in the structured result.',
];

function footer(context: PromptContext): string[] {
  return [
    `Target repository: ${context.targetRepo}`,
    `Base branch: ${context.baseBranch}`,
    `Static branch handled by the agent-ci publisher: ${context.staticBranch}`,
  ];
}

function docsUpdatePrompt(context: PromptContext): string {
  return [
    'Run the OAT docs update maintenance workflow for this checked-out repository.',
    '',
    'Sequence:',
    '1. Use the oat-docs-analyze skill first and write its analysis artifact. Use subagents when appropriate for parallelization.',
    '2. Then use the oat-docs-apply skill against the analysis artifact from step 1.',
    '',
    'Skills:',
    '- oat-docs-analyze and oat-docs-apply are installed for this run at user scope.',
    '- Use those installed skills. A missing repository copy under .agents/skills is expected.',
    '',
    ...TRACKING,
    '',
    'Verification:',
    '- Dependencies are installed before this step when the workflow configured a setup command.',
    '- After applying documentation changes, run the docs lint and format checks whenever those commands are available.',
    '- Do not install dependencies yourself.',
    '',
    ...APPLY_POLICY,
    '',
    'Agent boundary:',
    '- Do not create, edit, delete, move, or regenerate agent skills or provider skill mirrors.',
    '- Do not create helper scripts, audit tools, CI checks, or other non-documentation files.',
    '- Edit existing docs-tree content, tracked Markdown, and OAT tracking only.',
    ...AGENT_BOUNDARY,
    '- The publisher refuses changes outside docs directories, Markdown files, OAT tracking and agent instruction views.',
    '',
    ...footer(context),
  ].join('\n');
}

function instructionsUpdatePrompt(context: PromptContext): string {
  return [
    'Run the OAT agent instructions maintenance workflow for this checked-out repository.',
    '',
    'Sequence:',
    '1. Use the oat-agent-instructions-analyze skill first and write its analysis artifact and companion bundle.',
    '2. Then use the oat-agent-instructions-apply skill against the companion bundle written in step 1.',
    '',
    'Skills:',
    '- oat-agent-instructions-analyze and oat-agent-instructions-apply are installed for this run at user scope.',
    '- Use those installed skills. A missing repository copy under .agents/skills is expected.',
    '',
    ...TRACKING,
    '',
    ...APPLY_POLICY,
    '',
    'Agent boundary:',
    ...AGENT_BOUNDARY,
    '- The publisher refuses changes outside agent instruction files (AGENTS.md, CLAUDE.md, GEMINI.md), provider views and OAT tracking.',
    '',
    ...footer(context),
  ].join('\n');
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = Object.freeze({
  'docs-update': {
    name: 'docs-update',
    useCase: 'oat-docs-update',
    kind: 'agent',
    outputContract: 'changes',
    mode: 'edit',
    skillsOatPacks: 'core,docs',
    prTitle: 'agent-ci: OAT docs update',
    prompt: docsUpdatePrompt,
  },
  'instructions-update': {
    name: 'instructions-update',
    useCase: 'oat-agent-instructions-update',
    kind: 'agent',
    outputContract: 'changes',
    mode: 'edit',
    skillsOatPacks: 'core,docs',
    prTitle: 'agent-ci: OAT agent instructions update',
    prompt: instructionsUpdatePrompt,
  },
  'tools-update': {
    name: 'tools-update',
    useCase: 'oat-tools-update',
    kind: 'deterministic',
    outputContract: 'changes',
    mode: 'edit',
    skillsOatPacks: '',
    prTitle: 'agent-ci: OAT tools update',
  },
});

const PROVIDER_VIEWS = [
  '.agents/',
  '.claude/',
  '.codex/',
  '.cursor/',
  '.gemini/',
  '.github/agents/',
  '.github/instructions/',
  '.github/skills/',
  '.oat/',
];

const SKILL_TREES = [
  '.agents/skills/',
  '.claude/skills/',
  '.codex/skills/',
  '.cursor/skills/',
  '.gemini/skills/',
  '.github/skills/',
];

/**
 * Code a later run executes: the OAT tracking helper (agents run it with the
 * model credential in their environment) and CI. Only tools-update, which
 * runs no agent, may refresh OAT scripts.
 */
const EXECUTABLE_TREES = ['.oat/scripts/', '.github/workflows/'];

const TOOLS_PATHS = [
  '.oat/',
  '.cursor/',
  '.claude/',
  '.agents/',
  '.codex/agents/',
];
/** Root git metadata that `oat tools update` rewrites inside OAT-managed blocks. */
const MANAGED_GIT_METADATA = ['.gitignore', '.gitattributes'];
const LOCKFILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
];

/**
 * The publish-time path policies, ported from pntr's wrapper defaults and
 * narrowed: docs updates may touch any `docs` directory, Markdown anywhere
 * and OAT tracking, never a skill tree, provider configuration or OAT script;
 * instruction updates may touch instruction files, provider views and OAT
 * tracking (`.github/` only by named subtree), never OAT scripts; tools
 * updates may touch OAT-managed trees and root git metadata, plus lockfiles
 * when allowed.
 */
export const PATH_POLICIES: Readonly<Record<PathPolicyName, PathPolicy>> =
  Object.freeze({
    'docs-update': {
      exact: [],
      prefixes: ['.oat/'],
      denyPrefixes: [...SKILL_TREES, ...EXECUTABLE_TREES],
      segments: ['docs'],
      extensions: ['.md', '.mdx'],
      basenames: [],
    },
    'instructions-update': {
      exact: ['.github/copilot-instructions.md'],
      prefixes: PROVIDER_VIEWS,
      denyPrefixes: EXECUTABLE_TREES,
      segments: [],
      extensions: [],
      basenames: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'],
    },
    'tools-update': {
      exact: MANAGED_GIT_METADATA,
      prefixes: TOOLS_PATHS,
      denyPrefixes: [],
      segments: [],
      extensions: [],
      basenames: [],
    },
    'tools-update-lockfile': {
      exact: [...MANAGED_GIT_METADATA, ...LOCKFILES],
      prefixes: TOOLS_PATHS,
      denyPrefixes: [],
      segments: [],
      extensions: [],
      basenames: [],
    },
  });

export function isPresetName(value: unknown): value is PresetName {
  return (
    typeof value === 'string' &&
    (PRESET_NAMES as readonly string[]).includes(value)
  );
}

export function isPathPolicyName(value: unknown): value is PathPolicyName {
  return (
    typeof value === 'string' &&
    (PATH_POLICY_NAMES as readonly string[]).includes(value)
  );
}

/** The publish policy of a preset (tools-update depends on its dependency policy). */
export function presetPathPolicy(
  name: PresetName,
  dependencyPolicy: DependencyPolicy = 'skills-only',
): PathPolicyName {
  if (name === 'tools-update' && dependencyPolicy === 'include-lockfile')
    return 'tools-update-lockfile';
  return name;
}

/** The static branch a preset publishes to when none is configured. */
export function presetBranch(preset: Preset): string {
  return `${DEFAULT_BRANCH_PREFIX}${preset.useCase}`;
}

/** The preset's prompt; deterministic presets have none. */
export function presetPrompt(
  name: PresetName,
  context: PromptContext,
): Result<string> {
  const preset = PRESETS[name];
  if (preset.prompt === undefined) {
    return failure(
      'E_INVALID_INPUT',
      `the ${name} preset is deterministic and has no prompt`,
      'Run it with agent-ci tools-update (tools-update.yml), not run-agent.yml.',
    );
  }
  for (const [field, value] of Object.entries(context)) {
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      /[\r\n]/u.test(value)
    ) {
      return failure(
        'E_INVALID_INPUT',
        `the prompt's ${field} must be one non-empty line`,
      );
    }
  }
  return success(`${preset.prompt(context)}\n`);
}
