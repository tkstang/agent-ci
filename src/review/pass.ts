import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeOwnedFile } from '@agent-ci/files.js';
import { adapterFor } from '@agent-ci/harness/adapters/registry.js';
import type { ToolBridge, Usage } from '@agent-ci/harness/types.js';
import { failure, type Result, success } from '@agent-ci/result.js';
import {
  CHECKS_MCP_SERVER,
  RUN_CHECK_TOOL,
  type ServedChecks,
} from '@agent-ci/review/checks-mcp.js';
import {
  type ChecksEvidence,
  validateChecksEvidence,
} from '@agent-ci/review/checks.js';
import {
  contractError,
  isReviewError,
  type ReviewPass,
} from '@agent-ci/review/contracts.js';
import { readArtifactFile, verifyArtifactDir } from '@agent-ci/review/files.js';
import { escapingLink } from '@agent-ci/review/links.js';
import {
  type LoadedSpec,
  SPEC_FILES,
  verifySpec,
} from '@agent-ci/review/prepare.js';
import {
  acceptReviewAnswer,
  buildReviewPrompt,
  checkoutReader,
  prMetadataFile,
  REVIEW_INPUT_DIR,
  REVIEW_INPUT_FILES,
  reviewAnswerSchema,
  reviewRepairPrompt,
  USE_CASE,
  verifyReviewRepairPrompt,
} from '@agent-ci/review/prompt.js';
import { VERIFY_FILES } from '@agent-ci/review/verify.js';
import { loadModelsFile, resolveRoute } from '@agent-ci/routing/resolve.js';
import type { HarnessId, Route } from '@agent-ci/routing/schema.js';
import { readHead } from '@agent-ci/run/changed-files.js';
import {
  CREDENTIAL_TRANSPORT_ENV,
  mapTransportCredential,
  type RepairOutcome,
  type RunDeps,
  runAgent,
} from '@agent-ci/run/execute.js';
import { findWorkspaceRoot } from '@agent-ci/run/workspace.js';

/**
 * One reviewer pass: verify the digest-bound spec, check the checkout is
 * the captured PR head, put the diff and the untrusted PR text into the
 * workspace, and run the routed harness read-only through the run core as a
 * structured run (schema or prompt-and-parse, one repair turn where
 * verified). No skills are installed and no setup command runs: a review
 * run executes no repository-supplied code. Writes `review.json` (only when
 * the pass produced a usable answer), `pass.json`, and the run core's
 * `run-result.json`, `run-log.jsonl` and `prompt.md` to the output
 * directory.
 */

export const PASS_FILES = Object.freeze({
  review: 'review.json',
  pass: 'pass.json',
  /** verify-review: the validated checks the pass served (gate input). */
  checks: 'checks.json',
});

const CHECKS_MAX_BYTES = 1024 * 1024;

/** The bridge server: compiled `.js` in dist, the `.ts` source under tests. */
export function checksMcpPath(): string {
  const built = fileURLToPath(new URL('./checks-mcp.js', import.meta.url));
  return existsSync(built)
    ? built
    : fileURLToPath(new URL('./checks-mcp.ts', import.meta.url));
}

/**
 * Read and validate the verify stage's output for this spec. The directory
 * must match its digest (the verify job's report, or a local digest), and
 * the file must bind to the spec: repository, head, config digest, the
 * configured checks in order, every evidence id recomputed.
 */
