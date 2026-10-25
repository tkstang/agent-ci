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

/**
 * The OAT skills are user-invocable only (`disable-model-invocation`), so a
 * harness may refuse to load them as tools; the agent reads them as files
 * from the per-run home instead (pntr's Cursor runs read them the same way).
 */
function skillsSection(names: readonly string[]): string[] {
  return [
    'Skills:',
    `- ${names.join(' and ')} are installed for this run at user scope.`,
    `- Read each one's instructions from $HOME/.agents/skills/<skill>/SKILL.md (its references/ and scripts/ sit beside it) and follow them directly; they are user-invocable only, so do not wait for a skill tool to load them.`,
    '- A missing repository copy under .agents/skills is expected.',
    '- When a step needs a command you are not allowed to run, do that step from the repository files instead and report what you skipped in the structured result.',
  ];
}

function docsUpdatePrompt(context: PromptContext): string {
  return [
    'Run the OAT docs update maintenance workflow for this checked-out repository.',
    '',
    'Sequence:',
    '1. Follow the oat-docs-analyze skill first and write its analysis artifact. Use subagents when appropriate for parallelization.',
    '2. Then follow the oat-docs-apply skill against the analysis artifact from step 1.',
    '',
    ...skillsSection(['oat-docs-analyze', 'oat-docs-apply']),
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
    '- The publisher refuses any change outside documentation files (Markdown, MDX and assets under docs directories, root-level Markdown, AGENTS.md, CLAUDE.md and GEMINI.md) and the OAT tracking and analysis artifacts, and refuses executables and symlinks.',
    '',
    ...footer(context),
  ].join('\n');
}

function instructionsUpdatePrompt(context: PromptContext): string {
  return [
    'Run the OAT agent instructions maintenance workflow for this checked-out repository.',
    '',
    'Sequence:',
    '1. Follow the oat-agent-instructions-analyze skill first and write its analysis artifact and companion bundle.',
    '2. Then follow the oat-agent-instructions-apply skill against the companion bundle written in step 1.',
    '',
    ...skillsSection([
      'oat-agent-instructions-analyze',
      'oat-agent-instructions-apply',
    ]),
    '',
    ...TRACKING,
    '',
    ...APPLY_POLICY,
    '',
    'Agent boundary:',
    ...AGENT_BOUNDARY,
    '- The publisher refuses any change outside instruction files (AGENTS.md, CLAUDE.md, GEMINI.md), rules directories, Copilot instructions and the OAT tracking and analysis artifacts; settings, hooks, permission and MCP files, skills and agent, command or prompt definitions are always refused.',
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

/** Agent and tool configuration directories, at any depth (skills, agents, commands, hooks, settings). */
const PROVIDER_DIRS =
  /(?:^|\/)\.(?:agents|claude|codex|cursor|gemini|windsurf|opencode)\//u;
/** OAT files the agent presets write: tracking and analysis artifacts only. */
const OAT_ARTIFACTS = [
  /^\.oat\/tracking\.json$/u,
  /^\.oat\/repo\/analysis\/(?:[^/]+\/)*[^/]+\.(?:md|json)$/u,
];
/** Instruction file names allowed anywhere outside a denied tree. */
const INSTRUCTION_FILES = /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/u;

/**
 * Configuration a later agent or tool run executes or that widens its
 * permissions, denied for both agent presets: settings, hooks, CLI
 * permission files, MCP configuration, skills (and their scripts), agent,
 * command and prompt definitions, OAT scripts and CI.
 */
const EXECUTED_CONFIG = [
  /(?:^|\/)settings[^/]*\.json$/u,
  /(?:^|\/)hooks?(?:\/|\.json$)/u,
  /^\.cursor\/cli\.json$/u,
  /^\.codex\/config\.toml$/u,
  /(?:^|\/)\.?mcp\.json$/u,
  /(?:^|\/)skills\//u,
  /(?:^|\/)(?:agents|commands|prompts)\//u,
  /^\.oat\/scripts\//u,
  /^\.github\/workflows\//u,
];

/** Files `oat tools update` manages: OAT trees, provider views, root git metadata. */
const TOOLS_PATHS = [
  /^\.oat\//u,
  /^\.cursor\//u,
  /^\.claude\//u,
  /^\.agents\//u,
  /^\.codex\/agents\//u,
  /^\.git(?:ignore|attributes)$/u,
];
const LOCKFILES =
  /^(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/u;

/**
 * The publish-time path policies, ported from pntr's wrapper defaults and
 * narrowed to the files each preset exists to change:
 *
 * - docs-update: Markdown/MDX and documentation assets under any `docs`
 *   tree, root-level Markdown, instruction files (AGENTS.md, CLAUDE.md,
 *   GEMINI.md) anywhere, and the OAT tracking and analysis artifacts. Never
 *   agent or tool configuration directories, `.github/`, executables or
 *   symlinks.
 * - instructions-update: instruction files, rules directories
 *   (`.claude/rules`, `.cursor/rules`, `.agents/rules`, `.windsurf/rules`),
 *   Copilot instructions and the OAT artifacts. Never settings, hooks,
 *   permission or MCP files, skills, agent/command/prompt definitions, OAT
 *   scripts, CI, executables or symlinks.
 * - tools-update: OAT-managed trees and root git metadata (the deterministic
 *   OAT CLI writes scripts and provider-view symlinks), plus lockfiles when
 *   allowed.
 */
export const PATH_POLICIES: Readonly<Record<PathPolicyName, PathPolicy>> =
  Object.freeze({
    'docs-update': {
      allow: [
        /^(?:[^/]+\/)*docs\/(?:[^/]+\/)*[^/]+\.(?:md|mdx|png|jpe?g|gif|svg|webp|json|ya?ml)$/u,
        /^[^/]+\.mdx?$/u,
        INSTRUCTION_FILES,
        ...OAT_ARTIFACTS,
      ],
      // Not EXECUTED_CONFIG's generic segment rules: `docs/hooks/` or
      // `docs/agents/` pages are documentation; configuration directories
      // are refused at any depth instead.
      deny: [
        PROVIDER_DIRS,
        /^\.github\//u,
        /(?:^|\/)\.?mcp\.json$/u,
        /^\.oat\/scripts\//u,
      ],
      executables: false,
      symlinks: false,
    },
    'instructions-update': {
      allow: [
        INSTRUCTION_FILES,
        /^\.(?:claude|agents|windsurf)\/rules\/(?:[^/]+\/)*[^/]+\.md$/u,
        /^\.cursor\/rules\/(?:[^/]+\/)*[^/]+\.mdc?$/u,
        /^\.github\/copilot-instructions\.md$/u,
        /^\.github\/instructions\/(?:[^/]+\/)*[^/]+\.instructions\.md$/u,
        ...OAT_ARTIFACTS,
      ],
      deny: EXECUTED_CONFIG,
      executables: false,
      symlinks: false,
    },
    'tools-update': {
      allow: TOOLS_PATHS,
      deny: [],
      executables: true,
      symlinks: true,
    },
    'tools-update-lockfile': {
      allow: [...TOOLS_PATHS, LOCKFILES],
      deny: [],
      executables: true,
      symlinks: true,
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
