import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computePrMerge, type PrMerge } from '@agent-ci/pr-run/merge.js';
import {
  parsePrRunRequest,
  type PrRunRequest,
} from '@agent-ci/pr-run/request.js';
import { parseChangeSet } from '@agent-ci/publish/changes.js';
import type { GitRunner } from '@agent-ci/publish/git.js';
import type { RunOutputs } from '@agent-ci/publish/publish.js';
import {
  ACTIONS_BOT,
  type CommitIdentity,
} from '@agent-ci/publish/static-branch.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import { GithubClient, GithubError } from '@agent-ci/review/github.js';

const SHA = /^[0-9a-f]{40}$/u;
const CONFLICT_MARKER = /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s.*)?$/mu;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function forbiddenPath(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower === '.gitmodules' ||
    lower === '.github/workflows' ||
    lower.startsWith('.github/workflows/')
  );
}

function identity(request: PrRunRequest, outputs: RunOutputs): Result<void> {
  if (
    outputs.result.targetRepo !== request.repository ||
    outputs.result.useCase !== 'pr-comment' ||
    outputs.result.outputContract !== 'changes'
  ) {
    return failure(
      'E_PR_RUN_FAILED',
      'run artifact does not match this PR task',
    );
  }
  return success(undefined);
}

/**
 * Rebuild the final tree without checking out or executing repository code.
 * Verification and publication use the same independently recomputed merge
 * baseline; only the agent's file delta comes from its result artifact.
 */
export async function buildPrRunTree(
  git: GitRunner,
  request: PrRunRequest,
  outputs: RunOutputs,
): Promise<Result<PrMerge>> {
  const parsed = parsePrRunRequest(request);
  if (!parsed.ok) return parsed;
  const matched = identity(request, outputs);
  if (!matched.ok) return matched;
  if (!outputs.result.ok || outputs.result.status === 'failed') {
    return failure(
      'E_PR_RUN_FAILED',
      'the agent run failed; nothing will be pushed',
    );
  }
  const changes =
    outputs.changeSet === null
      ? success(null)
      : parseChangeSet(JSON.stringify(outputs.changeSet));
  if (!changes.ok) return changes;
  if (changes.value !== null && changes.value.baseSha !== request.headSha) {
    return failure(
      'E_PR_RUN_STALE_HEAD',
      'change set is based on another PR head',
    );
  }
  if (outputs.result.status === 'changed' && changes.value === null) {
    return failure('E_PR_RUN_FAILED', 'changed run has no change set');
  }
  for (const entry of changes.value?.files ?? []) {
    if (forbiddenPath(entry.path)) {
      return failure('E_PATH_POLICY', `PR task cannot publish ${entry.path}`);
    }
  }
  const merged = await computePrMerge(git, request);
  if (!merged.ok) return merged;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pr-index-'));
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    const read = await git(['read-tree', merged.value.tree], { env });
    if (read.code !== 0) {
      return failure(
        'E_PR_RUN_FAILED',
        'cannot initialize the publishing tree',
      );
    }
    for (const entry of changes.value?.files ?? []) {
      if (entry.action === 'delete') {
        const removed = await git(
          ['update-index', '--force-remove', '--', entry.path],
          { env },
        );
        if (removed.code !== 0) {
          return failure('E_PR_RUN_FAILED', 'cannot apply a file deletion');
        }
        continue;
      }
      const bytes =
        entry.action === 'write'
          ? Buffer.from(entry.contentBase64, 'base64')
          : Buffer.from(entry.target, 'utf8');
      const hashed = await git(
        ['hash-object', '-w', '--stdin', '--no-filters'],
        {
          input: bytes,
        },
      );
      const blob = hashed.stdout.trim();
      if (hashed.code !== 0 || !SHA.test(blob)) {
        return failure('E_PR_RUN_FAILED', 'cannot materialize a changed file');
      }
      const mode = entry.action === 'write' ? entry.mode : '120000';
      const added = await git(
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `${mode},${blob},${entry.path}`,
        ],
        { env },
      );
      if (added.code !== 0) {
        return failure('E_PR_RUN_FAILED', 'cannot apply a changed file');
      }
    }
    const written = await git(['write-tree'], { env });
    const tree = written.stdout.trim();
    if (written.code !== 0 || !SHA.test(tree)) {
      return failure('E_PR_RUN_FAILED', 'cannot finish the publishing tree');
    }
    const diff = await git([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      request.headSha,
      tree,
    ]);
    if (diff.code !== 0) {
      return failure('E_PR_RUN_FAILED', 'cannot inspect the publishing diff');
    }
    if (diff.stdout.split('\0').filter(Boolean).some(forbiddenPath)) {
      return failure(
        'E_PATH_POLICY',
        'the resulting PR update changes workflows or submodule configuration',
      );
    }
    for (const file of merged.value.conflictedPaths) {
      const entry = await git(['ls-tree', '-z', tree, '--', file]);
      if (entry.code !== 0) {
        return failure('E_PR_RUN_FAILED', 'cannot inspect a resolved conflict');
      }
      // A deliberate deletion resolves a textual conflict too.
      if (entry.stdout === '') continue;
      if (!/^100(?:644|755) blob [0-9a-f]{40}\t/u.test(entry.stdout)) {
        return failure(
          'E_PR_RUN_FAILED',
          `invalid conflict resolution at ${file}`,
        );
      }
      const content = await git(['cat-file', 'blob', `${tree}:${file}`]);
      if (
        content.code !== 0 ||
        content.stdout.includes('\0') ||
        CONFLICT_MARKER.test(content.stdout)
      ) {
        return failure('E_PR_RUN_FAILED', `unresolved conflict at ${file}`);
      }
    }
    return success({ ...merged.value, tree });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface PrRunPublishOptions {
  readonly git: GitRunner;
  readonly github: GithubClient;
  readonly request: PrRunRequest;
  readonly outputs: RunOutputs;
  readonly runUrl?: string;
  readonly author?: CommitIdentity;
}

