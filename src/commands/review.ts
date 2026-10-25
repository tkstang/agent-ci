import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

import {
  nonNegativeInt,
  oneOf,
  optional,
  parseFlags,
  poolOptIn,
  positiveInt,
  required,
} from '@agent-ci/commands/flags.js';
import { appendGithubOutput } from '@agent-ci/commands/github.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { digestResultDir } from '@agent-ci/publish/digest.js';
import type { ErrorCode } from '@agent-ci/result.js';
import {
  buildAdjudicationSources,
  collectCandidates,
  promptCandidates,
} from '@agent-ci/review/adjudicate.js';
import {
  isReviewError,
  REVIEW_WORKFLOW,
  type ReviewIdentity,
  SCOPE,
  sha256,
} from '@agent-ci/review/contracts.js';
import { parseUnifiedDiff } from '@agent-ci/review/diff-position.js';
import {
  gateArtifacts,
  GATED_FILES,
  loadAdjudicationDir,
  loadPassDir,
  postedMarkers,
  usageRows,
} from '@agent-ci/review/findings.js';
import { fetchTransport, GithubClient } from '@agent-ci/review/github.js';
import { runLocalReview } from '@agent-ci/review/local.js';
import {
  loadSpecDir,
  reviewPass,
  runReviewPass,
} from '@agent-ci/review/pass.js';
import {
  prepareReview,
  SPEC_FILES,
  verifyRequest,
} from '@agent-ci/review/prepare.js';
import { publishGated } from '@agent-ci/review/publish.js';
import {
  ACTIONS_PUBLISHER,
  type PublisherIdentity,
} from '@agent-ci/review/render.js';
import { runAdjudicator } from '@agent-ci/review/run-adjudicator.js';
import {
  citedSources,
  fetchSources,
  mapReader,
  readSourceSnapshot,
  referencedSources,
  writeSourceSnapshot,
} from '@agent-ci/review/sources.js';
import {
  acknowledgeRequest,
  authorizeRequest,
  configureRequest,
  type ConfigureOutcome,
  parseAllowedModels,
  parseAllowedPrAuthors,
  parsePolicy,
  type ReviewPolicy,
} from '@agent-ci/review/trigger.js';
import { runVerify } from '@agent-ci/review/verify.js';
import { loadModelsFile } from '@agent-ci/routing/resolve.js';
import { HARNESS_IDS } from '@agent-ci/routing/schema.js';

/**
 * `agent-ci review <stage>`: one subcommand per PR review job step, plus
 * `run` for a whole local review. Each stage reads and writes files, prints
 * one JSON envelope, and with `--github-output` writes single-line step
 * outputs. Commenter text never becomes a step output.
 */

const USAGE = `agent-ci review — AI pull-request review stages.

Stages (each one job step in pr-review.yml):
  gate        Authorize the request, check models, consume the label or
              reply once, and write the bound request.json (GitHub token).
  prepare     Build the digest-bound review spec and diff (GitHub token).
  verify      verify-review only: run the configured checks on the PR head
              in a controlled environment and record checks.json (no model
              credential, no GitHub token, no helper token).
  pass        Run one reviewer pass read-only on the PR head checkout
              (model credential; no GitHub token).
  sources     Fetch the cited source the adjudicator will see (GitHub
              token; no model credential, no checkout).
  adjudicate  Run the tool-free adjudicator (Claude only; model credential).
  findings    Gate every pass and the adjudication deterministically
              (read-only GitHub token; no checkout).
  publish     Post one inline review and the summary comment (GitHub token;
              no model credential).
  run         The whole review on this machine for a repository you can
              push to: gate, spec, passes in a worktree at the PR head,
              adjudicator, findings and, with --publish, publication.

Run \`agent-ci review <stage> --help\` for the stage's flags.
The GitHub token comes from GITHUB_TOKEN (or GH_TOKEN) and is never printed.`;

type Deps = { readonly fetch?: typeof fetch; readonly git?: string };

function githubClient(env: CommandContext['env'], deps: Deps): GithubClient {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '';
  if (token.trim() === '')
    throw new CliError('E_GITHUB_API', 'set GITHUB_TOKEN or GH_TOKEN');
  return new GithubClient(
    fetchTransport(
      token,
      env.GITHUB_API_URL || 'https://api.github.com',
      deps.fetch ?? fetch,
    ),
  );
}

function repoOf(flag: string | undefined, env: CommandContext['env']): string {
  return required(optional(flag) ?? env.GITHUB_REPOSITORY, '--repo');
}

/** Run a stage body, turning review errors into CLI errors. */
async function stage<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (isReviewError(error)) throw new CliError(error.code, error.message);
    throw error;
  }
}

function publisherOf(login: string | undefined): PublisherIdentity {
  const value = optional(login);
  if (value === undefined) return ACTIONS_PUBLISHER;
  return { login: value, type: value.endsWith('[bot]') ? 'Bot' : 'User' };
}

function policyFlags(flags: Record<string, unknown>): ReviewPolicy {
  return parsePolicy({
    failOnSeverity: flags['fail-on-severity'] as string | undefined,
    minInlineSeverity: flags['min-inline-severity'] as string | undefined,
    maxInlineComments: flags['max-inline-comments'] as string | undefined,
  });
}

