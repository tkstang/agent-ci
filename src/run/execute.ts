import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import {
  CredentialLeakError,
  UnsafeWorkspaceError,
} from '@agent-ci/harness/env.js';
import {
  createHomeRoot,
  clearLoginStores,
  type ExportRunner,
  type HomeRoot,
  type PipeRunner,
  readLoginSecrets,
  seedLogin,
  seedSkills,
  validateHomeTree,
} from '@agent-ci/harness/home.js';
import { type RunHarnessDeps, runHarness } from '@agent-ci/harness/run.js';
import type {
  HarnessOutcome,
  RunMode,
  Usage,
} from '@agent-ci/harness/types.js';
import { buildChangeSet, CHANGE_SET_FILE } from '@agent-ci/publish/changes.js';
import {
  failure,
  success,
  type ErrorCode,
  type Result,
} from '@agent-ci/result.js';
import {
  loadModelsFile,
  type ResolveRequest,
  resolveRoute,
  type SkippedRoute,
} from '@agent-ci/routing/resolve.js';
import type { HarnessId, ModelsFile, Route } from '@agent-ci/routing/schema.js';
import {
  copyIsolationProblem,
  createAttemptWorkspace,
  isolationSupport,
  promoteChanges,
} from '@agent-ci/run/attempt-workspace.js';
import {
  changedSince,
  readHead,
  snapshotWorkspace,
} from '@agent-ci/run/changed-files.js';
import { buildRunPrompt } from '@agent-ci/run/prompt.js';
import { RunLog } from '@agent-ci/run/run-log.js';
import { superviseAttempts } from '@agent-ci/run/supervisor.js';
import {
  findWorkspaceRoot,
  isWithin,
  resolvePhysical,
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
  /**
   * Take the route's single credential from `AGENT_CI_CREDENTIAL` (a
   * workflow maps exactly one secret into that variable). The value is moved
   * to the route's named variable; the transport variable is dropped.
   */
  readonly credentialFromEnv?: boolean;
}

