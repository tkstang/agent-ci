import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  extractStructuredResult,
  parseJsonPayload,
} from '@agent-ci/contracts/final-answer.js';
import { finalizeRunResult } from '@agent-ci/contracts/finalize.js';
import {
  buildFailedRunResult,
  type OutputContract,
  validateRunResult,
  type ValidatedRunResult,
} from '@agent-ci/contracts/run-result.js';
import {
  assertSecretFree,
  KNOWN_CREDENTIAL_ENV,
  maskSecrets,
  secretValuesFromEnv,
} from '@agent-ci/contracts/secret-guard.js';
import { writeOwnedFile } from '@agent-ci/files.js';
import type { GitPin } from '@agent-ci/git/safe-git.js';
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
import {
  type RunHarnessDeps,
  runHarness,
  UnsupportedPostureError,
} from '@agent-ci/harness/run.js';
import {
  fingerprintSkills,
  purgeSkills,
} from '@agent-ci/harness/skills-integrity.js';
import type {
  HarnessOutcome,
  RunMode,
  ToolBridge,
  Usage,
} from '@agent-ci/harness/types.js';
import { buildChangeSet, CHANGE_SET_FILE } from '@agent-ci/publish/changes.js';
import {
  type Failure,
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
  resolveWorkspaceGitPin,
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
  /**
   * A structured run (PR review passes, the adjudicator): `prompt` is the
   * complete prompt, the answer is a JSON value checked by `accept`, and the
   * accepted value is written to `<out>/<outputFile>`. Read-only only.
   */
  readonly structured?: StructuredRunOptions;
}

/**
 * A run whose answer is one JSON value instead of a RunResult. Harnesses
 * with native structured output get `schema` (Claude `--json-schema`, Codex
 * `--output-schema`); the others are told the shape in the prompt and their
 * final text is parsed. An answer that `accept` rejects gets at most one
 * repair turn by session resume, on harnesses whose resume is verified.
 */
export interface StructuredRunOptions {
  readonly schema: Record<string, unknown>;
  /**
   * Check the untrusted answer and return the value to keep. `final` is
   * false for the first answer (a failure earns the repair turn when one is
   * available) and true for the last chance (keep what can be kept; a failure
   * fails the run).
   */
  readonly accept: (candidate: unknown, final: boolean) => Result<unknown>;
  /** The repair turn's prompt, given the problem `accept` reported. */
  readonly repairPrompt: (problem: string) => string;
  /** File name (no directory) written under the output directory. */
  readonly outputFile: string;
  /** One-line summary of an accepted value for run-result.json. */
  readonly describe: (value: unknown) => string;
  /**
   * Offer the agent no tools at all. Only harnesses with a verified
   * tool-free posture (Claude; the fake harness) may run it.
   */
  readonly noTools?: boolean;
  /**
   * One agent-ci MCP server tool the agent may call (verify-review's
   * `run_check`). Read-only and only on harnesses with a verified bridge;
   * every turn (attempts and the repair turn) gets it.
   */
  readonly toolBridge?: ToolBridge;
}

/** How the structured answer was obtained. */
export type RepairOutcome =
  | 'not-needed'
  | 'repaired'
  | 'repair-failed'
  | 'unavailable';