function bool(value: string | undefined, flag: string): boolean {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '' || text === 'false') return false;
  if (text === 'true') return true;
  throw new CliError('E_INVALID_INPUT', `${flag} must be true or false`);
}

async function summary(env: CommandContext['env'], markdown: string) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file !== undefined && file !== '')
    await appendFile(file, `${markdown}\n`);
}

function runIdentity(env: CommandContext['env']) {
  return {
    runId: required(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    runAttempt: required(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
  };
}

const POLICY_FLAGS = {
  'fail-on-severity': { type: 'string' },
  'min-inline-severity': { type: 'string' },
  'max-inline-comments': { type: 'string' },
} as const;
const PASS_DIR_FLAGS = {
  'primary-dir': { type: 'string' },
  'primary-digest': { type: 'string' },
  'second-dir': { type: 'string' },
  'second-digest': { type: 'string' },
} as const;
const SPEC_FLAGS = {
  'spec-dir': { type: 'string' },
  'spec-sha256': { type: 'string' },
  repo: { type: 'string' },
} as const;
const ROUTE_FLAGS = {
  route: { type: 'string' },
  harness: { type: 'string' },
  'allow-pool': { type: 'boolean' },
  'allow-pool-value': { type: 'string' },
  'seed-login': { type: 'boolean' },
  'home-root': { type: 'string' },
  'timeout-minutes': { type: 'string' },
  models: { type: 'string' },
  'credential-from-env': { type: 'boolean' },
} as const;

// --- gate ------------------------------------------------------------------

const GATE_USAGE = `agent-ci review gate — authorize a review request (GitHub token).

  --out <dir>                    Where request.json is written (required).
  --event-name / --event-path    Default $GITHUB_EVENT_NAME / $GITHUB_EVENT_PATH.
  --repo <owner/name>            Default $GITHUB_REPOSITORY.
  --dispatch-pr <n> --dispatch-command <text>
                                 workflow_dispatch inputs.
  --allowed-pr-authors <list>    Bot PR authors trusted for review.
  --reviewer-model <model>       Primary reviewer model (required).
  --second-reviewer <true|false> --second-reviewer-model <model>
  --adjudicator <true|false> --adjudicator-model <model>
  --allowed-models <list>        Models a request may select (required).
  --fail-on-severity, --min-inline-severity, --max-inline-comments
                                 Publication policy (checked here).
  --publisher-login <login>      Account whose replies are recognized.
  --verify <true|false>          Allow verify-review requests (the workflow's
                                 verify input; default false).
  --allow-pool | --allow-pool-value <true|false>
                                 Let pool models resolve (in CI only on a
                                 self-hosted runner, never a Claude model);
                                 the workflow's allow_pool input.
  --models <path>                Routing table.
  --github-output                should_run, pr_number, head_sha, base_ref,
                                 request_sha256 and the pass models.`;

async function gate(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      out: { type: 'string' },
      'event-name': { type: 'string' },
      'event-path': { type: 'string' },
      repo: { type: 'string' },
      'dispatch-pr': { type: 'string' },
      'dispatch-command': { type: 'string' },
      'allowed-pr-authors': { type: 'string' },
      'reviewer-model': { type: 'string' },
      'second-reviewer': { type: 'string' },
      'second-reviewer-model': { type: 'string' },
      adjudicator: { type: 'string' },
      'adjudicator-model': { type: 'string' },
      'allowed-models': { type: 'string' },
      'publisher-login': { type: 'string' },
      verify: { type: 'string' },
      models: { type: 'string' },
      'allow-pool': { type: 'boolean' },
      'allow-pool-value': { type: 'string' },
      'github-output': { type: 'boolean' },
      ...POLICY_FLAGS,
    },
    GATE_USAGE,
  );
  // The same strict opt-in the route and pass commands use; checked before
  // anything is acknowledged or bound.
  const allowPool = poolOptIn(flags);
  const verifyEnabled = bool(flags.verify, '--verify');
  const { env } = context;
  const out = path.resolve(context.cwd, required(flags.out, '--out'));
  const repository = repoOf(flags.repo, env);
  const eventName = required(
    optional(flags['event-name']) ?? env.GITHUB_EVENT_NAME,
    '--event-name',
  );
  const eventPath = required(
    optional(flags['event-path']) ?? env.GITHUB_EVENT_PATH,
    '--event-path',
  );
  let event: unknown;
  try {
    event = JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    throw new CliError(
      'E_INVALID_INPUT',
      `cannot read the event payload ${eventPath}`,
    );
  }
  const output = async (entries: Record<string, string>) => {
    if (flags['github-output'] === true) await appendGithubOutput(env, entries);
  };
  return await stage(async () => {
    const github = githubClient(env, deps);
    const authorized = await authorizeRequest({
      github,
      repository,
      eventName,
      event,
      ...(flags['dispatch-pr'] === undefined
        ? {}
        : { dispatchPrNumber: flags['dispatch-pr'] }),
      ...(flags['dispatch-command'] === undefined
        ? {}
        : { dispatchCommand: flags['dispatch-command'] }),
      allowedPrAuthors: parseAllowedPrAuthors(flags['allowed-pr-authors']),
    });
    if (authorized.status !== 'authorized') {
      await output({ should_run: 'false', reason: authorized.reason });
      if (authorized.status === 'skip')
        await summary(
          env,
          `## agent-ci PR review skipped\n\n${authorized.notice} (\`${authorized.reason}\`)`,
        );
      return {
        shouldRun: false,
        status: authorized.status,
        reason: authorized.reason,
      };
    }
    const models = await loadModelsFile(
      flags.models === undefined
        ? DEFAULT_MODELS_PATH
        : path.resolve(context.cwd, flags.models),
    );
    if (!models.ok) throw CliError.fromFailure(models);
    let configured: ConfigureOutcome;
    try {
      // Caller configuration (policy, allowed models) fails before anything
      // is spent; the requester is told the workflow is misconfigured.
      policyFlags(flags);
      const reviewerModel = required(
        flags['reviewer-model'],
        '--reviewer-model',
      );
      configured = configureRequest({
        authorized: authorized.authorized,
        defaults: {
          reviewer_model: reviewerModel,
          second_reviewer: bool(flags['second-reviewer'], '--second-reviewer'),
          second_reviewer_model:
            optional(flags['second-reviewer-model']) ?? reviewerModel,
          adjudicator: bool(flags.adjudicator, '--adjudicator'),
          adjudicator_model:
            optional(flags['adjudicator-model']) ?? reviewerModel,
        },
        allowedModels: parseAllowedModels(
          required(flags['allowed-models'], '--allowed-models'),
        ),
        models: models.value,
        env,
        allowPool,
        verifyEnabled,
      });
    } catch (error) {
      if (!isReviewError(error)) throw error;
      configured = {
        status: 'failed',
        failure: { route: 'configuration', detail: error.message },
      };
    }
    const acknowledged = await acknowledgeRequest({
      github,
      repository,
      runId: required(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
      authorized: authorized.authorized,
      configured,
      reply: true,
      acknowledge: true,
      publisherLogin: publisherOf(flags['publisher-login']).login,
    });
    if (acknowledged.status === 'failed') {
      await output({
        should_run: 'false',
        reason: `${acknowledged.failure.route}-error`,
      });
      await summary(
        env,
        `## agent-ci PR review did not start\n\n${acknowledged.text}`,
      );
      throw new CliError(
        'E_REVIEW_REQUEST',
        `the review did not start (${acknowledged.failure.route} error; reply ${acknowledged.reply}): ${acknowledged.failure.detail}`,
      );
    }
    const { record } = acknowledged;
    const text = `${JSON.stringify(record, null, 2)}\n`;
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'request.json'), text, { flag: 'wx' });
    const requestSha256 = sha256(text);
    await output({
      should_run: 'true',
      reason: 'authorized',
      pr_number: String(record.pr_number),
      mode: record.config.mode,
      base_ref: record.base_ref,
      head_sha: record.head_sha,
      request_sha256: requestSha256,
      reviewer_model: record.config.primary.model,
      second_enabled: String(record.config.second.enabled),
      second_reviewer_model: record.config.second.model,
      adjudicator_enabled: String(record.config.adjudicator.enabled),
      adjudicator_model: record.config.adjudicator.model,
    });
    await summary(env, acknowledged.text);
    return {
      shouldRun: true,
      prNumber: record.pr_number,
      headSha: record.head_sha,
      requestSha256,
    };
  });
}

