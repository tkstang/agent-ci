import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
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
import { writeOwnedFile } from '@agent-ci/files.js';
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
  // An unknown boundary is never replaced by the workspace path: that would
  // let a subdirectory run place credentials elsewhere in the repository.
  const boundary = await findWorkspaceRoot(options.cwd, deps.git);
  if (!boundary.ok) return boundary;
  const boundaryRoot = boundary.value.root;
  const outputPath = await checkOutputDir(
    options.cwd,
    options.outDir,
    boundaryRoot,
  );
  if (!outputPath.ok) return outputPath;
  const homeOutside = async (root: string): Promise<boolean> => {
    try {
      return !isWithin(boundaryRoot, await resolveRealPath(root));
    } catch {
      return false; // unresolvable (symlink loop): fail closed
    }
  };
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
  const home = await createHomeRoot(options.homeRoot, {
    workspaceRoot: boundaryRoot,
  });
  if (!home.ok) return home;
  const keepHome = options.homeRoot !== undefined;
  // Re-check the created root's real path (kept or temp) before anything is
  // seeded into it.
  if (!(await homeOutside(home.value.root))) {
    if (!keepHome) await rm(home.value.root, { recursive: true, force: true });
    return failure(
      'E_HOME_ROOT',
      `the home root resolves inside the workspace ${boundaryRoot}`,
      'Run with TMPDIR outside the repository, or pass a --home-root outside it.',
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
      boundaryRoot,
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
  boundaryRoot: string,
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
  // Fail closed: if the stores cannot be fully read, the run must not trust,
  // persist or emit anything the agent produced.
  let guardFailure: { code: ErrorCode; message: string } | undefined;
  const refreshLoginSecrets = async (): Promise<boolean> => {
    let observed: Result<string[]>;
    try {
      observed = await readLoginSecrets(homeRoot, {
        harness: route.harness,
        parentEnv: options.env,
        includeOpencodeStore: route.login,
        ...(deps.loginExport === undefined
          ? {}
          : { exportRunner: deps.loginExport }),
      });
    } catch {
      observed = {
        ok: false,
        code: 'E_SECRET_GUARD',
        message: 'credential guard incomplete: login stores could not be read',
      };
    }
    if (!observed.ok) {
      guardFailure ??= { code: observed.code, message: observed.message };
      log.withholdFreeText();
      return false;
    }
    for (const value of observed.value) {
      if (!secrets.includes(value)) secrets.push(value);
    }
    log.addSecrets(observed.value);
    return true;
  };
  const outDir = path.resolve(options.cwd, options.outDir);
  await mkdir(outDir, { recursive: true });
  const promptPath = path.join(outDir, 'prompt.md');
  const resultPath = path.join(outDir, 'run-result.json');
  const logPath = path.join(outDir, 'run-log.jsonl');
  await writeOwnedFile(promptPath, maskSecrets(promptText, secrets), 0o644);

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
            if (!(await refreshLoginSecrets())) {
              // Discard the attempt's output: its secrets are unknown.
              outcome = {
                ok: false,
                code: 'E_SECRET_GUARD',
                retryable: false,
                message: guardFailure?.message ?? 'credential guard incomplete',
              };
            }
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

  // Defensive: an incomplete guard always wins, whatever the outcome says.
  if (guardFailure !== undefined) {
    error = guardFailure;
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
  // The agent ran inside this workspace: re-check that nothing it did
  // redirects the output directory before writing through it.
  const stillSafe = await checkOutputDir(
    options.cwd,
    options.outDir,
    boundaryRoot,
  );
  if (!stillSafe.ok) return stillSafe;
  await writeOwnedFile(
    resultPath,
    `${JSON.stringify(result, null, 2)}\n`,
    0o644,
  );
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

/**
 * An output directory inside the workspace (the default `<cwd>/.agent-ci`)
 * must not be reached through a symlink: a checked-out repository could
 * commit `.agent-ci -> elsewhere` and redirect the run's writes. Every
 * existing component between the repository boundary and the directory is
 * checked with lstat. An output directory outside the workspace is the
 * operator's own choice.
 */
async function checkOutputDir(
  cwd: string,
  outDir: string,
  boundaryRoot: string,
): Promise<Result<string>> {
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    return failure('E_INVALID_INPUT', `workspace not found: ${cwd}`);
  }
  const lexical = path.resolve(
    realCwd,
    path.relative(path.resolve(cwd), path.resolve(cwd, outDir)),
  );
  if (!isWithin(boundaryRoot, lexical)) return success(lexical);
  let current = boundaryRoot;
  for (const part of path.relative(boundaryRoot, lexical).split(path.sep)) {
    if (part === '') continue;
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        return failure(
          'E_OUTPUT_PATH',
          `output path component ${current} is a symlink inside the workspace`,
          'Remove the link or pass --out outside the repository.',
        );
      }
      if (!info.isDirectory()) {
        return failure(
          'E_OUTPUT_PATH',
          `output path component ${current} is not a directory`,
        );
      }
    } catch {
      break; // the rest does not exist yet and will be created as directories
    }
  }
  return success(lexical);
}
