import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { adapterFor } from '@agent-ci/harness/adapters/registry.js';
import {
  pinFiles,
  pinHarness,
  type PinnedHarness,
  verifyPin,
} from '@agent-ci/harness/pin.js';
import { digestResultDir } from '@agent-ci/publish/digest.js';
import { createGit } from '@agent-ci/publish/git.js';
import { failure, type Result, success } from '@agent-ci/result.js';
import {
  contractError,
  type GatedReview,
  isReviewError,
  REVIEW_WORKFLOW,
  type ReviewIdentity,
} from '@agent-ci/review/contracts.js';
import {
  gateArtifacts,
  GATED_FILES,
  type LoadedPass,
  loadAdjudicationDir,
  loadPassDir,
  postedMarkers,
  usageRows,
} from '@agent-ci/review/findings.js';
import type { GithubClient } from '@agent-ci/review/github.js';
import {
  checksMcpPath,
  loadSpecDir,
  resolveReviewRoute,
  runReviewPass,
} from '@agent-ci/review/pass.js';
import { prepareReview, SPEC_FILES } from '@agent-ci/review/prepare.js';
import {
  type PublishOutcome,
  publishReview,
} from '@agent-ci/review/publish.js';
import type { PublisherIdentity } from '@agent-ci/review/render.js';
import { runAdjudicator } from '@agent-ci/review/run-adjudicator.js';
import { gitSourceReader } from '@agent-ci/review/sources.js';
import {
  acknowledgeRequest,
  authorizeRequest,
  configureRequest,
  parsePolicy,
  type ReviewPolicyInputs,
} from '@agent-ci/review/trigger.js';
import { runVerify } from '@agent-ci/review/verify.js';
import { loadModelsFile } from '@agent-ci/routing/resolve.js';
import { findWorkspaceRoot } from '@agent-ci/run/workspace.js';

/**
 * `agent-ci review run`: the whole PR review on this machine, for a
 * repository you can push to. The same stages as the workflow, in order:
 * the permission gate (as a PR-scoped dispatch by the token's own user), the
 * spec, each reviewer pass in a detached worktree at the captured head, the
 * optional adjudicator, the findings gate over the git object store, and,
 * with `publish`, one inline review plus the summary comment posted as that
 * user. Pool and login routes are allowed only when asked for (`allowPool`,
 * `seedLogin`); the routing policy still applies (checkPoolPolicy).
 *
 * With `verify`, the request is verify-review: the checks configured on the
 * default branch (or `--verify-config-ref`) run first, in their own worktree at the head, before any
 * reviewer home root exists or any harness starts
 * (DR-261025-run-verify-review-checks-where). They run the pull request's
 * code on this machine as you, so they need `--verify-trust-pr-code`: no
 * local isolation is a credential boundary. What the host offers
 * (`sandbox-exec` on macOS; namespaces with a read-only host on Linux) and
 * the harness pinning still apply, as hygiene.
 */

export type LocalReviewOptions = {
  readonly github: GithubClient;
  readonly repository: string;
  readonly prNumber: number;
  /** The local clone (its `origin` must be the repository). */
  readonly cwd: string;
  readonly reviewerModel: string;
  readonly secondModel?: string | undefined;
  readonly adjudicatorModel?: string | undefined;
  readonly instruction?: string | undefined;
  readonly allowPool: boolean;
  readonly seedLogin: boolean;
  readonly publish: boolean;
  /** Run as verify-review (checks first, then reviewers with run_check). */
  readonly verify?: boolean;
  /**
   * The operator acknowledges that the PR code runs as them. Required for
   * every local verify run: no local isolation (Linux namespaces or the
   * macOS sandbox) is a credential boundary.
   */
  readonly trustPrCode?: boolean;
  /** verify-review: the branch whose head holds checks.yaml. */
  readonly verifyConfigRef?: string | undefined;
  readonly scope: string;
  readonly policy: ReviewPolicyInputs;
  readonly outDir?: string | undefined;
  readonly timeoutMs: number;
  readonly modelsPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly git?: string;
  readonly log: (message: string) => void;
};

export type LocalReviewResult = {
  readonly outDir: string;
  readonly headSha: string;
  readonly reviewStatus: GatedReview['review_status'];
  readonly findings: number;
  readonly posted: number;
  readonly failOnSeverityTriggered: boolean;
  readonly publication: PublishOutcome | null;
  /**
   * Why the review fails its policy (incomplete, `fail_on_severity`, a
   * publication that must fail), with or without `--publish`; empty when it
   * passes. The command turns a non-empty list into a non-zero exit.
   */
  readonly failures: readonly string[];
};

