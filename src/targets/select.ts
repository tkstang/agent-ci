import type { RunMode } from '@agent-ci/harness/types.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import { isBranchName } from '@agent-ci/review/trigger.js';
import { resolveRoute } from '@agent-ci/routing/resolve.js';
import type { ModelsFile } from '@agent-ci/routing/schema.js';
import {
  MAX_TARGETS,
  type Target,
  type TargetsFile,
} from '@agent-ci/targets/schema.js';
import {
  type PresetName,
  PRESETS,
  presetBranch,
  presetPathPolicy,
} from '@agent-ci/use-cases/presets.js';

/**
 * Turn a validated targets file into one GitHub Actions matrix for one
 * preset, after pntr's `selectOatDocsUpdateTargets`: `all` or one target (by
 * id or repository), a reset flag that only a single target may use, a hard
 * size bound, and every per-target value resolved here so the workflow
 * passes matrix fields straight into reusable-workflow inputs (never into a
 * script).
 */

export const ALL_TARGETS = 'all';
/** GitHub caps one step output at 1 MiB; stay well below it. */
export const MAX_MATRIX_BYTES = 512 * 1024;
const DEFAULT_OAT_CLI_VERSION = 'latest';

/** One matrix entry; keys are the reusable-workflow input names. */
export interface MatrixEntry {
  readonly id: string;
  readonly repository: string;
  readonly base: string;
  readonly preset: PresetName;
  readonly use_case: string;
  readonly model: string;
  readonly harness: string;
  readonly route: string;
  readonly mode: RunMode;
  readonly output_contract: string;
  readonly skills_oat_packs: string;
  readonly setup_command: string;
  readonly publish_branch: string;
  readonly pr_title: string;
  readonly path_policy: string;
  readonly timeout_minutes: number;
  readonly max_attempts: number;
  readonly artifact_name: string;
  /** The reset flag: replace a static branch's content whoever made its head (history kept). */
  readonly adopt_branch: boolean;
  readonly oat_cli_version: string;
  readonly dependency_policy: string;
}