// --- prepare ---------------------------------------------------------------

const PREPARE_USAGE = `agent-ci review prepare — bind the review spec and diff (GitHub token).

  --request <file> --request-sha256 <hex>   The gate's request and digest.
  --out <dir>                               spec.json and pr.diff.
  --repo <owner/name>                       Default $GITHUB_REPOSITORY.
  --repo-guidance <text> --repo-guidance-path <path> --context-paths <list>
  --github-output                           spec_sha256, diff_truncated, error_code.`;

async function prepare(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      request: { type: 'string' },
      'request-sha256': { type: 'string' },
      out: { type: 'string' },
      repo: { type: 'string' },
      'repo-guidance': { type: 'string' },
      'repo-guidance-path': { type: 'string' },
      'context-paths': { type: 'string' },
      'github-output': { type: 'boolean' },
    },
    PREPARE_USAGE,
  );
  const { env } = context;
  const output = async (entries: Record<string, string>) => {
    if (flags['github-output'] === true) await appendGithubOutput(env, entries);
  };
  const out = path.resolve(context.cwd, required(flags.out, '--out'));
  try {
    return await stage(async () => {
      const repository = repoOf(flags.repo, env);
      const requestPath = path.resolve(
        context.cwd,
        required(flags.request, '--request'),
      );
      const record = verifyRequest(
        await readFile(requestPath, 'utf8'),
        required(flags['request-sha256'], '--request-sha256'),
        repository,
      );
      const result = await prepareReview({
        github: githubClient(env, deps),
        request: record,
        guidance: {
          repo_guidance: flags['repo-guidance'] ?? '',
          repo_guidance_path: flags['repo-guidance-path'] ?? '',
          context_paths: flags['context-paths'] ?? '',
        },
      });
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, SPEC_FILES.spec), result.specText, {
        flag: 'wx',
      });
      await writeFile(path.join(out, SPEC_FILES.diff), result.diffText, {
        flag: 'wx',
      });
      await output({
        spec_sha256: result.specSha256,
        diff_truncated: String(result.spec.diff.truncated),
        error_code: '',
      });
      return {
        specSha256: result.specSha256,
        diffTruncated: result.spec.diff.truncated,
      };
    });
  } catch (error) {
    if (error instanceof CliError) await output({ error_code: error.code });
    throw error;
  }
}