export async function loadChecksDir(input: {
  dir: string | undefined;
  digest: string | undefined;
  spec: LoadedSpec;
}): Promise<Result<ChecksEvidence>> {
  const { spec } = input.spec;
  if (spec.verify === undefined)
    return failure('E_REVIEW_INPUT', 'the spec has no checks configuration');
  if (input.dir === undefined || input.dir === '')
    return failure(
      'E_VERIFY_EVIDENCE',
      'verify-review needs the verify stage output (--checks-dir with checks.json)',
    );
  try {
    await verifyArtifactDir(input.dir, input.digest ?? '');
    const text = await readArtifactFile(
      path.join(input.dir, VERIFY_FILES.evidence),
      CHECKS_MAX_BYTES,
    );
    if (text === null)
      return failure(
        'E_VERIFY_EVIDENCE',
        'the verify stage wrote no checks.json',
      );
    return success(
      validateChecksEvidence(JSON.parse(text) as unknown, {
        repository: spec.repository,
        head_sha: spec.head_sha,
        verify: spec.verify,
      }),
    );
  } catch (error) {
    if (isReviewError(error))
      return failure('E_VERIFY_EVIDENCE', error.message);
    return failure(
      'E_VERIFY_EVIDENCE',
      `the verify stage output is unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The file the bridge serves: validated results plus config descriptions. */
export function servedChecks(
  evidence: ChecksEvidence,
  spec: LoadedSpec['spec'],
): ServedChecks {
  const descriptions = new Map(
    (spec.verify?.config.checks ?? []).map((c) => [c.name, c.description]),
  );
  return {
    version: 1,
    head_sha: evidence.head_sha,
    checks: evidence.entries.map((entry) => ({
      name: entry.name,
      description: descriptions.get(entry.name) ?? '',
      evidence_id: entry.evidence_id,
      command: entry.command,
      exit_code: entry.exit_code,
      timed_out: entry.timed_out,
      truncated: entry.truncated,
      isolation: entry.isolation,
      output_tail: entry.output_tail,
    })),
  };
}

const SPEC_MAX_BYTES = 4 * 1024 * 1024;
const DIFF_MAX_BYTES = 16 * 1024 * 1024;

/** `pass.json`: what the pass did, for the findings gate and the summary. */
export type PassRecord = {
  version: 1;
  pass: ReviewPass;
  ok: boolean;
  code: string | null;
  route: string;
  model: string;
  harness: HarnessId;
  attempts: number;
  repair: RepairOutcome | null;
  usage: Usage | null;
  warnings: string[];
  /** verify-review: check names `run_check` served, in call order. */
  checks_served?: string[];
};

/** Read and verify a downloaded spec directory. */
export async function loadSpecDir(input: {
  dir: string;
  specSha256: string;
  repository: string;
}): Promise<LoadedSpec> {
  return verifySpec({
    specText: await readArtifactFile(
      path.join(input.dir, SPEC_FILES.spec),
      SPEC_MAX_BYTES,
    ),
    diffText: await readArtifactFile(
      path.join(input.dir, SPEC_FILES.diff),
      DIFF_MAX_BYTES,
    ),
    specSha256: input.specSha256,
    repository: input.repository,
  });
}

export type ReviewPassOptions = {
  readonly pass: ReviewPass;
  readonly spec: LoadedSpec;
  /** The PR head checkout (its top level). */
  readonly cwd: string;
  readonly outDir: string;
  readonly model?: string | undefined;
  readonly harness?: HarnessId | undefined;
  readonly routeId?: string | undefined;
  readonly allowPool: boolean;
  readonly seedLogin: boolean;
  readonly homeRoot?: string | undefined;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly modelsPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentialFromEnv: boolean;
  readonly git?: string;
  /** verify-review: the verify stage's output directory and its digest. */
  readonly checksDir?: string | undefined;
  readonly checksDigest?: string | undefined;
};

export type ReviewPassResult = {
  readonly record: PassRecord;
  readonly reviewPath: string | null;
  readonly passPath: string;
};

/** Run one reviewer pass. Pre-run problems return a `Failure`. */
export async function runReviewPass(
  options: ReviewPassOptions,
  deps: RunDeps = {},
): Promise<Result<ReviewPassResult>> {
  const { spec } = options.spec;
  const model =
    options.pass === 'primary'
      ? spec.request.primary.model
      : spec.request.second.enabled
        ? spec.request.second.model
        : undefined;
  if (model === undefined)
    return failure(
      'E_REVIEW_INPUT',
      'the second reviewer pass is not enabled for this request',
    );
  if (options.model !== undefined && options.model !== model)
    return failure(
      'E_REVIEW_INPUT',
      `--model ${options.model} differs from the ${options.pass} model ${model} the request bound`,
    );

  // Resolve the exact route here (as the run core would), so the prompt
  // can describe the answer channel the route actually has.
  const resolvedRoute = await resolveReviewRoute({
    model,
    routeId: options.routeId,
    harness: options.harness,
    allowPool: options.allowPool,
    seedLogin: options.seedLogin,
    modelsPath: options.modelsPath,
    env: options.env,
    credentialFromEnv: options.credentialFromEnv,
    role: `${options.pass} model`,
  });
  if (!resolvedRoute.ok) return resolvedRoute;
  const { route, env } = resolvedRoute.value;

  // verify-review: the recorded checks, validated before anything runs, and
  // a route whose harness can offer the run_check bridge.
  const verify = spec.request.mode === 'verify-review';
  let checks: ChecksEvidence | undefined;
  if (verify) {
    if (!adapterFor(route.harness).supportsToolBridge)
      return failure(
        'E_POLICY_HARNESS',
        `route ${route.id} runs on ${route.harness}, which has no verified run_check bridge; verify-review needs a Claude or Codex route`,
      );
    const loaded = await loadChecksDir({
      dir: options.checksDir,
      digest: options.checksDigest,
      spec: options.spec,
    });
    if (!loaded.ok) return loaded;
    checks = loaded.value;
  }

  // The checkout must be the captured head: the findings gate anchors
  // against that tree, and a moved checkout would review other code.
  const root = await findWorkspaceRoot(options.cwd, options.git);
  if (!root.ok) return root;
  const head = await readHead(root.value.root, options.git);
  if (!head.ok) return head;
  if (head.value !== spec.head_sha)
    return failure(
      'E_REVIEW_STALE_HEAD',
      `the checkout is at ${head.value ?? 'no commit'}, not the captured head ${spec.head_sha}`,
    );

  // The reviewer's read tools allow workspace paths: a committed link out of
  // the checkout (for example to /proc/self/environ) must not reach them.
  const escaping = await escapingLink(root.value.root, options.git);
  if (!escaping.ok) return escaping;
  if (escaping.value !== undefined)
    return failure(
      'E_UNSAFE_WORKSPACE',
      `the pull request head has a symlink that leaves the repository (${escaping.value}); agent-ci does not review it`,
    );

  const inputDir = path.join(root.value.root, REVIEW_INPUT_DIR);
  // Created exclusively: a PR that commits this path (or a link at it)
  // cannot redirect where agent-ci writes the review inputs.
  try {
    await mkdir(inputDir, { mode: 0o755 });
  } catch (err) {
    return failure(
      'E_UNSAFE_WORKSPACE',
      `the checkout already has ${REVIEW_INPUT_DIR} (${(err as NodeJS.ErrnoException).code ?? 'error'}); agent-ci writes its review inputs there`,
    );
  }
  // The served file and the calls log live outside the checkout, in a
  // directory only this pass uses.
  const bridgeDir =
    checks === undefined
      ? undefined
      : await mkdtemp(path.join(os.tmpdir(), 'agent-ci-checks-'));
  try {
    let toolBridge: ToolBridge | undefined;
    if (checks !== undefined && bridgeDir !== undefined) {
      const served = path.join(bridgeDir, 'served.json');
      await writeOwnedFile(
        served,
        `${JSON.stringify(servedChecks(checks, spec))}\n`,
        0o600,
      );
      toolBridge = {
        server: CHECKS_MCP_SERVER,
        command: process.execPath,
        args: [
          checksMcpPath(),
          '--checks',
          served,
          '--calls',
          path.join(bridgeDir, 'calls.jsonl'),
        ],
        tool: RUN_CHECK_TOOL,
      };
    }
    await writeFile(
      path.join(root.value.root, REVIEW_INPUT_FILES.diff),
      options.spec.diffText,
      { flag: 'wx', mode: 0o644 },
    );
    await writeFile(
      path.join(root.value.root, REVIEW_INPUT_FILES.pr),
      prMetadataFile(spec.pr),
      { flag: 'wx', mode: 0o644 },
    );
    let prompt;
    try {
      prompt = buildReviewPrompt({
        request: spec.request,
        pass: options.pass,
        repository: spec.repository,
        pr_number: spec.pr_number,
        base_sha: spec.base_sha,
        merge_base_sha: spec.merge_base_sha,
        head_sha: spec.head_sha,
        guidance: spec.guidance,
        diff: spec.diff,
        changed_files: spec.changed_files,
        checkout: checkoutReader(root.value.root),
        channel: route.structuredOutput === 'prompt' ? 'final-text' : 'schema',
        ...(checks === undefined
          ? {}
          : {
              checks: {
                status: checks.status,
                setupExit: checks.setup?.exit_code ?? null,
                entries: servedChecks(checks, spec).checks.map((c) => ({
                  name: c.name,
                  description: c.description,
                })),
              },
            }),
      });
    } catch (error) {
      if (isReviewError(error)) return failure(error.code, error.message);
      throw error;
    }
    const expectation = {
      mode: spec.request.mode,
      pass: options.pass,
      base_sha: spec.base_sha,
      merge_base_sha: spec.merge_base_sha,
      head_sha: spec.head_sha,
    };
    const summary = await runAgent(
      {
        routeId: route.id,
        prompt: prompt.prompt,
        cwd: root.value.root,
        outDir: options.outDir,
        outputContract: 'report',
        useCase: USE_CASE,
        targetRepo: spec.repository,
        mode: 'read-only',
        allowPool: options.allowPool,
        seedLogin: options.seedLogin,
        homeRoot: options.homeRoot,
        timeoutMs: options.timeoutMs,
        maxAttempts: options.maxAttempts,
        retryDelayMs: options.retryDelayMs,
        modelsPath: options.modelsPath,
        env,
        structured: {
          schema: reviewAnswerSchema(spec.request.mode),
          accept: (candidate, final) =>
            acceptReviewAnswer(
              candidate,
              final,
              expectation,
              checks === undefined
                ? {}
                : {
                    checkIds: new Set(
                      checks.entries.map((entry) => entry.evidence_id),
                    ),
                  },
            ),
          repairPrompt: verify ? verifyReviewRepairPrompt : reviewRepairPrompt,
          ...(toolBridge === undefined ? {} : { toolBridge }),
          outputFile: PASS_FILES.review,
          describe: (value) =>
            `agent-ci ${options.pass} reviewer submitted ${
              (value as { findings: unknown[] }).findings.length
            } finding(s) for head ${spec.head_sha.slice(0, 12)}.`,
        },
      },
      { ...deps, ...(options.git === undefined ? {} : { git: options.git }) },
    );
    if (!summary.ok) return summary;
    const passDir = path.dirname(summary.value.resultPath);
    let served: string[] | undefined;
    if (checks !== undefined && bridgeDir !== undefined) {
      // The gate validates citations against exactly what this pass served.
      await writeOwnedFile(
        path.join(passDir, PASS_FILES.checks),
        `${JSON.stringify(checks, null, 2)}\n`,
        0o644,
      );
      served = await readServedNames(path.join(bridgeDir, 'calls.jsonl'));
    }
    const record: PassRecord = {
      version: 1,
      pass: options.pass,
      ok: summary.value.error === undefined,
      code: summary.value.error?.code ?? null,
      route: route.id,
      model: route.model,
      harness: route.harness,
      attempts: summary.value.attempts,
      repair: summary.value.repair ?? null,
      usage: summary.value.usage,
      warnings: prompt.warnings,
      ...(served === undefined ? {} : { checks_served: served }),
    };
    const passPath = path.join(passDir, PASS_FILES.pass);
    await writeOwnedFile(
      passPath,
      `${JSON.stringify(record, null, 2)}\n`,
      0o644,
    );
    return success({
      record,
      reviewPath: summary.value.structuredPath ?? null,
      passPath,
    });
  } finally {
    // Only what agent-ci created: the input directory and the bridge
    // directory it made above.
    await rm(inputDir, { recursive: true, force: true });
    if (bridgeDir !== undefined)
      await rm(bridgeDir, { recursive: true, force: true });
  }
}

/** Check names from the bridge's calls log (diagnostic; bounded). */
async function readServedNames(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split('\n').slice(0, 200)) {
    try {
      const value = JSON.parse(line) as { name?: unknown };
      if (
        typeof value.name === 'string' &&
        /^[a-z][a-z0-9-]{0,39}$/u.test(value.name)
      )
        names.push(value.name);
    } catch {
      // skip a partial line
    }
  }
  return names;
}

/**
 * Resolve the route a review stage runs on, exactly as the run core will
 * (the transport credential mapped first), and require that it serves the
 * model the request bound.
 */
export async function resolveReviewRoute(input: {
  model: string;
  routeId?: string | undefined;
  harness?: HarnessId | undefined;
  allowPool: boolean;
  seedLogin: boolean;
  modelsPath: string;
  env: Readonly<Record<string, string | undefined>>;
  credentialFromEnv: boolean;
  role: string;
}): Promise<
  Result<{ route: Route; env: Readonly<Record<string, string | undefined>> }>
> {
  const models = await loadModelsFile(input.modelsPath);
  if (!models.ok) return models;
  const request = {
    model: input.routeId === undefined ? input.model : undefined,
    harness: input.harness,
    routeId: input.routeId,
    allowPool: input.allowPool,
    seedLogin: input.seedLogin,
  };
  let env = input.env;
  if (input.credentialFromEnv) {
    const mapped = mapTransportCredential(models.value, request, env);
    if (!mapped.ok) return mapped;
    env = mapped.value;
  } else if (env[CREDENTIAL_TRANSPORT_ENV] !== undefined) {
    const { [CREDENTIAL_TRANSPORT_ENV]: _dropped, ...rest } = env;
    env = rest;
  }
  const resolved = resolveRoute(models.value, { ...request, env });
  if (!resolved.ok) return resolved;
  const { route } = resolved.value;
  if (route.model !== input.model)
    return failure(
      'E_REVIEW_INPUT',
      `route ${route.id} serves ${route.model}, not the ${input.role} ${input.model}`,
    );
  return success({ route, env });
}

/** Parse `pass.json` from a downloaded pass directory (untrusted shape). */
export function parsePassRecord(text: string | null): PassRecord | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<PassRecord> | null;
    if (
      value === null ||
      value.version !== 1 ||
      (value.pass !== 'primary' && value.pass !== 'second') ||
      typeof value.ok !== 'boolean' ||
      typeof value.model !== 'string'
    )
      return null;
    return value as PassRecord;
  } catch {
    return null;
  }
}

/** Fail with `E_REVIEW_INPUT` unless `value` names a reviewer pass. */
export function reviewPass(value: string | undefined): ReviewPass {
  if (value === 'primary' || value === 'second') return value;
  return contractError('E_REVIEW_INPUT', '--pass must be primary or second');
}