export interface PrRunPublishResult {
  readonly status: 'changed' | 'no-op' | 'failed';
  readonly commit: string | null;
  readonly prUrl: string;
  readonly commentUrl: string;
}

async function checkCurrentPull(
  options: PrRunPublishOptions,
): Promise<Result<void>> {
  const { github, request } = options;
  const raw = await github.json({
    method: 'GET',
    path: `/repos/${request.repository}/pulls/${request.prNumber}`,
  });
  const head = field(raw, 'head');
  const base = field(raw, 'base');
  if (
    field(raw, 'number') !== request.prNumber ||
    field(raw, 'state') !== 'open' ||
    field(field(head, 'repo'), 'full_name') !== request.repository ||
    field(field(base, 'repo'), 'full_name') !== request.repository ||
    field(head, 'ref') !== request.headRef ||
    field(base, 'ref') !== request.baseRef ||
    field(head, 'sha') !== request.headSha ||
    field(base, 'sha') !== request.baseSha
  ) {
    return failure(
      'E_PR_RUN_STALE_HEAD',
      'the pull request changed after this task started; nothing was pushed',
    );
  }
  const metadata = await github.json({
    method: 'GET',
    path: `/repos/${request.repository}`,
  });
  const defaultBranch = field(metadata, 'default_branch');
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    return failure('E_GITHUB_API', 'GitHub did not return the default branch');
  }
  if (
    request.headRef === request.baseRef ||
    request.headRef === defaultBranch
  ) {
    return failure(
      'E_PR_RUN_REQUEST',
      'refusing to update a protected target branch',
    );
  }
  const permission = await github.json(
    {
      method: 'GET',
      path: `/repos/${request.repository}/collaborators/${request.actor}/permission`,
    },
    [200, 404],
  );
  if (
    !['write', 'maintain', 'admin'].includes(
      String(field(permission, 'permission')),
    )
  ) {
    return failure(
      'E_PR_RUN_REQUEST',
      'the task requester no longer has write access; nothing was pushed',
    );
  }
  return success(undefined);
}