// --- verify ----------------------------------------------------------------

const VERIFY_USAGE = `agent-ci review verify — run the configured checks (verify-review).

Runs every check in the spec's checks configuration (read from the base
commit) on the PR head checkout: a fresh copy per check, an environment
allowlist with no credential, a PATH without checkout entries, a deadline,
a 1 MiB output capture, a process-group kill, and namespaces (Linux) or
sandbox-exec (macOS) where available. Run it only where no model credential
or other secret exists: the PR's code runs here.

  --spec-dir <dir> --spec-sha256 <hex>   The prepared spec (verified).
  --repo <owner/name>                    Default $GITHUB_REPOSITORY.
  --cwd <dir>                            The PR head checkout (default .).
  --out <dir>                            checks.json (outside the checkout).
  --github-output                        status, digest (of --out).`;

async function verifyStage(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      ...SPEC_FLAGS,
      cwd: { type: 'string' },
      out: { type: 'string' },
      'github-output': { type: 'boolean' },
    },
    VERIFY_USAGE,
  );
  const { env } = context;
  return await stage(async () => {
    const spec = await loadSpecDir({
      dir: path.resolve(context.cwd, required(flags['spec-dir'], '--spec-dir')),
      specSha256: required(flags['spec-sha256'], '--spec-sha256'),
      repository: repoOf(flags.repo, env),
    });
    const outDir = path.resolve(context.cwd, required(flags.out, '--out'));
    const ran = await runVerify({
      cwd: path.resolve(context.cwd, flags.cwd ?? '.'),
      spec,
      outDir,
      env,
      log: context.log,
      ...(deps.git === undefined ? {} : { git: deps.git }),
    });
    if (!ran.ok) throw CliError.fromFailure(ran);
    const digest = await digestResultDir(outDir);
    if (!digest.ok) throw CliError.fromFailure(digest);
    const { evidence } = ran.value;
    if (flags['github-output'] === true)
      await appendGithubOutput(env, {
        status: evidence.status,
        digest: digest.value,
      });
    return {
      status: evidence.status,
      digest: digest.value,
      evidencePath: ran.value.evidencePath,
      checks: evidence.entries.map((entry) => ({
        name: entry.name,
        exitCode: entry.exit_code,
        timedOut: entry.timed_out,
        isolation: entry.isolation,
        evidenceId: entry.evidence_id,
      })),
    };
  });
}

// --- pass ------------------------------------------------------------------

const PASS_USAGE = `agent-ci review pass — one reviewer pass, read-only (model credential).

  --spec-dir <dir> --spec-sha256 <hex>   The prepared spec (verified).
  --pass <primary|second>                Which pass.
  --cwd <dir>                            The PR head checkout (default .).
  --out <dir>                            review.json, pass.json, run outputs.
  --route <id> | (the request's model)   --harness, --allow-pool, --seed-login,
  --home-root, --timeout-minutes (30), --max-attempts (2),
  --retry-delay-seconds (30), --models, --credential-from-env
  --checks-dir <dir> --checks-digest <hex>
                                         verify-review: the verify stage's
                                         output and its digest (validated;
                                         served through run_check).
  --github-output                        ok, code.`;