/** The transport variable for `--credential-from-env`. */
export const CREDENTIAL_TRANSPORT_ENV = 'AGENT_CI_CREDENTIAL';

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
  /** `changes.json` for an edit run that changed files, else null. */
  readonly changesPath: string | null;
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
  const request = {
    model: options.model,
    harness: options.harness,
    routeId: options.routeId,
    allowPool: options.allowPool,
    seedLogin: options.seedLogin,
  };
  let env = options.env;
  if (options.credentialFromEnv === true) {
    const mapped = mapTransportCredential(models.value, request, env);
    if (!mapped.ok) return mapped;
    env = mapped.value;
    options = { ...options, env };
  }
  const resolved = resolveRoute(models.value, { ...request, env });
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
  const outputDir = await resolveOutputDir(
    options.cwd,
    options.outDir,
    boundaryRoot,
  );
  if (!outputDir.ok) return outputDir;
  // Every derived destination (HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_*,
  // skills, attempt scratch) lives under the home root, so the root and the
  // workspace must be disjoint in BOTH directions: a root inside the checkout,
  // or a checkout inside the root (repository at <root>/home), both put
  // credentials and config homes into the repository.
  const homeOutside = async (root: string): Promise<boolean> => {
    try {
      const real = await resolveRealPath(root);
      return !isWithin(boundaryRoot, real) && !isWithin(real, boundaryRoot);
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
      `home root ${options.homeRoot} overlaps the workspace ${boundaryRoot}`,
      'Choose a --home-root that neither contains nor sits inside the repository (for example a fresh directory under the system temp directory).',
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
      `the home root overlaps the workspace ${boundaryRoot}`,
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
      { root: boundaryRoot, git: boundary.value.git },
      outputDir.value,
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
  boundary: { readonly root: string; readonly git: boolean },
  outDir: string,
): Promise<Result<RunSummary>> {
  const boundaryRoot = boundary.root;
  const now = deps.now ?? Date.now;
  // Baseline first: anything that lands in the workspace from here on,
  // including a seeded login, is a change the run reports, never hidden dirt.
  const baseline = await snapshotWorkspace(options.cwd, [outDir], deps.git);
  // The commit an edit run starts from: the change set is based on it, and a
  // run that moves HEAD (commits) is refused, because commits are not
  // visible to change detection and would never be published.
  const baseHead =
    options.mode === 'edit'
      ? await readHead(boundaryRoot, deps.git)
      : success<string | null>(null);
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
    // Defense in depth: the seeded store must sit outside the workspace.
    let seededAt: string | undefined;
    try {
      seededAt = await resolveRealPath(seeded.value.location);
    } catch {
      seededAt = undefined;
    }
    if (seededAt === undefined || isWithin(boundaryRoot, seededAt)) {
      await clearLoginStores(homeRoot);
      return failure(
        'E_HOME_ROOT',
        'the seeded login would sit inside the workspace',
      );
    }
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
  // `outDir` is the canonical path validated before the home was created;
  // every write below goes through it (never a recomputed path).
  await mkdir(outDir, { recursive: true });
  const created = await confirmOutputDir(
    options.cwd,
    options.outDir,
    boundaryRoot,
    outDir,
  );
  if (!created.ok) return created;
  const promptPath = path.join(outDir, 'prompt.md');
  const resultPath = path.join(outDir, 'run-result.json');
  const logPath = path.join(outDir, 'run-log.jsonl');
  const changesPath = path.join(outDir, CHANGE_SET_FILE);
  // A change set left by an earlier run in this directory must never be
  // published with this run's result.
  await rm(changesPath, { force: true });
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
  const workspaceProblem = !baseline.ok
    ? baseline
    : !baseHead.ok
      ? baseHead
      : undefined;
  if (workspaceProblem !== undefined) {
    log.add('workspace.status', {
      phase: 'baseline',
      code: workspaceProblem.code,
      message: workspaceProblem.message,
    });
  }
  // An edit run whose changes cannot be detected would publish nothing; stop
  // before spending a model call.
  const preflight: AttemptRecord | undefined =
    workspaceProblem !== undefined && options.mode === 'edit'
      ? {
          ok: false,
          retryable: false,
          outcome: {
            ok: false,
            code: 'E_HARNESS_FAILED',
            retryable: false,
            message: workspaceProblem.message,
          },
        }
      : undefined;
  // An edit run that may retry runs each attempt in a fresh copy of the
  // repository and promotes only the successful attempt's changes, so a
  // failed attempt's partial edits never reach a retry. Without a trustworthy
  // copy the run makes a single attempt instead.
  const isolation =
    options.mode === 'edit' && options.maxAttempts > 1 && baseline.ok
      ? await isolationSupport(boundaryRoot, boundary.git, outDir)
      : undefined;
  const maxAttempts =
    isolation !== undefined && isolation.mode !== 'copy'
      ? 1
      : options.maxAttempts;
  if (isolation !== undefined) {
    log.add('attempt.isolation', {
      mode: isolation.mode === 'copy' ? 'copy' : 'single-attempt',
      ...(isolation.mode === 'copy' ? {} : { reason: isolation.reason }),
    });
  }
  /** Set when a copy proved unable to isolate: no further retries. */
  let downgraded: string | undefined;
  let realCwd = options.cwd;
  if (isolation?.mode === 'copy') {
    try {
      realCwd = await resolveRealPath(options.cwd);
    } catch {
      realCwd = options.cwd;
    }
  }
  const adapter = adapterFor(route.harness);
  const supervised =
    preflight !== undefined
      ? { result: preflight, attempts: 0, stopReason: 'not-retryable' as const }
      : await superviseAttempts<AttemptRecord>({
          maxAttempts,
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
            let copy =
              isolation?.mode === 'copy' && downgraded === undefined
                ? await createAttemptWorkspace({
                    boundaryRoot,
                    cwd: realCwd,
                    outDir,
                    homeRoot: homeRoot.root,
                    attempt,
                  })
                : undefined;
            if (copy !== undefined && !copy.ok) {
              log.add('attempt', {
                attempt,
                harness: route.harness,
                ok: false,
                code: copy.code,
                retryable: false,
                message: maskSecrets(copy.message, secrets),
              });
              return {
                ok: false,
                retryable: false,
                outcome: {
                  ok: false,
                  code: 'E_WORKSPACE_STATUS',
                  retryable: false,
                  message: copy.message,
                },
              };
            }
            // Qualify the finished copy (every link and git pointer strictly
            // inside it); otherwise run in place, once.
            if (copy?.ok) {
              const escape = await copyIsolationProblem(
                copy.value.root,
                deps.git,
              );
              if (escape !== undefined) {
                await copy.value.dispose();
                copy = undefined;
                downgraded = escape;
                log.add('attempt.isolation', {
                  mode: 'single-attempt',
                  reason: escape,
                });
              }
            }
            const attemptCwd = copy?.value.cwd ?? options.cwd;
            try {
              run = await runHarness(
                adapter,
                {
                  route,
                  prompt: promptText,
                  cwd: attemptCwd,
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
                    : err instanceof UnsafeWorkspaceError
                      ? 'E_UNSAFE_WORKSPACE'
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
            let promoted: readonly string[] | undefined;
            if (copy !== undefined) {
              // Only a successful attempt's changes reach the workspace; a
              // failed attempt's copy is discarded with its partial edits.
              if (outcome.ok && baseline.ok && baseHead.ok) {
                const copyHead = await readHead(copy.value.root, deps.git);
                const inCopy =
                  !copyHead.ok || copyHead.value !== baseHead.value
                    ? failure(
                        'E_WORKSPACE_STATUS',
                        'the attempt moved HEAD; commits made by the agent are not published',
                      )
                    : await changedSince(
                        copy.value.cwd,
                        baseline.value,
                        [copy.value.outDir],
                        deps.git,
                      );
                const moved = inCopy.ok
                  ? await promoteChanges(
                      copy.value.root,
                      boundaryRoot,
                      inCopy.value,
                    )
                  : inCopy;
                if (moved.ok) {
                  promoted = moved.value;
                } else {
                  outcome = {
                    ok: false,
                    code: 'E_WORKSPACE_STATUS',
                    retryable: false,
                    message: moved.message,
                  };
                }
              }
              await copy.value.dispose();
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
              ...(copy === undefined
                ? {}
                : {
                    workspace: 'isolated-copy',
                    ...(promoted === undefined
                      ? {}
                      : { promotedFiles: promoted.length }),
                  }),
            });
            return {
              ok: outcome.ok,
              // An attempt run in place (isolation downgraded) is never
              // retried: its partial edits are in the real workspace.
              retryable:
                outcome.ok || downgraded !== undefined
                  ? false
                  : outcome.retryable,
              outcome,
            };
          },
        });

  // The harness had write access to its home: refuse to trust or publish
  // anything if it redirected part of the home out of the root or into the
  // workspace (for example `home/.codex -> <repo>`).
  const homeAfter = await validateHomeTree(homeRoot.root, boundaryRoot);
  if (!homeAfter.ok) {
    guardFailure ??= { code: homeAfter.code, message: homeAfter.message };
    log.withholdFreeText();
  }
  const outcome = supervised.result.outcome;
  let result: ValidatedRunResult;
  let error: { code: ErrorCode; message: string } | undefined;
  /** Changes detected by git (never the agent's own claims). */
  let detected: readonly string[] = [];
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
    if (changed.ok) detected = changed.value;
    const headAfter =
      options.mode === 'edit' && baseHead.ok
        ? await readHead(boundaryRoot, deps.git)
        : baseHead;
    const finalized = !candidate.ok
      ? candidate
      : !changed.ok && options.mode === 'edit'
        ? changed
        : options.mode === 'edit' &&
            (!headAfter.ok ||
              !baseHead.ok ||
              headAfter.value !== baseHead.value)
          ? failure(
              'E_WORKSPACE_STATUS',
              'the run moved HEAD; commits made by the agent are not published',
            )
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
  // An edit run that changed files hands its exact changes to the publisher
  // as changes.json, captured here because only this step holds the
  // credential the contents are guarded against.
  let changeSet: string | undefined;
  if (
    error === undefined &&
    options.mode === 'edit' &&
    result.ok &&
    result.status === 'changed' &&
    detected.length > 0
  ) {
    const built = await buildChangeSet({
      root: boundaryRoot,
      files: detected,
      baseSha: baseHead.ok ? baseHead.value : null,
      secrets,
    });
    if (built.ok) {
      changeSet = `${JSON.stringify(built.value)}\n`;
    } else {
      error = {
        code: built.code,
        message: maskSecrets(built.message, secrets),
      };
      result = buildFailedRunResult({ ...options, ...error });
    }
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
  const stillSafe = await confirmOutputDir(
    options.cwd,
    options.outDir,
    boundaryRoot,
    outDir,
  );
  if (!stillSafe.ok) return stillSafe;
  await writeOwnedFile(
    resultPath,
    `${JSON.stringify(result, null, 2)}\n`,
    0o644,
  );
  if (changeSet !== undefined) {
    await writeOwnedFile(changesPath, changeSet, 0o644);
  }
  await log.write(logPath);

  return success({
    result,
    resultPath,
    logPath,
    promptPath,
    changesPath: changeSet === undefined ? null : changesPath,
    route: routeInfo,
    attempts: supervised.attempts,
    usage: outcome.usage ?? null,
    homeRoot: options.homeRoot === undefined ? null : homeRoot.root,
    ...(error === undefined ? {} : { error }),
  });
}

/**
 * Move the value of `AGENT_CI_CREDENTIAL` to the variable the route names.
 * The transport variable is always dropped. Empty means "no credential" (the
 * fake harness); a non-empty value needs a route that names exactly one
 * credential, so the value can only ever reach that one variable.
 */
export function mapTransportCredential(
  file: ModelsFile,
  request: Omit<ResolveRequest, 'env'>,
  env: Readonly<Record<string, string | undefined>>,
): Result<Readonly<Record<string, string | undefined>>> {
  const { [CREDENTIAL_TRANSPORT_ENV]: value, ...rest } = env;
  if (value === undefined || value === '') return success(rest);
  const pre = resolveRoute(file, {
    ...request,
    env: rest,
    requireCredentials: false,
  });
  if (!pre.ok) return pre;
  const names = pre.value.route.credentials;
  const [name] = names;
  if (names.length !== 1 || name === undefined) {
    return failure(
      'E_ROUTE_CONFIG',
      `--credential-from-env needs a route that names exactly one credential; ${pre.value.route.id} names ${names.length}`,
    );
  }
  return success({ ...rest, [name]: value });
}

/**
 * Resolve the output directory ONCE to its canonical path. A relative `--out`
 * is taken against the workspace path as given, without lexical
 * normalization, so `sublink/..` is resolved physically. The path is refused
 * when it traverses any symlink located inside the workspace: a checked-out
 * repository can commit `.agent-ci -> elsewhere`, or a linked subdirectory,
 * to redirect the run's writes. Links outside the workspace (`/tmp` ->
 * `/private/tmp`, an operator's own folder links) are the operator's choice.
 * The returned canonical path is the only one the run writes through.
 */
async function resolveOutputDir(
  cwd: string,
  outDir: string,
  boundaryRoot: string,
): Promise<Result<string>> {
  const raw = path.isAbsolute(outDir) ? outDir : `${cwd}${path.sep}${outDir}`;
  let physical: Awaited<ReturnType<typeof resolvePhysical>>;
  try {
    physical = await resolvePhysical(raw);
  } catch (err) {
    return failure(
      'E_OUTPUT_PATH',
      `cannot resolve the output directory ${outDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const workspaceLink = physical.links.find((link) =>
    isWithin(boundaryRoot, path.dirname(link)),
  );
  if (workspaceLink !== undefined) {
    return failure(
      'E_OUTPUT_PATH',
      `output path goes through the symlink ${workspaceLink} inside the workspace`,
      'Remove the link or pass --out outside the repository.',
    );
  }
  return success(physical.real);
}

/** Re-resolve and require the same canonical output directory, still link-free. */
async function confirmOutputDir(
  cwd: string,
  outDir: string,
  boundaryRoot: string,
  expected: string,
): Promise<Result<string>> {
  const again = await resolveOutputDir(cwd, outDir, boundaryRoot);
  if (!again.ok) return again;
  if (again.value !== expected) {
    return failure(
      'E_OUTPUT_PATH',
      `the output directory now resolves to ${again.value}, not ${expected}`,
    );
  }
  return again;
}
