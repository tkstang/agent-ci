import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeOwnedFile } from '@agent-ci/files.js';
import type { Usage } from '@agent-ci/harness/types.js';
import { failure, type Result, success } from '@agent-ci/result.js';
import {
  ADJUDICATION_ANSWER_SCHEMA,
  ADJUDICATION_RESPONSES_SCHEMA,
  acceptAdjudicationAnswer,
  adjudicationRepairPrompt,
  type AdjudicatorPassInput,
  adjudicatorPrompt,
  buildAdjudicationSources,
  collectCandidates,
  promptCandidates,
} from '@agent-ci/review/adjudicate.js';
import type { Severity } from '@agent-ci/review/contracts.js';
import type { SourceReader } from '@agent-ci/review/diff-position.js';
import { resolveReviewRoute } from '@agent-ci/review/pass.js';
import type { ReviewSpecDocument } from '@agent-ci/review/prepare.js';
import { USE_CASE } from '@agent-ci/review/prompt.js';
import {
  adjudicatorTransport,
  type AdjudicatorTransport,
} from '@agent-ci/routing/adjudicator.js';
import type { HarnessId } from '@agent-ci/routing/schema.js';
import {
  type RepairOutcome,
  type RunDeps,
  runAgent,
} from '@agent-ci/run/execute.js';

/**
 * Run the adjudicator as a tool-free structured run (Claude/fake harness or
 * the narrow Sol Low Responses transport) in a
 * fresh empty scratch directory outside every checkout. Writes
 * `adjudication.json` (always: `completed` with the kept operations, or
 * `failed` with none) and `adjudicator.json` into the output directory,
 * plus the run core's result, log and prompt.
 */

export const ADJUDICATION_FILES = Object.freeze({
  adjudication: 'adjudication.json',
  record: 'adjudicator.json',
});

export type AdjudicatorRecord = {
  version: 1;
  status: 'completed' | 'failed' | 'skipped';
  reason: string | null;
  route: string | null;
  model: string;
  harness: HarnessId | null;
  transport: AdjudicatorTransport | null;
  repair: RepairOutcome | null;
  usage: Usage | null;
};

export type AdjudicatorOptions = {
  readonly spec: ReviewSpecDocument;
  readonly passes: readonly AdjudicatorPassInput[];
  readonly failOnSeverity: Severity | null;
  /** Trusted source at the captured SHAs. */
  readonly read: SourceReader;
  readonly outDir: string;
  readonly routeId?: string | undefined;
  readonly allowPool: boolean;
  readonly homeRoot?: string | undefined;
  readonly timeoutMs: number;
  readonly modelsPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentialFromEnv: boolean;
};

export async function runAdjudicator(
  options: AdjudicatorOptions,
  deps: RunDeps = {},
): Promise<Result<AdjudicatorRecord>> {
  const { spec } = options;
  if (!spec.request.adjudicator.enabled)
    return failure(
      'E_REVIEW_INPUT',
      'the adjudicator is not enabled for this request',
    );
  const model = spec.request.adjudicator.model;
  const candidates = collectCandidates(
    options.passes,
    {
      mode: spec.request.mode,
      base_sha: spec.base_sha,
      merge_base_sha: spec.merge_base_sha,
      head_sha: spec.head_sha,
    },
    options.failOnSeverity,
  );
  const write = async (record: AdjudicatorRecord, operations: unknown[]) => {
    await writeOwnedFile(
      path.join(options.outDir, ADJUDICATION_FILES.adjudication),
      `${JSON.stringify({ version: 1, status: record.status === 'failed' ? 'failed' : 'completed', operations }, null, 2)}\n`,
      0o644,
    );
    await writeOwnedFile(
      path.join(options.outDir, ADJUDICATION_FILES.record),
      `${JSON.stringify(record, null, 2)}\n`,
      0o644,
    );
  };
  if (!candidates.some((c) => !c.protected)) {
    // Nothing the adjudicator may reduce: spend nothing.
    const record: AdjudicatorRecord = {
      version: 1,
      status: 'skipped',
      reason: 'no reducible candidates',
      route: null,
      model,
      harness: null,
      transport: null,
      repair: null,
      usage: null,
    };
    await mkdir(options.outDir, { recursive: true });
    await write(record, []);
    return success(record);
  }
  const resolved = await resolveReviewRoute({
    model,
    routeId: options.routeId,
    allowPool: options.allowPool,
    seedLogin: false,
    modelsPath: options.modelsPath,
    env: options.env,
    credentialFromEnv: options.credentialFromEnv,
    role: 'adjudicator model',
  });
  if (!resolved.ok) return resolved;
  const selected = adjudicatorTransport(resolved.value.route, {
    allowPool: options.allowPool,
    seedLogin: false,
    env: resolved.value.env,
  });
  if (!selected.ok) return selected;
  const transport = selected.value;
  const sources = buildAdjudicationSources(candidates, options.read);
  const { provided } = promptCandidates(candidates);
  // An empty scratch directory: no checkout, no project settings.
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), 'agent-ci-adjudicator-'),
  );
  try {
    const summary = await runAgent(
      {
        routeId: resolved.value.route.id,
        prompt: adjudicatorPrompt(candidates, sources),
        cwd: scratch,
        outDir: options.outDir,
        outputContract: 'report',
        useCase: `${USE_CASE}-adjudicator`,
        targetRepo: spec.repository,
        mode: 'read-only',
        allowPool: options.allowPool,
        seedLogin: false,
        homeRoot: options.homeRoot,
        timeoutMs: options.timeoutMs,
        maxAttempts: 2,
        retryDelayMs: 15_000,
        modelsPath: options.modelsPath,
        env: resolved.value.env,
        structured: {
          ...(transport === 'adjudicator-responses'
            ? { adjudicatorTransport: transport }
            : {}),
          schema: (transport === 'adjudicator-responses'
            ? ADJUDICATION_RESPONSES_SCHEMA
            : ADJUDICATION_ANSWER_SCHEMA) as unknown as Record<string, unknown>,
          accept: (candidate, final) =>
            acceptAdjudicationAnswer(
              candidate,
              final,
              candidates,
              sources,
              provided,
            ),
          repairPrompt: adjudicationRepairPrompt,
          outputFile: 'adjudication-answer.json',
          describe: (value) =>
            `agent-ci adjudicator kept ${
              (value as { operations: unknown[] }).operations.length
            } operation(s).`,
          noTools: true,
        },
      },
      deps,
    );
    if (!summary.ok) return summary;
    let operations: unknown[] = [];
    if (summary.value.error === undefined && summary.value.structuredPath) {
      const value = JSON.parse(
        await readFile(summary.value.structuredPath, 'utf8'),
      ) as { operations: unknown[] };
      operations = value.operations;
    }
    const record: AdjudicatorRecord = {
      version: 1,
      status: summary.value.error === undefined ? 'completed' : 'failed',
      reason:
        summary.value.error === undefined
          ? null
          : `${summary.value.error.code}: ${summary.value.error.message}`.slice(
              0,
              500,
            ),
      route: summary.value.route.id,
      model: summary.value.route.model,
      harness: summary.value.route.harness,
      transport: summary.value.transport,
      repair: summary.value.repair ?? null,
      usage: summary.value.usage,
    };
    await write(record, operations);
    return success(record);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