async function passStage(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      ...SPEC_FLAGS,
      ...ROUTE_FLAGS,
      pass: { type: 'string' },
      cwd: { type: 'string' },
      out: { type: 'string' },
      'checks-dir': { type: 'string' },
      'checks-digest': { type: 'string' },
      'max-attempts': { type: 'string' },
      'retry-delay-seconds': { type: 'string' },
      'github-output': { type: 'boolean' },
    },
    PASS_USAGE,
  );
  const allowPool = poolOptIn(flags);
  const { env } = context;
  return await stage(async () => {
    const spec = await loadSpecDir({
      dir: path.resolve(context.cwd, required(flags['spec-dir'], '--spec-dir')),
      specSha256: required(flags['spec-sha256'], '--spec-sha256'),
      repository: repoOf(flags.repo, env),
    });
    const ran = await runReviewPass({
      pass: reviewPass(flags.pass),
      spec,
      cwd: path.resolve(context.cwd, flags.cwd ?? '.'),
      outDir: path.resolve(context.cwd, required(flags.out, '--out')),
      routeId: optional(flags.route),
      harness: oneOf(optional(flags.harness), '--harness', HARNESS_IDS),
      allowPool,
      seedLogin: flags['seed-login'] === true,
      homeRoot:
        flags['home-root'] === undefined
          ? undefined
          : path.resolve(context.cwd, flags['home-root']),
      timeoutMs:
        positiveInt(flags['timeout-minutes'], '--timeout-minutes', 30) * 60_000,
      maxAttempts: positiveInt(flags['max-attempts'], '--max-attempts', 2),
      retryDelayMs:
        nonNegativeInt(
          flags['retry-delay-seconds'],
          '--retry-delay-seconds',
          30,
        ) * 1_000,
      modelsPath:
        flags.models === undefined
          ? DEFAULT_MODELS_PATH
          : path.resolve(context.cwd, flags.models),
      env,
      credentialFromEnv: flags['credential-from-env'] === true,
      checksDir: dirFlag(flags['checks-dir'], context.cwd),
      checksDigest: optional(flags['checks-digest']),
      ...(deps.git === undefined ? {} : { git: deps.git }),
    });
    if (!ran.ok) {
      if (flags['github-output'] === true)
        await appendGithubOutput(env, { ok: 'false', code: ran.code });
      throw CliError.fromFailure(ran);
    }
    const { record } = ran.value;
    if (flags['github-output'] === true)
      await appendGithubOutput(env, {
        ok: String(record.ok),
        code: record.code ?? '',
      });
    if (!record.ok)
      throw new CliError(
        (record.code ?? 'E_HARNESS_FAILED') as ErrorCode,
        `the ${record.pass} reviewer pass failed`,
        {
          hint: `pass.json and the run log are in ${path.dirname(ran.value.passPath)}`,
        },
      );
    return { ...record, reviewPath: ran.value.reviewPath };
  });
}

// --- sources / adjudicate ----------------------------------------------------

/** A directory flag resolved against the command's cwd; empty means unset. */
function dirFlag(value: unknown, cwd: string): string | undefined {
  const text = optional(typeof value === 'string' ? value : undefined);
  return text === undefined ? undefined : path.resolve(cwd, text);
}

async function loadPasses(
  flags: Record<string, string | boolean | undefined>,
  specEnabled: boolean,
  cwd: string,
) {
  const primary = await loadPassDir({
    pass: 'primary',
    dir: dirFlag(flags['primary-dir'], cwd),
    digest: flags['primary-digest'] as string | undefined,
  });
  const second = specEnabled
    ? await loadPassDir({
        pass: 'second',
        dir: dirFlag(flags['second-dir'], cwd),
        digest: flags['second-digest'] as string | undefined,
      })
    : null;
  return second === null ? [primary] : [primary, second];
}

const SOURCES_USAGE = `agent-ci review sources — fetch the adjudicator's cited source (GitHub token).

  --spec-dir --spec-sha256 --repo     The prepared spec.
  --primary-dir --primary-digest      Each pass's artifact and digest.
  --second-dir --second-digest
  --fail-on-severity <severity>       Which candidates are protected.
  --out <dir>                         Source snapshot.`;

async function sources(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      ...SPEC_FLAGS,
      ...PASS_DIR_FLAGS,
      'fail-on-severity': { type: 'string' },
      out: { type: 'string' },
    },
    SOURCES_USAGE,
  );
  const { env } = context;
  return await stage(async () => {
    const repository = repoOf(flags.repo, env);
    const spec = await loadSpecDir({
      dir: path.resolve(context.cwd, required(flags['spec-dir'], '--spec-dir')),
      specSha256: required(flags['spec-sha256'], '--spec-sha256'),
      repository,
    });
    const passes = await loadPasses(
      flags,
      spec.spec.request.second.enabled,
      context.cwd,
    );
    const candidates = collectCandidates(
      passes
        .filter((p) => p.review !== null)
        .map((p) => ({ pass: p.pass, attempt: '1', review: p.review })),
      {
        mode: spec.spec.request.mode,
        base_sha: spec.spec.base_sha,
        merge_base_sha: spec.spec.merge_base_sha,
        head_sha: spec.spec.head_sha,
      },
      parsePolicy({ failOnSeverity: flags['fail-on-severity'] })
        .fail_on_severity,
    );
    // Exactly the sources the adjudicator prompt will read.
    const wanted: { side: 'RIGHT' | 'LEFT'; path: string }[] = [];
    buildAdjudicationSources(
      candidates,
      (side, repoPath) => {
        wanted.push({ side, path: repoPath });
        return null;
      },
      promptCandidates(candidates).provided,
    );
    const texts = await fetchSources({
      github: githubClient(env, deps),
      repository,
      shas: { RIGHT: spec.spec.head_sha, LEFT: spec.spec.merge_base_sha },
      wanted,
    });
    const out = path.resolve(context.cwd, required(flags.out, '--out'));
    await writeSourceSnapshot(out, texts);
    return { wanted: wanted.length, fetched: texts.size, out };
  });
}

