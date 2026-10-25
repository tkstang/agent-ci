import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { extractStructuredResult } from '@agent-ci/contracts/final-answer.js';
import { finalizeRunResult } from '@agent-ci/contracts/finalize.js';
import {
  buildFailedRunResult,
  type OutputContract,
  type ValidatedRunResult,
} from '@agent-ci/contracts/run-result.js';
import {
  assertSecretFree,
  KNOWN_CREDENTIAL_ENV,
  maskSecrets,
  secretValuesFromEnv,
} from '@agent-ci/contracts/secret-guard.js';
import { adapterFor } from '@agent-ci/harness/adapters/registry.js';
import { CredentialLeakError } from '@agent-ci/harness/env.js';
import {
  createHomeRoot,
  type ExportRunner,
  type HomeRoot,
  type PipeRunner,
  readLoginSecrets,
  seedLogin,
  seedSkills,
} from '@agent-ci/harness/home.js';
import { type RunHarnessDeps, runHarness } from '@agent-ci/harness/run.js';
import type {
  HarnessOutcome,
  RunMode,
  Usage,
} from '@agent-ci/harness/types.js';
import {
  failure,
  success,
  type ErrorCode,
  type Result,
} from '@agent-ci/result.js';
import {
  loadModelsFile,
  resolveRoute,
  type SkippedRoute,
} from '@agent-ci/routing/resolve.js';
import type { HarnessId, Route } from '@agent-ci/routing/schema.js';
import {
  changedSince,
  snapshotWorkspace,
} from '@agent-ci/run/changed-files.js';
import { buildRunPrompt } from '@agent-ci/run/prompt.js';
import { RunLog } from '@agent-ci/run/run-log.js';
import { superviseAttempts } from '@agent-ci/run/supervisor.js';
import {
  findWorkspaceRoot,
  isWithin,
  resolveRealPath,
} from '@agent-ci/run/workspace.js';

