import { RUN_MODES } from '@agent-ci/harness/types.js';
import { DEFAULT_BRANCH_PREFIX } from '@agent-ci/publish/static-branch.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import { isBranchName } from '@agent-ci/review/trigger.js';
import { HARNESS_IDS } from '@agent-ci/routing/schema.js';
import {
  DEPENDENCY_POLICIES,
  PRESET_NAMES,
} from '@agent-ci/use-cases/presets.js';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * `targets.yaml`: the repositories a fan-out run covers.
 * Every value becomes a reusable-workflow input, so each one is validated
 * here to a closed, single-purpose shape: identifiers are artifact-safe,
 * repositories and branches follow GitHub's and git's rules, and models
 * resolve under the routing policy before any job starts.
 */

/** The hard bound on combined targets and per matrix. */
export const MAX_TARGETS = 50;
const MAX_TARGETS_JSON_BYTES = 256 * 1024;

/** Artifact-, concurrency- and job-name-safe target id. */
export const TARGET_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
/** A GitHub account or organization name. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
/** A GitHub repository name (never `.` or `..`). */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const MODEL_OR_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OAT_VERSION = /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const OAT_PACKS = /^[a-z0-9-]+(?:,[a-z0-9-]+)*$/u;

/** True for `owner/name` that GitHub could hold. */
export function isRepository(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner = '', name = ''] = parts;
  return (
    OWNER.test(owner) && REPO_NAME.test(name) && name !== '.' && name !== '..'
  );
}

const singleLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) =>
        value.trim() !== '' && !/[\r\n]/u.test(value) && !value.includes('\0'),
      { message: 'must be one non-empty line' },
    );

const Branch = z.string().refine(isBranchName, 'not a valid branch name');

export const TargetInputsSchema = z.strictObject({
  /** Trusted setup command run in run-agent.yml's credential-free setup job. */
  setupCommand: z
    .string()
    .max(2000)
    .refine((value) => !value.includes('\0'), 'must not contain NUL')
    .optional(),
  /** Replaces the preset's OAT packs. */
  skillsOatPacks: z.string().regex(OAT_PACKS).optional(),
  timeoutMinutes: z.number().int().min(1).max(360).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  /** tools-update: pinned `@open-agent-toolkit/cli` version. */
  oatCliVersion: z.string().regex(OAT_VERSION).optional(),
  /** tools-update: which changed files the run may publish. */
  dependencyPolicy: z.enum(DEPENDENCY_POLICIES).optional(),
  prTitle: singleLine(200).optional(),
  /** Static branch; must live under agent-ci/. */
  publishBranch: Branch.refine(
    (value) =>
      value.startsWith(DEFAULT_BRANCH_PREFIX) &&
      value.length > DEFAULT_BRANCH_PREFIX.length,
    `must live under ${DEFAULT_BRANCH_PREFIX}`,
  ).optional(),
});
export type TargetInputs = z.infer<typeof TargetInputsSchema>;

const RunSettings = {
  base: Branch.optional(),
  model: z.string().regex(MODEL_OR_ROUTE).optional(),
  harness: z.enum(HARNESS_IDS).optional(),
  route: z.string().regex(MODEL_OR_ROUTE).optional(),
  mode: z.enum(RUN_MODES).optional(),
  inputs: TargetInputsSchema.optional(),
};

export const TargetSchema = z.strictObject({
  /** Suppress CLI/model output and file lists in workflow logs. Not encryption. */
  private: z.boolean().optional(),
  id: z.string().regex(TARGET_ID),
  repository: z.string().refine(isRepository, 'not an owner/name repository'),
  /** Presets this target takes part in (default: every preset). */
  useCases: z.array(z.enum(PRESET_NAMES)).min(1).optional(),
  ...RunSettings,
});
export type Target = z.infer<typeof TargetSchema>;

export const TargetsFileSchema = z.strictObject({
  version: z.literal(1),
  /** When set, every target repository must belong to one of these owners. */
  allowedOwners: z.array(z.string().regex(OWNER)).min(1).optional(),
  defaults: z.strictObject(RunSettings).optional(),
  targets: z.array(TargetSchema).min(1).max(MAX_TARGETS),
});
export type TargetsFile = z.infer<typeof TargetsFileSchema>;

const fileError = (message: string) =>
  failure(
    'E_TARGETS_CONFIG',
    message,
    'Fix targets.yaml; run agent-ci targets validate.',
  );

function parseYaml(text: string): Result<unknown> {
  try {
    return success(parse(text) as unknown);
  } catch (err) {
    return fileError(
      `targets file is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
  }
}

/** Check the complete document once: schema, unique ids and repositories, owners. */
function validateTargetsDocument(raw: unknown): Result<TargetsFile> {
  const parsed = TargetsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
    return fileError(`targets file is invalid: ${issues.join('; ')}`);
  }
  const file = parsed.data;
  const ids = new Set<string>();
  const repositories = new Set<string>();
  for (const target of file.targets) {
    if (ids.has(target.id)) {
      return fileError(`duplicate target id ${target.id}`);
    }
    ids.add(target.id);
    const repository = target.repository.toLowerCase();
    if (repositories.has(repository)) {
      return fileError(
        `duplicate target repository ${target.repository}: one target per repository (each publishes to the same static branches)`,
      );
    }
    repositories.add(repository);
    const owner = repository.split('/')[0] ?? '';
    if (
      file.allowedOwners !== undefined &&
      !file.allowedOwners.some((allowed) => allowed.toLowerCase() === owner)
    ) {
      return fileError(
        `target ${target.id} (${target.repository}) is outside allowedOwners`,
      );
    }
  }
  return success(file);
}

/** Parse and check a standalone targets file; empty target lists are invalid. */
export function parseTargetsFile(text: string): Result<TargetsFile> {
  const parsed = parseYaml(text);
  return parsed.ok ? validateTargetsDocument(parsed.value) : parsed;
}

/** Append JSON entries to YAML policy/defaults, then validate the full document. */
export function parseTargetsSources(
  yaml: string | undefined,
  targetsJson: string | undefined,
): Result<TargetsFile> {
  let additions: unknown[] = [];
  if (targetsJson !== undefined) {
    if (Buffer.byteLength(targetsJson, 'utf8') > MAX_TARGETS_JSON_BYTES) {
      return fileError(`targets JSON exceeds ${MAX_TARGETS_JSON_BYTES} bytes`);
    }
    if (targetsJson.trim() !== '') {
      let raw: unknown;
      try {
        raw = JSON.parse(targetsJson) as unknown;
      } catch {
        return fileError('targets JSON is not valid JSON');
      }
      if (!Array.isArray(raw)) {
        return fileError('targets JSON must be an array of target entries');
      }
      additions = raw;
    }
  }
  const parsed =
    yaml === undefined
      ? success<unknown>({ version: 1, targets: [] })
      : parseYaml(yaml);
  if (!parsed.ok) return parsed;
  const raw = parsed.value;
  // Do not let additions repair a malformed YAML document or targets field.
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('targets' in raw) ||
    !Array.isArray(raw.targets)
  ) {
    return validateTargetsDocument(raw);
  }
  return validateTargetsDocument({
    ...raw,
    targets: [...raw.targets, ...additions],
  });
}