const ADJUDICATE_USAGE = `agent-ci review adjudicate — the tool-free adjudicator (Claude only).

  --spec-dir --spec-sha256 --repo     The prepared spec.
  --primary-dir --primary-digest      Each pass's artifact and digest.
  --second-dir --second-digest
  --sources-dir <dir>                 The snapshot from agent-ci review sources.
  --fail-on-severity <severity>
  --out <dir>                         adjudication.json, adjudicator.json.
  --route, --allow-pool, --home-root, --timeout-minutes (20), --models,
  --credential-from-env
  --github-output                     status.

Exits 0 when the adjudicator itself failed: a failed adjudication changes no
finding, the findings gate records it and the summary says so.`;

async function adjudicate(argv: readonly string[], context: CommandContext) {
  const flags = parseFlags(
    argv,
    {
      ...SPEC_FLAGS,
      ...PASS_DIR_FLAGS,
      ...ROUTE_FLAGS,
      'sources-dir': { type: 'string' },
      'fail-on-severity': { type: 'string' },
      out: { type: 'string' },
      'github-output': { type: 'boolean' },
    },
    ADJUDICATE_USAGE,
  );
  const allowPool = poolOptIn(flags);
  const { env } = context;
  return await stage(async () => {
    const spec = await loadSpecDir({
      dir: path.resolve(context.cwd, required(flags['spec-dir'], '--spec-dir')),
      specSha256: required(flags['spec-sha256'], '--spec-sha256'),
      repository: repoOf(flags.repo, env),
    });
    const passes = await loadPasses(
      flags,
      spec.spec.request.second.enabled,
      context.cwd,
    );
    const out = path.resolve(context.cwd, required(flags.out, '--out'));
    await mkdir(out, { recursive: true });
    const ran = await runAdjudicator({
      spec: spec.spec,
      passes: passes
        .filter((p) => p.review !== null)
        .map((p) => ({ pass: p.pass, attempt: '1', review: p.review })),
      failOnSeverity: parsePolicy({ failOnSeverity: flags['fail-on-severity'] })
        .fail_on_severity,
      read: await readSourceSnapshot(
        path.resolve(
          context.cwd,
          required(flags['sources-dir'], '--sources-dir'),
        ),
      ),
      outDir: out,
      routeId: optional(flags.route),
      allowPool,
      homeRoot:
        flags['home-root'] === undefined
          ? undefined
          : path.resolve(context.cwd, flags['home-root']),
      timeoutMs:
        positiveInt(flags['timeout-minutes'], '--timeout-minutes', 20) * 60_000,
      modelsPath:
        flags.models === undefined
          ? DEFAULT_MODELS_PATH
          : path.resolve(context.cwd, flags.models),
      env,
      credentialFromEnv: flags['credential-from-env'] === true,
    });
    if (!ran.ok) throw CliError.fromFailure(ran);
    if (flags['github-output'] === true)
      await appendGithubOutput(env, { status: ran.value.status });
    return ran.value;
  });
}

// --- findings ----------------------------------------------------------------

const FINDINGS_USAGE = `agent-ci review findings — the deterministic findings gate (read-only token).

  --spec-dir --spec-sha256 --repo     The prepared spec.
  --primary-dir --primary-digest      Each pass's artifact and digest.
  --second-dir --second-digest
  --adjudication-dir --adjudication-digest
  --scope <scope>                     Marker scope (default default).
  --publisher-login <login>           Whose markers count (default github-actions[bot]).
  --fail-on-severity, --min-inline-severity, --max-inline-comments
  --out <dir>                         review-gated.json, usage.json.
  --github-output                     review_status, fail_on_severity_triggered, gate_error.

Exits 0 for an incomplete or failing review: agent-ci review publish posts it
and then fails the run.`;

