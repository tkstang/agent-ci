import { failure, success, type Result } from '@agent-ci/result.js';
import { z } from 'zod';

/**
 * The agent-ci RunResult contract, ported from pntr's
 * `run-result-contracts.ts` (voxmedia/pntr@06cd380) and expressed in Zod.
 * Unknown agent or workflow fields are preserved (loose objects); contract
 * blocks (`report`, `issues`, `verdict`) are only required to be well formed
 * for their own contract when the run did not fail.
 */

export const OUTPUT_CONTRACTS = [
  'report',
  'changes',
  'issues',
  'verdict',
] as const;
export type OutputContract = (typeof OUTPUT_CONTRACTS)[number];

export const RUN_STATUSES = ['changed', 'no-op', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const nonEmpty = z
  .string()
  .refine((value) => value.trim() !== '', { message: 'must be non-empty' });

export const RunArtifactSchema = z.looseObject({
  label: nonEmpty,
  path: nonEmpty,
  kind: z.enum(['file', 'directory']).optional(),
});
export type RunArtifact = z.infer<typeof RunArtifactSchema>;

export const MaterializedArtifactSchema = z
  .looseObject({
    label: nonEmpty,
    originalPath: nonEmpty,
    artifactPath: nonEmpty,
    kind: z.enum(['file', 'directory']).optional(),
    entryCount: z.number().int().min(0).optional(),
    byteCount: z.number().int().min(0).optional(),
  })
  .refine(
    (item) =>
      item.kind !== 'directory' ||
      (item.entryCount !== undefined && item.byteCount !== undefined),
    { message: 'directory artifacts need entryCount and byteCount' },
  );

export const RunReportSchema = z.looseObject({
  title: nonEmpty,
  markdown: nonEmpty,
});
export type RunReport = z.infer<typeof RunReportSchema>;

export const RunIssueSchema = z.looseObject({
  title: nonEmpty,
  body: nonEmpty,
  labels: z.array(z.string()),
  dedupeKey: nonEmpty,
});
export type RunIssue = z.infer<typeof RunIssueSchema>;

/** A trusted verdict requirement supplied by the caller. */
export const VerdictItemSchema = z.strictObject({
  id: nonEmpty,
  description: nonEmpty,
});
export type VerdictItem = z.infer<typeof VerdictItemSchema>;

export const VerdictResultItemSchema = z.strictObject({
  id: nonEmpty,
  status: z.enum(['pass', 'fail', 'blocked']),
  summary: nonEmpty,
  evidence: z.array(nonEmpty),
});
export type VerdictResultItem = z.infer<typeof VerdictResultItemSchema>;

export const RunResultSchema = z.looseObject({
  ok: z.boolean(),
  status: z.enum(RUN_STATUSES),
  useCase: nonEmpty,
  targetRepo: nonEmpty,
  summary: nonEmpty,
  artifacts: z.array(RunArtifactSchema),
  materializedArtifacts: z.array(MaterializedArtifactSchema),
  changedFiles: z.array(z.string()),
  errors: z.array(z.string()),
});
export type RunResult = z.infer<typeof RunResultSchema> & {
  report?: RunReport;
  issues?: RunIssue[];
  verdict?: { items: VerdictResultItem[] };
};

/** A RunResult tagged with the contract it was validated against. */
export type ValidatedRunResult = RunResult & { outputContract: OutputContract };

export interface RunResultOptions {
  /** Contract name; absent infers it from the result shape. */
  readonly outputContract?: string | undefined;
  /** Trusted verdict items, or their JSON text. */
  readonly verdictItems?: unknown;
}

const invalid = (message: string): Result<never> =>
  failure('E_INVALID_RUN_RESULT', message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOutputContract(value: unknown): value is OutputContract {
  return (
    typeof value === 'string' &&
    (OUTPUT_CONTRACTS as readonly string[]).includes(value)
  );
}

/** Parse trusted verdict items from an array or its JSON text. */
export function parseVerdictItems(value: unknown = []): Result<VerdictItem[]> {
  let items = value;
  if (typeof value === 'string') {
    try {
      items = value.trim() === '' ? [] : JSON.parse(value);
    } catch {
      return invalid('invalid trusted verdict items');
    }
  }
  const parsed = z.array(VerdictItemSchema).safeParse(items);
  if (!parsed.success) return invalid('invalid trusted verdict items');
  if (new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length)
    return invalid('invalid trusted verdict items');
  return success(parsed.data);
}

function scoredVerdictItems(
  verdict: unknown,
  options: RunResultOptions,
): Result<VerdictResultItem[]> {
  const requested = parseVerdictItems(options.verdictItems);
  if (!requested.ok) return requested;
  if (
    requested.value.length === 0 ||
    !isRecord(verdict) ||
    Object.keys(verdict).some((key) => key !== 'items') ||
    !Array.isArray(verdict.items)
  )
    return invalid('verdict items missing');
  const expected = new Set(requested.value.map((item) => item.id));
  const seen = new Set<string>();
  const items: VerdictResultItem[] = [];
  for (const raw of verdict.items) {
    const parsed = VerdictResultItemSchema.safeParse(raw);
    if (
      !parsed.success ||
      !expected.has(parsed.data.id) ||
      seen.has(parsed.data.id) ||
      (parsed.data.status !== 'blocked' && parsed.data.evidence.length === 0)
    )
      return invalid('invalid scored verdict item');
    seen.add(parsed.data.id);
    items.push(parsed.data);
  }
  if (seen.size !== expected.size)
    return invalid('requested verdict item missing');
  return success(items);
}

function inferContract(value: unknown): OutputContract {
  if (!isRecord(value)) return 'changes';
  if (value.report !== undefined) return 'report';
  if (value.issues !== undefined) return 'issues';
  if (value.verdict !== undefined) return 'verdict';
  return 'changes';
}

/** Validate an untrusted RunResult candidate against its contract. */
export function validateRunResult(
  value: unknown,
  options: RunResultOptions = {},
): Result<ValidatedRunResult> {
  const contract =
    options.outputContract === undefined || options.outputContract === ''
      ? inferContract(value)
      : options.outputContract;
  if (!isOutputContract(contract)) return invalid('unknown output contract');
  if (!isRecord(value)) return invalid('run result must be an object');

  const base = RunResultSchema.safeParse(value);
  if (!base.success) {
    const fields = [
      ...new Set(
        base.error.issues.map((issue) => String(issue.path[0] ?? '<root>')),
      ),
    ];
    return invalid(`run result has invalid fields: ${fields.join(', ')}`);
  }
  const failed = value.ok === false || value.status === 'failed';

  switch (contract) {
    case 'report':
      if (!failed && !RunReportSchema.safeParse(value.report).success)
        return invalid('report result is malformed');
      break;
    case 'issues':
      if (!failed && !z.array(RunIssueSchema).safeParse(value.issues).success)
        return invalid('issues result is malformed');
      break;
    case 'verdict': {
      const items = scoredVerdictItems(value.verdict, options);
      if (!items.ok) return items;
      const passed = items.value.every((item) => item.status === 'pass');
      const errors = value.errors as string[];
      if (
        value.ok !== passed ||
        (passed && errors.length !== 0) ||
        (passed
          ? !['changed', 'no-op'].includes(value.status as string)
          : value.status !== 'failed')
      )
        return invalid('contradictory verdict status');
      break;
    }
    case 'changes':
      break;
  }
  return success({ ...value, outputContract: contract } as ValidatedRunResult);
}

export interface FailedShapeOptions {
  readonly verdictItems?: unknown;
  readonly summary: string;
}

/** Contract-specific fields that make a failed result valid. */
export function failedContractShape(
  contract: OutputContract,
  options: FailedShapeOptions,
): Record<string, unknown> {
  switch (contract) {
    case 'report':
      return { report: { title: 'Runner failed', markdown: options.summary } };
    case 'issues':
      return { issues: [] };
    case 'verdict': {
      const items = parseVerdictItems(options.verdictItems);
      return {
        verdict: {
          items: (items.ok ? items.value : []).map(({ id }) => ({
            id,
            status: 'blocked',
            summary: options.summary,
            evidence: [],
          })),
        },
      };
    }
    case 'changes':
      return {};
  }
}

export interface FailedRunResultInput {
  readonly useCase?: string | undefined;
  readonly targetRepo?: string | undefined;
  readonly outputContract: OutputContract;
  readonly verdictItems?: unknown;
  readonly code: string;
  readonly message: string;
}

/** A contract-shaped failed RunResult; the message must already be masked. */
export function buildFailedRunResult(
  input: FailedRunResultInput,
): ValidatedRunResult {
  const summary = `Runner failed: ${input.message}`;
  return {
    ok: false,
    status: 'failed',
    useCase: input.useCase?.trim() || 'generic-prompt',
    targetRepo: input.targetRepo?.trim() || 'unknown',
    summary,
    artifacts: [],
    materializedArtifacts: [],
    changedFiles: [],
    errors: [`${input.code}: ${input.message}`],
    ...failedContractShape(input.outputContract, {
      verdictItems: input.verdictItems,
      summary,
    }),
    outputContract: input.outputContract,
  };
}