/** The user the token acts as (a local run publishes as that user). */
async function tokenUser(github: GithubClient): Promise<PublisherIdentity> {
  const user = (await github.json({ method: 'GET', path: '/user' })) as {
    login?: unknown;
    type?: unknown;
  } | null;
  if (
    typeof user?.login !== 'string' ||
    (user.type !== 'User' && user.type !== 'Bot')
  )
    contractError('E_GITHUB_API', 'GET /user returned no login');
  return { login: user.login, type: user.type };
}

export async function runLocalReview(
  options: LocalReviewOptions,
): Promise<Result<LocalReviewResult>> {
  try {
    return await localReview(options);
  } catch (error) {
    if (isReviewError(error)) return failure(error.code, error.message);
    throw error;
  }
}

async function localReview(
  options: LocalReviewOptions,
): Promise<Result<LocalReviewResult>> {
  const { github, repository, log } = options;
  const policy = parsePolicy(options.policy);
  const publisher = await tokenUser(github);
  const commandText = [
    options.verify === true ? '/agent-ci-verify-review' : '/agent-ci-review',
    ...(options.instruction === undefined || options.instruction === ''
      ? []
      : ['--', options.instruction]),
  ].join(' ');
  const authorized = await authorizeRequest({
    github,
    repository,
    eventName: 'workflow_dispatch',
    event: { sender: { login: publisher.login, type: publisher.type } },
    dispatchPrNumber: String(options.prNumber),
    dispatchCommand: commandText,
  });
  if (authorized.status !== 'authorized')
    return failure(
      'E_REVIEW_REQUEST',
      authorized.status === 'skip'
        ? authorized.notice
        : `the request was ignored (${authorized.reason})`,
    );
  const models = await loadModelsFile(options.modelsPath);
  if (!models.ok) return models;
  const allowed = [
    options.reviewerModel,
    ...(options.secondModel === undefined ? [] : [options.secondModel]),
    ...(options.adjudicatorModel === undefined
      ? []
      : [options.adjudicatorModel]),
  ];
  const configured = configureRequest({
    authorized: authorized.authorized,
    defaults: {
      reviewer_model: options.reviewerModel,
      second_reviewer: options.secondModel !== undefined,
      second_reviewer_model: options.secondModel ?? options.reviewerModel,
      adjudicator: options.adjudicatorModel !== undefined,
      adjudicator_model: options.adjudicatorModel ?? options.reviewerModel,
    },
    allowedModels: allowed,
    models: models.value,
    env: options.env,
    allowPool: options.allowPool,
    seedLogin: options.seedLogin,
    verifyEnabled: options.verify === true,
  });
  const runId = String(Date.now());
  const acknowledged = await acknowledgeRequest({
    github,
    repository,
    runId,
    authorized: authorized.authorized,
    configured,
    reply: false,
    acknowledge: false,
    publisherLogin: publisher.login,
  });
  if (acknowledged.status === 'failed')
    return failure('E_REVIEW_REQUEST', acknowledged.text);
  const { record } = acknowledged;
  log(
    `agent-ci review: authorized PR #${record.pr_number} at ${record.head_sha.slice(0, 12)}`,
  );

  const outDir =
    options.outDir ??
    (await mkdtemp(path.join(os.tmpdir(), 'agent-ci-review-')));
  await mkdir(outDir, { recursive: true });
  const specDir = path.join(outDir, 'spec');
  await mkdir(specDir);
  const prepared = await prepareReview({
    github,
    request: record,
    guidance: {},
    verifyConfigRef: options.verifyConfigRef,
  });
  await writeFile(path.join(specDir, SPEC_FILES.spec), prepared.specText);
  await writeFile(path.join(specDir, SPEC_FILES.diff), prepared.diffText);
  const spec = await loadSpecDir({
    dir: specDir,
    specSha256: prepared.specSha256,
    repository,
  });

  // The captured head and merge base, fetched into the local clone.
  const root = await findWorkspaceRoot(options.cwd, options.git);
  if (!root.ok) return root;
  // fetch talks to `origin` (SSH needs HOME and the agent socket); no
  // token variable is passed.
  const gitEnv = Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LANG', 'SSH_AUTH_SOCK'].flatMap((name) =>
      options.env[name] === undefined ? [] : [[name, options.env[name]]],
    ),
  ) as Record<string, string>;
  const runGit = createGit(root.value.root, gitEnv, options.git);
  for (const sha of [record.head_sha, record.merge_base_sha]) {
    const fetched = await runGit([
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      sha,
    ]);
    if (fetched.code !== 0)
      return failure(
        'E_REVIEW_INPUT',
        `git fetch origin ${sha} failed: ${fetched.stderr.trim().split('\n')[0] ?? ''}`,
      );
  }
  // verify-review: the checks, in a worktree of their own (removed before
  // the review worktree exists), with nothing of the review run yet on disk
  // but the spec and this output directory, which commands cannot reach.
  let checksDir: string | undefined;
  let checksDigest: string | undefined;
  // verify-review: every harness the review will launch, and the bridge
  // server and node it spawns, pinned by absolute path and fingerprint
  // BEFORE the checks run; re-verified before each launch.
  const pins = new Map<string, PinnedHarness>();
  let bridgePin: PinnedHarness | undefined;
  if (record.config.mode === 'verify-review') {
    const reviewModels = [
      record.config.primary.model,
      ...(record.config.second.enabled ? [record.config.second.model] : []),
      ...(record.config.adjudicator.enabled
        ? [record.config.adjudicator.model]
        : []),
    ];
    for (const model of reviewModels) {
      const resolved = await resolveReviewRoute({
        model,
        allowPool: options.allowPool,
        seedLogin: options.seedLogin,
        modelsPath: options.modelsPath,
        env: options.env,
        credentialFromEnv: false,
        role: 'review model',
      });
      if (!resolved.ok) return resolved;
      const harness = resolved.value.route.harness;
      if (harness === 'fake' || pins.has(harness)) continue;
      const pinned = await pinHarness(
        adapterFor(harness).defaultCommand,
        options.env.PATH ?? '',
      );
      if (!pinned.ok) return pinned;
      pins.set(harness, pinned.value);
    }
    bridgePin = await pinFiles([process.execPath, checksMcpPath()]);
  }
  const launchDeps = async (
    model: string,
  ): Promise<Result<Parameters<typeof runReviewPass>[1]>> => {
    if (bridgePin !== undefined) {
      const bridge = await verifyPin(bridgePin);
      if (!bridge.ok) return bridge;
    }
    const resolved = await resolveReviewRoute({
      model,
      allowPool: options.allowPool,
      seedLogin: options.seedLogin,
      modelsPath: options.modelsPath,
      env: options.env,
      credentialFromEnv: false,
      role: 'review model',
    });
    if (!resolved.ok) return resolved;
    const pin = pins.get(resolved.value.route.harness);
    if (pin === undefined) return success({});
    const unchanged = await verifyPin(pin);
    if (!unchanged.ok) return unchanged;
    return success({
      harness: {
        commandOverride: { command: pin.command, prefixArgs: pin.prefixArgs },
      },
    });
  };
  if (record.config.mode === 'verify-review') {
    const verifyParent = await mkdtemp(
      path.join(os.tmpdir(), 'agent-ci-verify-head-'),
    );
    const verifyTree = path.join(verifyParent, 'head');
    const addedVerify = await runGit([
      'worktree',
      'add',
      '--detach',
      '--quiet',
      verifyTree,
      record.head_sha,
    ]);
    if (addedVerify.code !== 0) {
      await rm(verifyParent, { recursive: true, force: true });
      return failure(
        'E_REVIEW_INPUT',
        `git worktree add failed: ${addedVerify.stderr.trim().split('\n')[0] ?? ''}`,
      );
    }
    try {
      log('agent-ci review: running the configured checks (verify-review)');
      if (options.trustPrCode === true)
        log(
          "agent-ci review: --verify-trust-pr-code: the pull request's code runs as you; without Linux user namespaces it can read your processes' environments and your Keychain",
        );
      checksDir = path.join(outDir, 'checks');
      const verified = await runVerify({
        cwd: verifyTree,
        spec,
        outDir: checksDir,
        env: options.env,
        protectedPaths: [outDir, root.value.root],
        requireCredentialIsolation: options.trustPrCode !== true,
        log,
        ...(options.git === undefined ? {} : { git: options.git }),
      });
      if (!verified.ok) return verified;
      for (const entry of verified.value.evidence.entries)
        log(
          `agent-ci review: check ${entry.name}: ${entry.timed_out ? 'timed out' : `exit ${entry.exit_code ?? 'killed'}`} (${entry.isolation})`,
        );
      const digest = await digestResultDir(checksDir);
      if (!digest.ok) return digest;
      checksDigest = digest.value;
    } finally {
      await runGit(['worktree', 'remove', '--force', verifyTree]);
      await rm(verifyParent, { recursive: true, force: true });
    }
  }

  const worktreeParent = await mkdtemp(
    path.join(os.tmpdir(), 'agent-ci-review-head-'),
  );
  const worktree = path.join(worktreeParent, 'head');
  const added = await runGit([
    'worktree',
    'add',
    '--detach',
    '--quiet',
    worktree,
    record.head_sha,
  ]);
  if (added.code !== 0)
    return failure(
      'E_REVIEW_INPUT',
      `git worktree add failed: ${added.stderr.trim().split('\n')[0] ?? ''}`,
    );
  const passes: LoadedPass[] = [];
  try {
    for (const pass of ['primary', 'second'] as const) {
      if (pass === 'second' && !record.config.second.enabled) continue;
      const passDir = path.join(outDir, pass);
      log(`agent-ci review: ${pass} reviewer pass`);
      const deps = await launchDeps(
        pass === 'primary'
          ? record.config.primary.model
          : record.config.second.model,
      );
      if (!deps.ok) return deps;
      const ran = await runReviewPass(
        {
          pass,
          spec,
          cwd: worktree,
          outDir: passDir,
          allowPool: options.allowPool,
          seedLogin: options.seedLogin,
          timeoutMs: options.timeoutMs,
          maxAttempts: 2,
          retryDelayMs: 15_000,
          modelsPath: options.modelsPath,
          env: options.env,
          credentialFromEnv: false,
          checksDir,
          checksDigest,
          ...(options.git === undefined ? {} : { git: options.git }),
        },
        deps.value,
      );
      if (!ran.ok) {
        log(
          `agent-ci review: ${pass} pass did not run: ${ran.code}: ${ran.message}`,
        );
        passes.push({ pass, review: null, record: null, problem: ran.message });
        continue;
      }
      const digest = await digestResultDir(passDir);
      if (!digest.ok) return digest;
      passes.push(
        await loadPassDir({ pass, dir: passDir, digest: digest.value }),
      );
    }
  } finally {
    await runGit(['worktree', 'remove', '--force', worktree]);
    await rm(worktreeParent, { recursive: true, force: true });
  }

  const read = gitSourceReader(
    root.value.root,
    { RIGHT: record.head_sha, LEFT: record.merge_base_sha },
    options.git,
  );
  let adjudication: unknown = null;
  let adjudicatorRecord = null;
  if (record.config.adjudicator.enabled) {
    const adjudicationDir = path.join(outDir, 'adjudication');
    const deps = await launchDeps(record.config.adjudicator.model);
    if (!deps.ok) return deps;
    const ran = await runAdjudicator(
      {
        spec: spec.spec,
        passes: passes
          .filter((p) => p.review !== null)
          .map((p) => ({ pass: p.pass, attempt: '1', review: p.review })),
        failOnSeverity: policy.fail_on_severity,
        read,
        outDir: adjudicationDir,
        allowPool: options.allowPool,
        timeoutMs: options.timeoutMs,
        modelsPath: options.modelsPath,
        env: options.env,
        credentialFromEnv: false,
      },
      deps.value,
    );
    if (ran.ok) {
      const digest = await digestResultDir(adjudicationDir);
      if (digest.ok) {
        const loaded = await loadAdjudicationDir({
          dir: adjudicationDir,
          digest: digest.value,
        });
        adjudication = loaded.value;
        adjudicatorRecord = loaded.record;
      }
    } else {
      log(
        `agent-ci review: adjudicator did not run: ${ran.code}: ${ran.message}`,
      );
    }
  }

  const identity: ReviewIdentity = {
    repository,
    workflow: REVIEW_WORKFLOW,
    pr_number: record.pr_number,
    scope: options.scope,
    run_id: runId,
    run_attempt: '1',
  };
  const gated = gateArtifacts({
    spec,
    identity,
    attempt: '1',
    passes,
    adjudication,
    read,
    posted: await postedMarkers({ github, identity, publisher }),
    policy,
  });
  const usage = usageRows(passes, adjudicatorRecord);
  const gatedDir = path.join(outDir, 'gated');
  await mkdir(gatedDir);
  await writeFile(
    path.join(gatedDir, GATED_FILES.gated),
    `${JSON.stringify(gated, null, 2)}\n`,
  );
  await writeFile(
    path.join(gatedDir, GATED_FILES.usage),
    `${JSON.stringify(usage, null, 2)}\n`,
  );

  let publication: PublishOutcome | null = null;
  if (options.publish) {
    publication = await publishReview({
      github,
      context: {
        repository,
        prNumber: record.pr_number,
        headSha: record.head_sha,
        scope: options.scope,
        runId,
        runAttempt: '1',
        runUrl: null,
      },
      publisher,
      gated,
      usage,
      log,
    });
  }
  const failures = [
    ...new Set([
      ...(gated.review_status === 'incomplete'
        ? ['the review is incomplete']
        : []),
      ...(gated.fail_on_severity_triggered
        ? ['fail_on_severity was triggered']
        : []),
      ...(publication?.fail === true ? publication.reasons : []),
    ]),
  ];
  return success({
    outDir,
    headSha: record.head_sha,
    reviewStatus: gated.review_status,
    findings: gated.findings.length,
    posted: gated.findings.filter((f) => f.disposition === 'posted').length,
    failOnSeverityTriggered: gated.fail_on_severity_triggered,
    publication,
    failures,
  });
}