async function findings(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      ...SPEC_FLAGS,
      ...PASS_DIR_FLAGS,
      ...POLICY_FLAGS,
      'adjudication-dir': { type: 'string' },
      'adjudication-digest': { type: 'string' },
      scope: { type: 'string' },
      'publisher-login': { type: 'string' },
      out: { type: 'string' },
      'github-output': { type: 'boolean' },
    },
    FINDINGS_USAGE,
  );
  const { env } = context;
  const output = async (entries: Record<string, string>) => {
    if (flags['github-output'] === true) await appendGithubOutput(env, entries);
  };
  try {
    return await stage(async () => {
      const repository = repoOf(flags.repo, env);
      const spec = await loadSpecDir({
        dir: path.resolve(
          context.cwd,
          required(flags['spec-dir'], '--spec-dir'),
        ),
        specSha256: required(flags['spec-sha256'], '--spec-sha256'),
        repository,
      });
      const { runId, runAttempt } = runIdentity(env);
      const scope = optional(flags.scope) ?? 'default';
      if (!SCOPE.test(scope))
        throw new CliError('E_INVALID_INPUT', '--scope must be artifact-safe');
      const identity: ReviewIdentity = {
        repository,
        workflow: REVIEW_WORKFLOW,
        pr_number: spec.spec.pr_number,
        scope,
        run_id: runId,
        run_attempt: runAttempt,
      };
      const passes = await loadPasses(
        flags,
        spec.spec.request.second.enabled,
        context.cwd,
      );
      const adjudication = spec.spec.request.adjudicator.enabled
        ? await loadAdjudicationDir({
            dir: dirFlag(flags['adjudication-dir'], context.cwd),
            digest: flags['adjudication-digest'],
          })
        : { value: null, record: null };
      const github = githubClient(env, deps);
      const texts = await fetchSources({
        github,
        repository,
        shas: { RIGHT: spec.spec.head_sha, LEFT: spec.spec.merge_base_sha },
        wanted: [
          ...citedSources(
            passes.map((p) => p.review),
            parseUnifiedDiff(spec.diffText, {
              truncated: spec.spec.diff.truncated,
            }),
          ),
          ...referencedSources(adjudication.value),
        ],
      });
      const gated = gateArtifacts({
        spec,
        identity,
        attempt: runAttempt,
        passes,
        adjudication: adjudication.value,
        read: mapReader(texts),
        posted: await postedMarkers({
          github,
          identity,
          publisher: publisherOf(flags['publisher-login']),
        }),
        policy: policyFlags(flags),
      });
      const out = path.resolve(context.cwd, required(flags.out, '--out'));
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(out, GATED_FILES.gated),
        `${JSON.stringify(gated, null, 2)}\n`,
        { flag: 'wx' },
      );
      await writeFile(
        path.join(out, GATED_FILES.usage),
        `${JSON.stringify(usageRows(passes, adjudication.record), null, 2)}\n`,
        { flag: 'wx' },
      );
      const digest = await digestResultDir(out);
      if (!digest.ok) throw CliError.fromFailure(digest);
      await output({
        gated_digest: digest.value,
        review_status: gated.review_status,
        fail_on_severity_triggered: String(gated.fail_on_severity_triggered),
        gate_error: '',
      });
      return {
        reviewStatus: gated.review_status,
        findings: gated.findings.length,
        candidates: gated.candidates.length,
        gatedDigest: digest.value,
      };
    });
  } catch (error) {
    if (error instanceof CliError) await output({ gate_error: error.code });
    throw error;
  }
}

// --- publish -----------------------------------------------------------------

const PUBLISH_USAGE = `agent-ci review publish — post the review and summary (GitHub token).

  --gated-dir <dir> --gated-digest <hex>   The findings job's artifact.
  --pr <n> --head-sha <sha>                The request's PR and captured head.
  --repo <owner/name>                      Default $GITHUB_REPOSITORY.
  --scope <scope> --publisher-login <login>
  --error-code <E_*>                       Repeatable: earlier jobs' trusted codes.
  --run-url <url>                          Default from GITHUB_SERVER_URL/RUN_ID.

Exits non-zero (after publishing) when the review is incomplete, the head
moved, or fail_on_severity triggered.`;

async function publish(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      'gated-dir': { type: 'string' },
      'gated-digest': { type: 'string' },
      pr: { type: 'string' },
      'head-sha': { type: 'string' },
      repo: { type: 'string' },
      scope: { type: 'string' },
      'publisher-login': { type: 'string' },
      'error-code': { type: 'string', multiple: true },
      'run-url': { type: 'string' },
    },
    PUBLISH_USAGE,
  );
  const { env } = context;
  return await stage(async () => {
    const { runId, runAttempt } = runIdentity(env);
    const repository = repoOf(flags.repo, env);
    const prNumber = positiveInt(flags.pr, '--pr', 0);
    const headSha = required(flags['head-sha'], '--head-sha');
    if (!/^[0-9a-f]{40}$/u.test(headSha))
      throw new CliError('E_INVALID_INPUT', '--head-sha must be a full SHA');
    const runUrl =
      optional(flags['run-url']) ??
      (env.GITHUB_SERVER_URL
        ? `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`
        : null);
    const gatedDir = optional(flags['gated-dir']);
    const outcome = await publishGated({
      github: githubClient(env, deps),
      context: {
        repository,
        prNumber,
        headSha,
        scope: optional(flags.scope) ?? 'default',
        runId,
        runAttempt,
        runUrl,
      },
      publisher: publisherOf(flags['publisher-login']),
      dir:
        gatedDir === undefined
          ? undefined
          : path.resolve(context.cwd, gatedDir),
      digest: flags['gated-digest'],
      errorCodes: flags['error-code'] ?? [],
      log: context.log,
    });
    await summary(
      env,
      `## agent-ci PR review publication\n\n- Status: \`${outcome.status}\`\n- Inline review posted: ${outcome.reviewPosted}\n${outcome.reasons.map((r) => `- Fails the run: ${r}`).join('\n')}`,
    );
    if (outcome.fail)
      throw new CliError(
        'E_REVIEW_FAILED',
        outcome.reasons.join('; ') || 'the review did not publish',
        {
          hint: `publication status: ${outcome.status}`,
        },
      );
    return outcome;
  });
}

// --- run (local) ---------------------------------------------------------------

