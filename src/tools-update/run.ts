import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildFailedRunResult,
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
import { BASE_ENV_ALLOWLIST } from '@agent-ci/harness/env.js';
import {
  defaultProcessRunner,
  type ProcessRunner,
} from '@agent-ci/harness/install.js';
import { buildChangeSet, CHANGE_SET_FILE } from '@agent-ci/publish/changes.js';
import {
  ERROR_CODES,
  type ErrorCode,
  failure,
  success,
  type Result,
} from '@agent-ci/result.js';
import { detectChangedFiles, readHead } from '@agent-ci/run/changed-files.js';
import { RunLog } from '@agent-ci/run/run-log.js';
import {
  findWorkspaceRoot,
  isWithin,
  resolvePhysical,
} from '@agent-ci/run/workspace.js';
import { findDisallowedPaths } from '@agent-ci/use-cases/policy.js';
import {
  type DependencyPolicy,
  PATH_POLICIES,
  PRESETS,
  presetPathPolicy,
} from '@agent-ci/use-cases/presets.js';

/**
 * The deterministic tools-update runner, ported from pntr's
 * `oat-tools-update/run-tools-update.ts` (voxmedia/pntr@e438668): resolve
 * the pinned OAT CLI from npm, run `oat tools update --all` for the
 * repository's project scope, enforce the dependency policy on the changed
 * paths (fail closed), and hand the publish job the same canonical
 * `run-result.json` + `changes.json` an agent run writes. No model and no
 * credential is involved.
 *
 * Adapted: the CLI runs with a fresh, temporary HOME and XDG roots and an
 * allowlisted environment (no inherited credential, npm token or user-scope
 * OAT install is touched), from a temporary working directory with
 * `oat --cwd <repo>` (so the repository's own npm and pnpm configuration does
 * not steer `pnpm dlx`), with stdin closed and a deadline; the workspace
 * must start clean, and HEAD must not move.
 */

export const OAT_CLI_PACKAGE = '@open-agent-toolkit/cli';
const OAT_VERSION = /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
const VERSION_TIMEOUT_MS = 5 * 60_000;

export interface ToolsUpdateOptions {
  /** The target repository checkout. */
  readonly cwd: string;
  /** Output directory; must be outside the repository. */
  readonly outDir: string;
  readonly targetRepo: string;
  readonly oatCliVersion: string;
  readonly dependencyPolicy: DependencyPolicy;
  readonly timeoutMs: number;
  /** Parent environment: only allowlisted names reach the CLI. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ToolsUpdateDeps {
  readonly run?: ProcessRunner;
  readonly git?: string;
  /** Command for pnpm (tests point it at a fake). */
  readonly pnpm?: string;
}

export interface ToolsUpdateSummary {
  readonly result: ValidatedRunResult;
  readonly resultPath: string;
  readonly logPath: string;
  readonly changesPath: string | null;
  /** Set when the run failed after writing its failed result. */
  readonly error?: { readonly code: ErrorCode; readonly message: string };
}

/** The pinned `pnpm dlx` argv (pnpm wants --package before dlx). */
export function oatCliArgs(version: string, args: readonly string[]): string[] {
  return [`--package=${OAT_CLI_PACKAGE}@${version}`, 'dlx', 'oat', ...args];
}

function cliEnv(
  parent: ToolsUpdateOptions['env'],
  home: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    CI: 'true',
  };
}

const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' &&
  (ERROR_CODES as readonly string[]).includes(value);

const tail = (text: string) =>
  text.trim().split('\n').slice(-3).join(' | ').slice(0, 400);