async function reply(
  options: PrRunPublishOptions,
  status: PrRunPublishResult['status'],
  commit: string | null,
): Promise<Result<PrRunPublishResult>> {
  const { request, outputs, github } = options;
  const commitUrl =
    commit === null
      ? null
      : `${request.prUrl.split('/pull/')[0]}/commit/${commit}`;
  const lines = [
    `<!-- agent-ci-pr-run:${request.commentId} -->`,
    `agent-ci task ${status === 'changed' ? 'completed' : status === 'no-op' ? 'completed without changes' : 'failed'}.`,
    '',
    outputs.result.summary,
    ...(status === 'failed'
      ? outputs.result.errors.map((error) => `- ${error}`)
      : []),
    ...(commitUrl === null
      ? []
      : ['', `Commit: [${commit?.slice(0, 12)}](${commitUrl})`]),
    ...(options.runUrl === undefined
      ? []
      : ['', `[Workflow run](${options.runUrl})`]),
  ];
  const posted = await github.json({
    method: 'POST',
    path: `/repos/${request.repository}/issues/${request.prNumber}/comments`,
    body: { body: lines.join('\n') },
  });
  const commentUrl = field(posted, 'html_url');
  if (typeof commentUrl !== 'string') {
    return failure(
      'E_GITHUB_API',
      'GitHub did not return the task comment URL',
    );
  }
  return success({ status, commit, prUrl: request.prUrl, commentUrl });
}

/** Publish only a descendant of the exact head the trusted gate authorized. */
export async function publishPrRun(
  options: PrRunPublishOptions,
): Promise<Result<PrRunPublishResult>> {
  const { git, request, outputs } = options;
  const parsed = parsePrRunRequest(request);
  if (!parsed.ok) return parsed;
  const matched = identity(request, outputs);
  if (!matched.ok) return matched;
  try {
    const current = await checkCurrentPull(options);
    if (!current.ok) return current;
    if (!outputs.result.ok || outputs.result.status === 'failed') {
      return await reply(options, 'failed', null);
    }
    const built = await buildPrRunTree(git, request, outputs);
    if (!built.ok) return built;
    const head = await git(['rev-parse', `${request.headSha}^{tree}`]);
    if (head.code !== 0) {
      return failure('E_PR_RUN_FAILED', 'cannot inspect the original PR tree');
    }
    if (
      head.stdout.trim() === built.value.tree &&
      built.value.mergeParent === null
    ) {
      return await reply(options, 'no-op', null);
    }
    const author = options.author ?? ACTIONS_BOT;
    const parents = ['-p', request.headSha];
    if (built.value.mergeParent !== null) {
      parents.push('-p', built.value.mergeParent);
    }
    const created = await git(['commit-tree', built.value.tree, ...parents], {
      input: `fix: address agent-ci PR task\n\nAgent-CI-Comment: ${request.commentId}\n`,
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      },
    });
    const commit = created.stdout.trim();
    if (created.code !== 0 || !SHA.test(commit)) {
      return failure('E_PR_RUN_FAILED', 'cannot create the PR task commit');
    }
    // The lease below is compare-and-swap, not permission to replace
    // history. Independently prove that the new commit retains the pinned
    // head as its first parent before passing a lease to git push.
    const parent = await git(['rev-parse', `${commit}^1`]);
    if (parent.code !== 0 || parent.stdout.trim() !== request.headSha) {
      return failure(
        'E_PR_RUN_FAILED',
        'PR task commit does not preserve its head',
      );
    }
    const rechecked = await checkCurrentPull(options);
    if (!rechecked.ok) return rechecked;
    const ref = `refs/heads/${request.headRef}`;
    const remote = await git(['ls-remote', '--heads', 'origin', ref]);
    if (
      remote.code !== 0 ||
      remote.stdout.trim() !== `${request.headSha}\t${ref}`
    ) {
      return failure(
        'E_PR_RUN_STALE_HEAD',
        'PR branch moved before publication',
      );
    }
    const pushed = await git([
      'push',
      `--force-with-lease=${ref}:${request.headSha}`,
      'origin',
      `${commit}:${ref}`,
    ]);
    if (pushed.code !== 0) {
      return failure(
        'E_PR_RUN_STALE_HEAD',
        'PR update was rejected; the branch may have changed or disallowed the push',
      );
    }
    return await reply(options, 'changed', commit);
  } catch (error) {
    return failure(
      'E_GITHUB_API',
      error instanceof GithubError ? error.message : 'PR publication failed',
    );
  }
}
