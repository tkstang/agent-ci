import {
  type OutputContract,
  parseVerdictItems,
  type ValidatedRunResult,
  validateRunResult,
} from '@agent-ci/contracts/run-result.js';
import { assertSecretFree } from '@agent-ci/contracts/secret-guard.js';
import { failure, type Result } from '@agent-ci/result.js';

/**
 * Merge workflow-owned fields into an agent RunResult candidate, ported from
 * pntr's `finalizeRunResult` and `completeVerdictEnvelope`. Run identity comes
 * from trusted configuration, never from agent output; absent boilerplate is
 * filled, explicit malformed values are kept so validation fails closed.
 */

export interface FinalizeConfig {
  readonly useCase: string;
  readonly targetRepo: string;
  readonly outputContract: OutputContract;
  readonly verdictItems?: unknown;
  /** Workspace changes detected by the caller (for example from git). */
  readonly detectedChangedFiles?: readonly string[];
  /** Credential values the run could see. */
  readonly secrets: readonly string[];
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

function uniqueSorted(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].toSorted();
}

/** Fill an omitted verdict envelope from trusted config and the items. */
function completeVerdictEnvelope(
  record: Record<string, unknown>,
  config: FinalizeConfig,
): Record<string, unknown> {
  const requested = parseVerdictItems(config.verdictItems);
  const verdict = record.verdict as { items?: unknown } | undefined;
  if (!requested.ok || !Array.isArray(verdict?.items)) return record;
  const items = verdict.items as { status?: unknown }[];
  const passed = items.every((item) => item.status === 'pass');
  const count = (status: string) =>
    items.filter((item) => item.status === status).length;
  const absent = (field: string) => !Object.hasOwn(record, field);
  return {
    ...record,
    ...(absent('ok') ? { ok: passed } : {}),
    ...(absent('status') ? { status: passed ? 'no-op' : 'failed' } : {}),
    ...(absent('summary')
      ? {
          summary: `Verdict: ${count('pass')} of ${items.length} requested items passed (${count('fail')} fail, ${count('blocked')} blocked).`,
        }
      : {}),
  };
}

export function finalizeRunResult(
  candidate: unknown,
  config: FinalizeConfig,
): Result<ValidatedRunResult> {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  )
    return failure('E_INVALID_RUN_RESULT', 'run result must be an object');

  const record =
    config.outputContract === 'verdict'
      ? completeVerdictEnvelope(candidate as Record<string, unknown>, config)
      : (candidate as Record<string, unknown>);
  const merged: Record<string, unknown> = { ...record };

  if (nonEmpty(config.useCase)) merged.useCase = config.useCase.trim();
  if (nonEmpty(config.targetRepo)) merged.targetRepo = config.targetRepo.trim();

  const changedFiles = uniqueSorted([
    ...(Array.isArray(merged.changedFiles) ? merged.changedFiles : []),
    ...(config.detectedChangedFiles ?? []),
  ]);
  merged.changedFiles = changedFiles;

  if (merged.ok !== false && merged.status !== 'failed') {
    merged.status = changedFiles.length > 0 ? 'changed' : 'no-op';
  }
  if (!Object.hasOwn(merged, 'ok')) merged.ok = merged.status !== 'failed';
  for (const field of ['artifacts', 'materializedArtifacts', 'errors']) {
    if (!Object.hasOwn(merged, field)) merged[field] = [];
  }

  const guarded = assertSecretFree(merged, config.secrets);
  if (!guarded.ok) return guarded;

  return validateRunResult(merged, {
    outputContract: config.outputContract,
    verdictItems: config.verdictItems,
  });
}