const RESERVED_OUTPUTS = new Set([
  'run-result.json',
  'run-log.jsonl',
  'prompt.md',
  CHANGE_SET_FILE,
]);

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
  /** A structured run's accepted value file, or null. */
  readonly structuredPath?: string | null;
  /** A structured run's repair outcome. */
  readonly repair?: RepairOutcome;
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

  const structured = options.structured;
  if (structured !== undefined) {
    const refused = checkStructured(structured, options, route);
    if (refused !== undefined) return refused;
  }
  const prompt =
    structured !== undefined
      ? options.prompt.trim() === ''
        ? failure('E_INVALID_INPUT', 'the prompt is empty')
        : success(options.prompt)
      : buildRunPrompt({
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
  const pinned = boundary.value.git
    ? await resolveWorkspaceGitPin(options.cwd, boundaryRoot, deps.git)
    : success<GitPin | undefined>(undefined);
  if (!pinned.ok) return pinned;
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
      pinned.value,
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
  workspacePin: GitPin | undefined,
): Promise<Result<RunSummary>> {
  const boundaryRoot = boundary.root;
  const now = deps.now ?? Date.now;
  // Baseline first: anything that lands in the workspace from here on,
  // including a seeded login, is a change the run reports, never hidden dirt.
  const baseline = await snapshotWorkspace(
    options.cwd,
    [outDir],
    deps.git,
    workspacePin,
  );
  // The commit an edit run starts from: the change set is based on it, and a
  // run that moves HEAD (commits) is refused, because commits are not
  // visible to change detection and would never be published.
  const baseHead =
    options.mode === 'edit'
      ? await readHead(boundaryRoot, deps.git, workspacePin)
      : success<string | null>(null);
  if (options.skillsDir !== undefined) {
    const seeded = await seedSkills(homeRoot, options.skillsDir);
    if (!seeded.ok) return seeded;
  }
  // The installed skills are trusted instructions: fingerprint them before
  // any agent turn, so a turn that changes them fails closed (below).
  const skillsBefore = await fingerprintSkills(homeRoot);
  if (!skillsBefore.ok) return skillsBefore;
  // The run's timeout starts here, so the login transfer below counts
  // against it: a hung export or import cannot outlive the run's deadline.
  const deadlineAtMs = now() + options.timeoutMs;
  const seededSecrets: string[] = [];
  if (route.login) {
    const seeded = await seedLogin(homeRoot, {
      harness: route.harness,
      parentEnv: options.env,
      timeoutMs: Math.max(1, deadlineAtMs - now()),
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
  // The harness had write access to its home. After every harness turn
  // (each attempt, before promotion or a retry, and the repair turn), refuse
  // to trust anything if it redirected part of the home out of the root or
  // into the workspace, or changed the installed skills (trusted
  // instructions a later attempt would load). A changed or unreachable skill
  // tree is purged without following any link, so a kept home never carries
  // it forward. Returns false when the home can no longer be trusted.
  const checkHome = async (): Promise<boolean> => {
    let trusted = true;
    const valid = await validateHomeTree(homeRoot.root, boundaryRoot);
    if (!valid.ok) {
      guardFailure ??= { code: valid.code, message: valid.message };
      trusted = false;
    }
    const after = await fingerprintSkills(homeRoot);
    if (!after.ok || after.value !== skillsBefore.value) {
      await purgeSkills(homeRoot);
      log.add('skills.changed', { purged: true });
      guardFailure ??= {
        code: 'E_HOME_ROOT',
        message:
          'the run changed the skills installed for it; they were removed from the home root',
      };
      trusted = false;
    }
    if (!trusted) log.withholdFreeText();
    return trusted;
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
  // A change set (or structured answer) left by an earlier run in this
  // directory must never be published with this run's result.
  await rm(changesPath, { force: true });
  const structuredPath =
    options.structured === undefined
      ? undefined
      : path.join(outDir, options.structured.outputFile);
  if (structuredPath !== undefined) await rm(structuredPath, { force: true });
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
          deadlineAtMs,
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
                  ...(options.structured === undefined
                    ? {}
                    : {
                        jsonSchema: options.structured.schema,
                        noTools: options.structured.noTools === true,
                        ...(options.structured.toolBridge === undefined
                          ? {}
                          : { toolBridge: options.structured.toolBridge }),
                      }),
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
                      : err instanceof UnsupportedPostureError
                        ? 'E_POLICY_HARNESS'
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
            // Before promotion and before a retry could load the same home.
            if (!(await checkHome())) {
              const reason = guardFailure as
                | { code: ErrorCode; message: string }
                | undefined;
              outcome = {
                ok: false,
                // The run's error comes from guardFailure; this stops retries.
                code: 'E_HOME_ROOT',
                retryable: false,
                message:
                  reason?.message ?? 'the home root can no longer be trusted',
              };
            }
            let promoted: readonly string[] | undefined;
            if (copy !== undefined) {
              // Only a successful attempt's changes reach the workspace; a
              // failed attempt's copy is discarded with its partial edits.
              if (outcome.ok && baseline.ok && baseHead.ok) {
                // Pinned to the copy: its configuration (core.worktree,
                // config.worktree) cannot redirect agent-ci's own git calls.
                const pin = {
                  gitDir: path.join(copy.value.root, '.git'),
                  workTree: copy.value.root,
                };
                const copyHead = await readHead(copy.value.root, deps.git, pin);
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
                        pin,
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

  // Once more after the supervisor (also covers a run with no attempt).
  await checkHome();
  let outcome = supervised.result.outcome;
  let result: ValidatedRunResult;
  let error: { code: ErrorCode; message: string } | undefined;
  /** Changes detected by git (never the agent's own claims). */
  let detected: readonly string[] = [];
  let structuredValue: { value: unknown } | undefined;
  let repair: RepairOutcome | undefined;
  if (outcome.ok && options.structured !== undefined) {
    const structured = options.structured;
    const first = structuredAnswer(outcome);
    let accepted = first.ok ? structured.accept(first.value, false) : first;
    repair = 'not-needed';
    if (!accepted.ok) {
      const remaining = deadlineAtMs - now();
      const sessionId = outcome.sessionId;
      if (
        adapter.supportsResume &&
        sessionId !== undefined &&
        remaining > 1_000 &&
        guardFailure === undefined
      ) {
        const repaired = await repairTurn({
          adapter,
          route,
          prompt: structured.repairPrompt(accepted.message),
          sessionId,
          cwd: options.cwd,
          mode: options.mode,
          homeRoot,
          parentEnv: options.env,
          schema: structured.schema,
          noTools: structured.noTools === true,
          ...(structured.toolBridge === undefined
            ? {}
            : { toolBridge: structured.toolBridge }),
          timeoutMs: remaining,
          ...(deps.harness === undefined ? {} : { harness: deps.harness }),
        });
        if (!(await refreshLoginSecrets())) {
          repaired.outcome = {
            ok: false,
            code: 'E_SECRET_GUARD',
            retryable: false,
            // refreshLoginSecrets set guardFailure (TS cannot see it).
            message:
              (guardFailure as { message: string } | undefined)?.message ??
              'credential guard incomplete',
          };
        }
        // The repair turn had the same write access to its home.
        await checkHome();
        log.add('repair', {
          harness: route.harness,
          ok: repaired.outcome.ok,
          problem: maskSecrets(accepted.message, secrets),
          ...(repaired.outcome.ok
            ? {}
            : {
                code: repaired.outcome.code,
                message: maskSecrets(repaired.outcome.message, secrets),
              }),
          usage: repaired.outcome.usage ?? null,
          durationMs: repaired.durationMs ?? null,
        });
        outcome = {
          ...outcome,
          usage: addUsage(outcome.usage, repaired.outcome.usage ?? null),
        };
        const second = repaired.outcome.ok
          ? structuredAnswer(repaired.outcome)
          : failure(repaired.outcome.code, repaired.outcome.message);
        const kept = second.ok ? structured.accept(second.value, true) : second;
        if (kept.ok) {
          accepted = kept;
          repair = 'repaired';
        } else {
          // The repair did not help: keep what the first answer allows.
          repair = 'repair-failed';
          accepted = first.ok ? structured.accept(first.value, true) : kept;
        }
      } else {
        repair = 'unavailable';
        accepted = first.ok ? structured.accept(first.value, true) : first;
      }
    }
    if (accepted.ok) {
      const guarded = assertSecretFree(accepted.value, secrets);
      if (guarded.ok) {
        structuredValue = { value: accepted.value };
        const summary = structured.describe(accepted.value);
        const validated = validateRunResult(
          {
            ok: true,
            status: 'no-op',
            useCase: options.useCase.trim() || 'generic-prompt',
            targetRepo: options.targetRepo.trim() || 'unknown',
            summary,
            artifacts: [
              {
                label: 'structured-output',
                path: structured.outputFile,
                kind: 'file',
              },
            ],
            materializedArtifacts: [],
            changedFiles: [],
            errors: [],
            report: { title: options.useCase, markdown: summary },
            repair,
          },
          { outputContract: 'report' },
        );
        if (validated.ok) {
          result = validated.value;
        } else {
          error = { code: validated.code, message: validated.message };
          result = buildFailedRunResult({ ...options, ...error });
        }
      } else {
        error = { code: guarded.code, message: guarded.message };
        result = buildFailedRunResult({ ...options, ...error });
      }
    } else {
      error = {
        code: accepted.code,
        message: maskSecrets(accepted.message, secrets),
      };
      result = buildFailedRunResult({ ...options, ...error });
    }
  } else if (outcome.ok) {
    const candidate =
      outcome.structured === undefined
        ? extractStructuredResult(outcome.finalText)
        : success(outcome.structured);
    const changed = baseline.ok
      ? await changedSince(
          options.cwd,
          baseline.value,
          [outDir],
          deps.git,
          workspacePin,
        )
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
        ? await readHead(boundaryRoot, deps.git, workspacePin)
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
  // A structured answer is written only for a run that ended without error.
  if (error !== undefined) structuredValue = undefined;
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
  if (structuredPath !== undefined && structuredValue !== undefined) {
    await writeOwnedFile(
      structuredPath,
      `${JSON.stringify(structuredValue.value, null, 2)}\n`,
      0o644,
    );
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
    ...(options.structured === undefined
      ? {}
      : {
          structuredPath:
            structuredValue === undefined ? null : (structuredPath ?? null),
          ...(repair === undefined ? {} : { repair }),
        }),
  });
}

/** The harness's structured output, else its final text parsed as JSON. */
function structuredAnswer(
  from: HarnessOutcome & { ok: true },
): Result<unknown> {
  return from.structured === undefined
    ? parseJsonPayload(from.finalText)
    : success(from.structured);
}

/** Refuse a structured run the route or options cannot support. */
function checkStructured(
  structured: StructuredRunOptions,
  options: RunOptions,
  route: Route,
): Failure | undefined {
  if (options.mode !== 'read-only') {
    return failure('E_INVALID_INPUT', 'a structured run is read-only');
  }
  const name = structured.outputFile;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) ||
    RESERVED_OUTPUTS.has(name)
  ) {
    return failure(
      'E_INVALID_INPUT',
      `invalid structured output file name ${name}`,
    );
  }
  if (
    structured.noTools === true &&
    !adapterFor(route.harness).supportsNoTools
  ) {
    return failure(
      'E_POLICY_HARNESS',
      `route ${route.id} runs on ${route.harness}, which has no verified tool-free posture`,
      'Pick a Claude route for a tool-free run (the PR-review adjudicator).',
    );
  }
  if (
    structured.toolBridge !== undefined &&
    !adapterFor(route.harness).supportsToolBridge
  ) {
    return failure(
      'E_POLICY_HARNESS',
      `route ${route.id} runs on ${route.harness}, which has no verified tool bridge (verify-review's run_check)`,
      'Pick a Claude or Codex route for verify-review.',
    );
  }
  return undefined;
}

/** Sum two usage reports; a counter either side lacks stays unknown. */
export function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (a === null || b === null) return a ?? b;
  const keys = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const;
  const sum: Record<string, number> = {};
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (left !== undefined && right !== undefined) sum[key] = left + right;
  }
  return Object.keys(sum).length === 0 ? null : (sum as Usage);
}

interface RepairInput {
  readonly adapter: ReturnType<typeof adapterFor>;
  readonly route: Route;
  readonly prompt: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly mode: RunMode;
  readonly homeRoot: HomeRoot;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly schema: Record<string, unknown>;
  readonly noTools: boolean;
  readonly toolBridge?: ToolBridge;
  readonly timeoutMs: number;
  readonly harness?: RunHarnessDeps;
}

/** The single repair turn: the same posture, resuming the answer's session. */
async function repairTurn(
  input: RepairInput,
): Promise<{ outcome: HarnessOutcome; durationMs?: number }> {
  const scratchDir = await mkdtemp(path.join(input.homeRoot.root, 'repair-'));
  try {
    const run = await runHarness(
      input.adapter,
      {
        route: input.route,
        prompt: input.prompt,
        cwd: input.cwd,
        mode: input.mode,
        home: input.homeRoot,
        scratchDir,
        parentEnv: input.parentEnv,
        jsonSchema: input.schema,
        noTools: input.noTools,
        ...(input.toolBridge === undefined
          ? {}
          : { toolBridge: input.toolBridge }),
        resumeSessionId: input.sessionId,
      },
      { timeoutMs: input.timeoutMs },
      input.harness,
    );
    return {
      outcome: run.outcome,
      ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    };
  } catch (err) {
    return {
      outcome: {
        ok: false,
        code:
          err instanceof CredentialLeakError
            ? 'E_CREDENTIAL_LEAK'
            : err instanceof UnsupportedPostureError
              ? 'E_POLICY_HARNESS'
              : 'E_HARNESS_FAILED',
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
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