export async function runToolsUpdate(
  options: ToolsUpdateOptions,
  deps: ToolsUpdateDeps = {},
): Promise<Result<ToolsUpdateSummary>> {
  const preset = PRESETS['tools-update'];
  if (!OAT_VERSION.test(options.oatCliVersion)) {
    return failure(
      'E_INVALID_INPUT',
      'the OAT CLI version must be latest or an exact semver version',
    );
  }
  const boundary = await findWorkspaceRoot(options.cwd, deps.git);
  if (!boundary.ok) return boundary;
  if (!boundary.value.git) {
    return failure(
      'E_WORKSPACE_STATUS',
      'tools-update needs a git checkout of the target repository',
    );
  }
  const root = boundary.value.root;
  let outDir: string;
  try {
    outDir = (await resolvePhysical(path.resolve(options.outDir))).real;
  } catch {
    return failure(
      'E_OUTPUT_PATH',
      `cannot resolve the output directory ${options.outDir}`,
    );
  }
  if (isWithin(root, outDir) || isWithin(outDir, root)) {
    return failure(
      'E_OUTPUT_PATH',
      'the output directory must be outside the repository',
      'Pass --out under $RUNNER_TEMP or another directory outside the checkout.',
    );
  }
  const before = await detectChangedFiles(root, [], deps.git);
  if (!before.ok) return before;
  if (before.value.length > 0) {
    return failure(
      'E_WORKSPACE_STATUS',
      `the checkout has ${before.value.length} uncommitted change(s); tools-update starts from a clean checkout`,
    );
  }
  const baseHead = await readHead(root, deps.git);
  if (!baseHead.ok) return baseHead;

  const secrets = secretValuesFromEnv(options.env, KNOWN_CREDENTIAL_ENV);
  const log = new RunLog(secrets);
  const run = deps.run ?? defaultProcessRunner;
  const pnpm = deps.pnpm ?? 'pnpm';
  const identity = {
    useCase: preset.useCase,
    targetRepo: options.targetRepo,
    outputContract: preset.outputContract,
  };
  const policyName = presetPathPolicy('tools-update', options.dependencyPolicy);
  log.add('tools-update.started', {
    package: OAT_CLI_PACKAGE,
    version: options.oatCliVersion,
    dependencyPolicy: options.dependencyPolicy,
    baseSha: baseHead.value,
  });

  let result: ValidatedRunResult;
  let error: { code: ErrorCode; message: string } | undefined;
  let changeSet: string | undefined;
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-tools-home-'));
  try {
    const env = cliEnv(options.env, home);
    const deadline = Date.now() + options.timeoutMs;
    const version = await run(
      pnpm,
      oatCliArgs(options.oatCliVersion, ['--version']),
      {
        cwd: home,
        env,
        timeoutMs: Math.min(VERSION_TIMEOUT_MS, options.timeoutMs),
      },
    );
    const resolved = version.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    if (version.exitCode !== 0 || !/^\d+\.\d+\.\d+\S*$/u.test(resolved)) {
      throw Object.assign(
        new Error(
          `cannot resolve ${OAT_CLI_PACKAGE}@${options.oatCliVersion}: ${tail(version.stderr) || `exit ${version.exitCode ?? 'timeout'}`}`,
        ),
        { code: 'E_TOOLS_UPDATE' },
      );
    }
    log.add('tools-update.cli', { version: resolved });
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error('the deadline passed'), {
        code: 'E_TOOLS_UPDATE',
      });
    }
    const update = await run(
      pnpm,
      oatCliArgs(options.oatCliVersion, [
        '--cwd',
        root,
        'tools',
        'update',
        '--all',
        '--scope',
        'project',
      ]),
      { cwd: home, env, timeoutMs: remaining },
    );
    if (update.exitCode !== 0) {
      throw Object.assign(
        new Error(
          `oat tools update failed: ${tail(update.stderr) || `exit ${update.exitCode ?? 'timeout'}`}`,
        ),
        { code: 'E_TOOLS_UPDATE' },
      );
    }
    log.add('tools-update.finished', {});
    const headAfter = await readHead(root, deps.git);
    if (!headAfter.ok || headAfter.value !== baseHead.value) {
      throw Object.assign(
        new Error('oat tools update moved HEAD; commits are not published'),
        { code: 'E_WORKSPACE_STATUS' },
      );
    }
    const changed = await detectChangedFiles(root, [], deps.git);
    if (!changed.ok) {
      throw Object.assign(new Error(changed.message), { code: changed.code });
    }
    log.add('tools-update.changes', { fileCount: changed.value.length });
    const refused = findDisallowedPaths(
      changed.value,
      PATH_POLICIES[policyName],
    );
    if (refused.length > 0) {
      throw Object.assign(
        new Error(
          `oat tools update changed files outside the ${options.dependencyPolicy} policy: ${refused.slice(0, 10).join(', ')}`,
        ),
        { code: 'E_PATH_POLICY' },
      );
    }
    const candidate = {
      ok: true,
      status: changed.value.length > 0 ? 'changed' : 'no-op',
      useCase: preset.useCase,
      targetRepo: options.targetRepo,
      summary:
        changed.value.length > 0
          ? `oat tools update (${OAT_CLI_PACKAGE}@${resolved}) changed ${changed.value.length} file(s).`
          : `oat tools update (${OAT_CLI_PACKAGE}@${resolved}) produced no changes.`,
      artifacts: [],
      materializedArtifacts: [],
      changedFiles: changed.value,
      errors: [],
      oatCliVersion: resolved,
      dependencyPolicy: options.dependencyPolicy,
      outputContract: preset.outputContract,
    };
    const guarded = assertSecretFree(candidate, secrets);
    if (!guarded.ok) {
      throw Object.assign(new Error(guarded.message), { code: guarded.code });
    }
    const validated = validateRunResult(candidate, {
      outputContract: preset.outputContract,
    });
    if (!validated.ok) {
      throw Object.assign(new Error(validated.message), {
        code: validated.code,
      });
    }
    result = validated.value;
    if (changed.value.length > 0) {
      const built = await buildChangeSet({
        root,
        files: changed.value,
        baseSha: baseHead.value,
        secrets,
      });
      if (!built.ok) {
        throw Object.assign(new Error(built.message), { code: built.code });
      }
      changeSet = `${JSON.stringify(built.value)}\n`;
    }
  } catch (err) {
    const raw = (err as { code?: unknown }).code;
    const code: ErrorCode = isErrorCode(raw) ? raw : 'E_TOOLS_UPDATE';
    error = {
      code,
      message: maskSecrets(
        err instanceof Error ? err.message : String(err),
        secrets,
      ),
    };
    result = buildFailedRunResult({ ...identity, ...error });
    changeSet = undefined;
    log.add('tools-update.failed', {
      code: error.code,
      message: error.message,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  log.add('run.result', { ok: result.ok, status: result.status });
  await mkdir(outDir, { recursive: true });
  const resultPath = path.join(outDir, 'run-result.json');
  const logPath = path.join(outDir, 'run-log.jsonl');
  const changesPath = path.join(outDir, CHANGE_SET_FILE);
  await rm(changesPath, { force: true });
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
    changesPath: changeSet === undefined ? null : changesPath,
    ...(error === undefined ? {} : { error }),
  });
}