export interface SelectOptions {
  readonly preset: PresetName;
  /** `all`, a target id, or an `owner/name` repository. */
  readonly target?: string;
  readonly reset?: boolean;
  /** Lower bound on the matrix size (at most {@link MAX_TARGETS}). */
  readonly maxTargets?: number;
  /** Override every selected target's base branch. */
  readonly base?: string;
  /** Override every selected target's model (agent presets). */
  readonly model?: string;
  readonly models: ModelsFile;
  /** Environment for the routing policy (CI refuses pool and login routes). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function participates(target: Target, preset: PresetName): boolean {
  return target.useCases === undefined || target.useCases.includes(preset);
}

function pick(
  file: TargetsFile,
  options: SelectOptions,
): Result<readonly Target[]> {
  const requested = (options.target ?? '').trim() || ALL_TARGETS;
  if (requested === ALL_TARGETS) {
    if (options.reset === true) {
      return failure(
        'E_TARGETS_RESET_ALL',
        'the reset flag requires selecting one target',
        'Pass --target <id> with --reset.',
      );
    }
    const selected = file.targets.filter((target) =>
      participates(target, options.preset),
    );
    if (selected.length === 0) {
      return failure(
        'E_TARGET_NOT_FOUND',
        `no target takes part in ${options.preset}`,
      );
    }
    return success(selected);
  }
  const lower = requested.toLowerCase();
  const found = file.targets.find(
    (target) =>
      target.id === requested || target.repository.toLowerCase() === lower,
  );
  if (found === undefined) {
    return failure('E_TARGET_NOT_FOUND', `unknown target ${requested}`);
  }
  if (!participates(found, options.preset)) {
    return failure(
      'E_TARGET_NOT_FOUND',
      `target ${found.id} does not take part in ${options.preset}`,
    );
  }
  return success([found]);
}

/** Build the matrix entries for one preset. */
export function selectTargets(
  file: TargetsFile,
  options: SelectOptions,
): Result<MatrixEntry[]> {
  const bound = options.maxTargets ?? MAX_TARGETS;
  if (!Number.isInteger(bound) || bound < 1 || bound > MAX_TARGETS) {
    return failure(
      'E_INVALID_INPUT',
      `the matrix bound must be between 1 and ${MAX_TARGETS}`,
    );
  }
  if (options.base !== undefined && !isBranchName(options.base)) {
    return failure('E_INVALID_INPUT', 'the base override is not a branch name');
  }
  const picked = pick(file, options);
  if (!picked.ok) return picked;
  if (picked.value.length > bound) {
    return failure(
      'E_TARGETS_LIMIT',
      `${picked.value.length} targets selected; the matrix bound is ${bound}`,
      'Select one target, or raise --max-targets (at most 50).',
    );
  }
  const preset = PRESETS[options.preset];
  const defaults = file.defaults ?? {};
  const entries: MatrixEntry[] = [];
  for (const target of picked.value) {
    const inputs = { ...defaults.inputs, ...target.inputs };
    const base = options.base ?? target.base ?? defaults.base;
    if (base === undefined) {
      return failure(
        'E_TARGETS_CONFIG',
        `target ${target.id} has no base branch (set base, or defaults.base)`,
      );
    }
    let model = '';
    let harness = '';
    let route = '';
    if (preset.kind === 'agent') {
      model = options.model ?? target.model ?? defaults.model ?? '';
      // A model override replaces the target's harness and route pins.
      harness =
        options.model === undefined
          ? (target.harness ?? defaults.harness ?? '')
          : '';
      route =
        options.model === undefined
          ? (target.route ?? defaults.route ?? '')
          : '';
      if (model === '' && route === '') {
        return failure(
          'E_TARGETS_CONFIG',
          `target ${target.id} has no model (set model, or defaults.model)`,
        );
      }
      const resolved = resolveRoute(options.models, {
        model: model === '' ? undefined : model,
        routeId: route === '' ? undefined : route,
        harness: harness === '' ? undefined : (harness as Target['harness']),
        allowPool: false,
        seedLogin: false,
        requireCredentials: false,
        env: options.env,
      });
      if (!resolved.ok) {
        return failure(
          'E_TARGETS_CONFIG',
          `target ${target.id}: ${resolved.message}`,
          resolved.hint,
        );
      }
    }
    const dependencyPolicy = inputs.dependencyPolicy ?? 'skills-only';
    entries.push({
      id: target.id,
      repository: target.repository,
      base,
      preset: preset.name,
      use_case: preset.useCase,
      model,
      harness,
      route,
      mode: target.mode ?? defaults.mode ?? preset.mode,
      output_contract: preset.outputContract,
      skills_oat_packs: inputs.skillsOatPacks ?? preset.skillsOatPacks,
      setup_command: inputs.setupCommand ?? '',
      publish_branch: inputs.publishBranch ?? presetBranch(preset),
      pr_title: inputs.prTitle ?? preset.prTitle,
      path_policy: presetPathPolicy(preset.name, dependencyPolicy),
      timeout_minutes: inputs.timeoutMinutes ?? 30,
      max_attempts: inputs.maxAttempts ?? 2,
      artifact_name: `agent-ci-${target.id}`,
      adopt_branch: options.reset === true,
      oat_cli_version: inputs.oatCliVersion ?? DEFAULT_OAT_CLI_VERSION,
      dependency_policy: dependencyPolicy,
    });
  }
  const size = Buffer.byteLength(JSON.stringify({ include: entries }), 'utf8');
  if (size > MAX_MATRIX_BYTES) {
    return failure(
      'E_TARGETS_LIMIT',
      `the matrix is ${size} bytes; the bound is ${MAX_MATRIX_BYTES}`,
    );
  }
  return success(entries);
}