const RUN_USAGE = `agent-ci review run — a whole PR review on this machine.

  --pr <n>                     The pull request (same repository, open).
  --repo <owner/name>          Default $GITHUB_REPOSITORY.
  --cwd <dir>                  A local clone with that repository as origin.
  --model <model>              Primary reviewer (required).
  --second-model <model>       Turn the second reviewer on.
  --adjudicator-model <model>  Turn the adjudicator on (Claude only).
  --instruction <text>         Request instruction.
  --allow-pool | --allow-pool-value <true|false>
                               Let pool models resolve (in CI only on a
                               self-hosted runner, never a Claude model).
  --seed-login                 Login routes (local only).
  --publish                    Post the inline review and summary as the
                               token's user (default: gate only, no posting).
  --scope <scope>              Marker scope (default local).
  --out <dir>                  Keep the stage artifacts here.
  --timeout-minutes <n>        Per stage (default 30).
  --fail-on-severity, --min-inline-severity, --max-inline-comments, --models

The token (GITHUB_TOKEN or GH_TOKEN) must belong to a user with write access.`;

async function runLocal(
  argv: readonly string[],
  context: CommandContext,
  deps: Deps,
) {
  const flags = parseFlags(
    argv,
    {
      pr: { type: 'string' },
      repo: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' },
      'second-model': { type: 'string' },
      'adjudicator-model': { type: 'string' },
      instruction: { type: 'string' },
      'allow-pool': { type: 'boolean' },
      'allow-pool-value': { type: 'string' },
      'seed-login': { type: 'boolean' },
      publish: { type: 'boolean' },
      scope: { type: 'string' },
      out: { type: 'string' },
      'timeout-minutes': { type: 'string' },
      models: { type: 'string' },
      ...POLICY_FLAGS,
    },
    RUN_USAGE,
  );
  const allowPool = poolOptIn(flags);
  const { env } = context;
  const scope = optional(flags.scope) ?? 'local';
  if (!SCOPE.test(scope))
    throw new CliError('E_INVALID_INPUT', '--scope must be artifact-safe');
  const result = await runLocalReview({
    github: githubClient(env, deps),
    repository: repoOf(flags.repo, env),
    prNumber: positiveInt(flags.pr, '--pr', 0),
    cwd: path.resolve(context.cwd, flags.cwd ?? '.'),
    reviewerModel: required(flags.model, '--model'),
    secondModel: optional(flags['second-model']),
    adjudicatorModel: optional(flags['adjudicator-model']),
    instruction: optional(flags.instruction),
    allowPool,
    seedLogin: flags['seed-login'] === true,
    publish: flags.publish === true,
    scope,
    policy: {
      failOnSeverity: flags['fail-on-severity'],
      minInlineSeverity: flags['min-inline-severity'],
      maxInlineComments: flags['max-inline-comments'],
    },
    outDir:
      flags.out === undefined
        ? undefined
        : path.resolve(context.cwd, flags.out),
    timeoutMs:
      positiveInt(flags['timeout-minutes'], '--timeout-minutes', 30) * 60_000,
    modelsPath:
      flags.models === undefined
        ? DEFAULT_MODELS_PATH
        : path.resolve(context.cwd, flags.models),
    env,
    ...(deps.git === undefined ? {} : { git: deps.git }),
    log: context.log,
  });
  if (!result.ok) throw CliError.fromFailure(result);
  // Artifacts (and any publication) are already in place: now the review's
  // own verdict decides the exit status, as `review publish` does in Actions.
  const { failures, outDir, publication } = result.value;
  if (failures.length > 0)
    throw new CliError('E_REVIEW_FAILED', failures.join('; '), {
      hint: `Stage artifacts are in ${outDir}; publication: ${publication?.status ?? 'not requested'}.`,
    });
  return result.value;
}

const STAGES: Record<
  string,
  (
    argv: readonly string[],
    context: CommandContext,
    deps: Deps,
  ) => Promise<unknown>
> = {
  gate,
  prepare,
  verify: verifyStage,
  pass: passStage,
  sources,
  adjudicate: (argv, context) => adjudicate(argv, context),
  findings,
  publish,
  run: runLocal,
};
const STAGE_USAGE: Record<string, string> = {
  gate: GATE_USAGE,
  prepare: PREPARE_USAGE,
  verify: VERIFY_USAGE,
  pass: PASS_USAGE,
  sources: SOURCES_USAGE,
  adjudicate: ADJUDICATE_USAGE,
  findings: FINDINGS_USAGE,
  publish: PUBLISH_USAGE,
  run: RUN_USAGE,
};

export function createReviewCommand(deps: Deps = {}): CommandSpec {
  return {
    name: 'review',
    summary:
      'AI pull-request review stages (gate, prepare, pass, …, publish) and local run',
    usage: USAGE,
    async run(argv, context) {
      const [name, ...rest] = argv;
      const body = name === undefined ? undefined : STAGES[name];
      if (body === undefined)
        throw new CliError(
          'E_INVALID_INPUT',
          `unknown review stage: ${name ?? '(none)'}`,
          { hint: USAGE },
        );
      if (rest.includes('--help') || rest.includes('-h')) {
        context.log(STAGE_USAGE[name ?? ''] ?? USAGE);
        return { help: true };
      }
      return await body(rest, context, deps);
    },
  };
}

export const reviewCommand = createReviewCommand();