export interface RunOptions {
  readonly model?: string | undefined;
  readonly harness?: HarnessId | undefined;
  readonly routeId?: string | undefined;
  readonly prompt: string;
  readonly cwd: string;
  /** Where run-result.json, run-log.jsonl and prompt.md are written. */
  readonly outDir: string;
  readonly outputContract: OutputContract;
  readonly verdictItems?: unknown;
  readonly useCase: string;
  readonly targetRepo: string;
  readonly targetPaths?: readonly string[];
  readonly untrustedContext?: string;
  readonly mode: RunMode;
  readonly allowPool: boolean;
  readonly seedLogin: boolean;
  readonly skillsDir?: string | undefined;
  readonly homeRoot?: string | undefined;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly modelsPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface RunDeps {
  readonly harness?: RunHarnessDeps;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pipe?: PipeRunner;
  /** git executable used for change detection (test seam). */
  readonly git?: string;
  /** Credential-store export runner (test seam for OpenCode logins). */
  readonly loginExport?: ExportRunner;
}

export interface RunSummary {
  readonly result: ValidatedRunResult;
  readonly resultPath: string;
  readonly logPath: string;
  readonly promptPath: string;
  readonly route: Pick<
    Route,
    'id' | 'model' | 'harness' | 'providerModel' | 'billing' | 'account'
  >;
  readonly attempts: number;
  readonly usage: Usage | null;
  /** The home root when it was kept (`--home-root`); temp roots are removed. */
  readonly homeRoot: string | null;
  /** Present when the run failed: the failure's code and masked message. */
  readonly error?: { readonly code: ErrorCode; readonly message: string };
}

interface AttemptRecord {
  readonly ok: boolean;
  readonly retryable: boolean;
  readonly outcome: HarnessOutcome;
}

/**
 * Run one prompt through the resolved harness and persist a validated
 * RunResult. Pre-run errors (bad route, policy, prompt, home root) return a
 * `Failure` and write nothing; once the harness is involved, a contract-shaped
 * result and the run log are always written, failed or not.
 */
export async function runAgent(
  options: RunOptions,
  deps: RunDeps = {},
): Promise<Result<RunSummary>> {
  const models = await loadModelsFile(options.modelsPath);
  if (!models.ok) return models;
  const resolved = resolveRoute(models.value, {
    model: options.model,
    harness: options.harness,
    routeId: options.routeId,
    allowPool: options.allowPool,
    seedLogin: options.seedLogin,
    env: options.env,
  });
  if (!resolved.ok) return resolved;
  const { route } = resolved.value;

  const prompt = buildRunPrompt({
    useCase: options.useCase,
    targetRepo: options.targetRepo,
    outputContract: options.outputContract,
    mode: options.mode,
    prompt: options.prompt,
    verdictItems: options.verdictItems,
    ...(options.targetPaths === undefined
      ? {}
      : { targetPaths: options.targetPaths }),
    ...(options.untrustedContext === undefined
      ? {}
      : { untrustedContext: options.untrustedContext }),
  });
  if (!prompt.ok) return prompt;

  // The home root holds credentials (seeded or refreshed logins) and
  // invocation files: it must never be the workspace or inside it, where it
  // could be reported as a change, published or committed.
  const boundary = await findWorkspaceRoot(options.cwd, deps.git);
  const boundaryRoot = boundary.ok
    ? boundary.value.root
    : await resolveRealPath(options.cwd);
  const homeOutside = async (root: string): Promise<boolean> =>
    !isWithin(boundaryRoot, await resolveRealPath(root));
  if (
    options.homeRoot !== undefined &&
    !(await homeOutside(options.homeRoot))
  ) {
    return failure(
      'E_HOME_ROOT',
      `home root ${options.homeRoot} is inside the workspace ${boundaryRoot}`,
      'Choose a --home-root outside the repository (for example under the system temp directory).',
    );
  }
  const home = await createHomeRoot(options.homeRoot);
  if (!home.ok) return home;
  const keepHome = options.homeRoot !== undefined;
  if (!keepHome && !(await homeOutside(home.value.root))) {
    await rm(home.value.root, { recursive: true, force: true });
    return failure(
      'E_HOME_ROOT',
      `the temp home root falls inside the workspace ${boundaryRoot}`,
      'Run with TMPDIR outside the repository, or pass --home-root.',
    );
  }
  try {
    return await runInHome(
      options,
      deps,
      route,
      resolved.value.skipped,
      prompt.value,
      home.value,
    );
  } finally {
    // A temp root may hold a seeded login; never leave it behind.
    if (!keepHome) await rm(home.value.root, { recursive: true, force: true });
  }
}

async function runInHome(
  options: RunOptions,
  deps: RunDeps,
  route: Route,
  skipped: readonly SkippedRoute[],
  promptText: string,
  homeRoot: HomeRoot,
): Promise<Result<RunSummary>> {
  const now = deps.now ?? Date.now;
  if (options.skillsDir !== undefined) {
    const seeded = await seedSkills(homeRoot, options.skillsDir);
    if (!seeded.ok) return seeded;
  }
  const seededSecrets: string[] = [];
  if (route.login) {
    const seeded = await seedLogin(homeRoot, {
      harness: route.harness,
      parentEnv: options.env,
      ...(deps.pipe === undefined ? {} : { pipe: deps.pipe }),
    });
    if (!seeded.ok) return seeded;
    seededSecrets.push(...seeded.value.secrets);
  }

  // Every credential value present in the parent is a secret for output
  // guarding, not only the route's: an agent must not echo any of them.
  // Seeded-login material is guarded too: a read-only agent can read files
  // under $HOME and echo them.
  const secrets = [
    ...secretValuesFromEnv(options.env, [
      ...KNOWN_CREDENTIAL_ENV,
      ...route.credentials,
    ]),
    ...seededSecrets,
  ];
  const log = new RunLog(secrets);
  // A harness may refresh its login mid-run: re-read the isolated stores and
  // guard every newly observed token value (outputs, earlier log records).
  const refreshLoginSecrets = async (): Promise<void> => {
    const observed = await readLoginSecrets(homeRoot, {
      harness: route.harness,
      parentEnv: options.env,
      includeOpencodeStore: route.login,
      ...(deps.loginExport === undefined
        ? {}
        : { exportRunner: deps.loginExport }),
    });
    for (const value of observed) {
      if (!secrets.includes(value)) secrets.push(value);
    }
    log.addSecrets(observed);
  };
  const outDir = path.resolve(options.cwd, options.outDir);
  await mkdir(outDir, { recursive: true });
  const promptPath = path.join(outDir, 'prompt.md');
  const resultPath = path.join(outDir, 'run-result.json');
  const logPath = path.join(outDir, 'run-log.jsonl');
  await writeFile(promptPath, maskSecrets(promptText, secrets));

  const routeInfo = {
    id: route.id,
    model: route.model,
    harness: route.harness,
    providerModel: route.providerModel,
    billing: route.billing,
    account: route.account,
  };
  log.add('run.start', {
    route: routeInfo,
    mode: options.mode,
    outputContract: options.outputContract,
    skippedRoutes: skipped,
    loginSeeded: route.login,
  });

  // Only changes made during the run count; pre-existing dirt does not.
  const baseline = await snapshotWorkspace(options.cwd, [outDir], deps.git);
  if (!baseline.ok) {
    log.add('workspace.status', {
      phase: 'baseline',
      code: baseline.code,
      message: baseline.message,
    });
  }
  // An edit run whose changes cannot be detected would publish nothing; stop
  // before spending a model call.
  const preflight: AttemptRecord | undefined =
    !baseline.ok && options.mode === 'edit'
      ? {
          ok: false,
          retryable: false,
          outcome: {
            ok: false,
            code: 'E_HARNESS_FAILED',
            retryable: false,
            message: baseline.message,
          },
        }
      : undefined;
  const adapter = adapterFor(route.harness);
  const supervised =
    preflight !== undefined
      ? { result: preflight, attempts: 0, stopReason: 'not-retryable' as const }
      : await superviseAttempts<AttemptRecord>({
          maxAttempts: options.maxAttempts,
          retryDelayMs: options.retryDelayMs,
          deadlineAtMs: now() + options.timeoutMs,
          now,
          ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
          run: async (attempt, timeoutMs) => {
            const scratchDir = await mkdtemp(
              path.join(homeRoot.root, `attempt-${attempt}-`),
            );
            let run: Awaited<ReturnType<typeof runHarness>> | undefined;
            let outcome: HarnessOutcome;
            try {
              run = await runHarness(
                adapter,
                {
                  route,
                  prompt: promptText,
                  cwd: options.cwd,
                  mode: options.mode,
                  home: homeRoot,
                  scratchDir,
                  parentEnv: options.env,
                },
                { timeoutMs },
                deps.harness,
              );
              outcome = run.outcome;
            } catch (err) {
              // A leak guard or an adapter I/O error: still a recorded, failed run.
              outcome = {
                ok: false,
                code:
                  err instanceof CredentialLeakError
                    ? 'E_CREDENTIAL_LEAK'
                    : 'E_HARNESS_FAILED',
                retryable: false,
                message: maskSecrets(
                  err instanceof Error ? err.message : String(err),
                  secrets,
                ),
              };
            }
            await refreshLoginSecrets();
            log.add('attempt', {
              attempt,
              harness: route.harness,
              ok: outcome.ok,
              ...(outcome.ok
                ? {}
                : {
                    code: outcome.code,
                    retryable: outcome.retryable,
                    message: maskSecrets(outcome.message, secrets),
                  }),
              usage: outcome.usage ?? null,
              sessionId: outcome.sessionId ?? null,
              durationMs: run?.durationMs ?? null,
            });
            return {
              ok: outcome.ok,
              retryable: outcome.ok ? false : outcome.retryable,
              outcome,
            };
          },
        });

  const outcome = supervised.result.outcome;
  let result: ValidatedRunResult;
  let error: { code: ErrorCode; message: string } | undefined;
  if (outcome.ok) {
    const candidate =
      outcome.structured === undefined
        ? extractStructuredResult(outcome.finalText)
        : success(outcome.structured);
    const changed = baseline.ok
      ? await changedSince(options.cwd, baseline.value, [outDir], deps.git)
      : baseline;
    if (!changed.ok && baseline.ok) {
      log.add('workspace.status', {
        phase: 'after',
        code: changed.code,
        message: changed.message,
      });
    }
    const finalized = !candidate.ok
      ? candidate
      : !changed.ok && options.mode === 'edit'
        ? changed
        : finalizeRunResult(candidate.value, {
            useCase: options.useCase,
            targetRepo: options.targetRepo,
            outputContract: options.outputContract,
            verdictItems: options.verdictItems,
            detectedChangedFiles: changed.ok ? changed.value : [],
            secrets,
          });
    if (finalized.ok) {
      result = finalized.value;
    } else {
      error = {
        code: finalized.code,
        message: maskSecrets(finalized.message, secrets),
      };
      result = buildFailedRunResult({ ...options, ...error });
    }
  } else {
    error = {
      code: preflight !== undefined ? 'E_WORKSPACE_STATUS' : outcome.code,
      message: maskSecrets(outcome.message, secrets),
    };
    result = buildFailedRunResult({ ...options, ...error });
  }

  // Last line of defence: never persist a credential value.
  const guarded = assertSecretFree(result, secrets);
  if (!guarded.ok) {
    error = { code: guarded.code, message: guarded.message };
    result = buildFailedRunResult({ ...options, ...error });
  }
  log.add('run.result', {
    ok: result.ok,
    status: result.status,
    outputContract: result.outputContract,
    attempts: supervised.attempts,
    ...(supervised.stopReason === undefined
      ? {}
      : { stopReason: supervised.stopReason }),
    ...(error === undefined ? {} : { code: error.code }),
  });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  await log.write(logPath);

  return success({
    result,
    resultPath,
    logPath,
    promptPath,
    route: routeInfo,
    attempts: supervised.attempts,
    usage: outcome.usage ?? null,
    homeRoot: options.homeRoot === undefined ? null : homeRoot.root,
    ...(error === undefined ? {} : { error }),
  });
}
