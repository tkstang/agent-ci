import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ChangeSet } from '@agent-ci/publish/changes.js';
import { type GitRunner, gitError } from '@agent-ci/publish/git.js';
import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * Commit a change set to a static branch with git plumbing, without checking
 * anything out or running repository code: the tree is the change set's base
 * commit plus its changes, built in a temporary index. Updates never rewrite
 * the branch (no force push): the new commit's first parent is the branch's
 * current head, and when the base moved it also gets the new base as a second
 * parent, so the pull request diff stays "base + this run's changes".
 */

export const BASE_TRAILER = 'Agent-CI-Base';

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** The identity GitHub shows for commits made with `GITHUB_TOKEN`. */
export const ACTIONS_BOT: CommitIdentity = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

export interface StaticBranchOptions {
  readonly git: GitRunner;
  readonly changeSet: ChangeSet;
  readonly branch: string;
  /** The pull request's base branch; the static branch may never equal it. */
  readonly baseBranch: string;
  readonly remote?: string;
  readonly title: string;
  readonly author: CommitIdentity;
  /** Agent-owned branch namespace (default `agent-ci/`). */
  readonly branchPrefix?: string;
  /**
   * Update an existing branch whose head agent-ci did not publish. History
   * is kept (no force push), but the new tree replaces the branch content.
   */
  readonly adoptBranch?: boolean;
}

export const DEFAULT_BRANCH_PREFIX = 'agent-ci/';

export interface StaticBranchResult {
  readonly branch: string;
  readonly commit: string;
  /** `created`: new branch; `updated`: new commit pushed; `unchanged`: same tree. */
  readonly action: 'created' | 'updated' | 'unchanged';
}

const PROTECTED = new Set(['main', 'master', 'trunk', 'develop', 'HEAD']);

async function checkBranchName(
  git: GitRunner,
  branch: string,
  baseBranch: string,
  prefix: string,
): Promise<Result<void>> {
  if (
    prefix === '' ||
    !prefix.endsWith('/') ||
    PROTECTED.has(prefix.slice(0, -1))
  ) {
    return failure(
      'E_PUBLISH',
      `invalid branch prefix ${JSON.stringify(prefix)}`,
      'Use an agent-owned namespace ending in "/", such as agent-ci/.',
    );
  }
  if (!branch.startsWith(prefix) || branch.length === prefix.length) {
    return failure(
      'E_PUBLISH',
      `refusing to publish to ${JSON.stringify(branch)}: static branches live under ${prefix}`,
      `Use a branch such as ${prefix}<use-case>.`,
    );
  }
  if (
    PROTECTED.has(branch) ||
    branch === baseBranch ||
    branch.startsWith('-') ||
    !/^[A-Za-z0-9._/-]+$/u.test(branch)
  ) {
    return failure(
      'E_PUBLISH',
      `refusing to publish to branch ${JSON.stringify(branch)}`,
      'Use a dedicated static branch such as agent-ci/<use-case>.',
    );
  }
  const checked = await git(['check-ref-format', '--branch', branch]);
  return checked.code === 0
    ? success(undefined)
    : failure('E_PUBLISH', `invalid branch name ${branch}`);
}

async function remoteHead(
  git: GitRunner,
  remote: string,
  branch: string,
): Promise<Result<string | null>> {
  const listed = await git([
    'ls-remote',
    '--heads',
    remote,
    `refs/heads/${branch}`,
  ]);
  if (listed.code !== 0) {
    return failure('E_PUBLISH', `git ls-remote failed: ${gitError(listed)}`);
  }
  const sha = listed.stdout.trim().split(/\s+/u)[0] ?? '';
  return success(/^[0-9a-f]{40}$/u.test(sha) ? sha : null);
}

async function ensureCommit(
  git: GitRunner,
  remote: string,
  sha: string,
): Promise<Result<void>> {
  if ((await git(['cat-file', '-e', `${sha}^{commit}`])).code === 0) {
    return success(undefined);
  }
  const fetched = await git(['fetch', '--no-tags', '--depth=1', remote, sha]);
  if (fetched.code !== 0) {
    return failure('E_PUBLISH', `could not fetch ${sha}: ${gitError(fetched)}`);
  }
  return success(undefined);
}

/**
 * True when `commit` is one this publisher made: its message ends with the
 * `Agent-CI-Base:` trailer and its committer is the publishing identity.
 */
export async function publishedByAgentCi(
  git: GitRunner,
  commit: string,
  identity: CommitIdentity,
): Promise<Result<boolean>> {
  const shown = await git(['cat-file', 'commit', commit]);
  if (shown.code !== 0) {
    return failure(
      'E_PUBLISH',
      `cannot read commit ${commit}: ${gitError(shown)}`,
    );
  }
  const [header = '', ...body] = shown.stdout.split('\n\n');
  const committer = /^committer (.*) <([^>]*)> \d+ [+-]\d{4}$/mu.exec(header);
  const message = body.join('\n\n');
  const trailer = new RegExp(`^${BASE_TRAILER}: [0-9a-f]{40}\\s*$`, 'mu').test(
    message,
  );
  return success(
    trailer &&
      committer?.[1] === identity.name &&
      committer[2] === identity.email,
  );
}

export async function publishStaticBranch(
  options: StaticBranchOptions,
): Promise<Result<StaticBranchResult>> {
  const { git, changeSet, branch } = options;
  const remote = options.remote ?? 'origin';
  const named = await checkBranchName(
    git,
    branch,
    options.baseBranch,
    options.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
  );
  if (!named.ok) return named;
  const base = changeSet.baseSha;
  if (base === null) {
    return failure(
      'E_PUBLISH',
      'the change set has no base commit to build on',
    );
  }
  const baseReady = await ensureCommit(git, remote, base);
  if (!baseReady.ok) return baseReady;
  const existing = await remoteHead(git, remote, branch);
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    const ready = await ensureCommit(git, remote, existing.value);
    if (!ready.ok) return ready;
    // Only a branch whose head agent-ci published may be updated: anyone
    // else's commit there would be dropped from the tree by this update.
    const owned = await publishedByAgentCi(git, existing.value, options.author);
    if (!owned.ok) return owned;
    if (!owned.value && options.adoptBranch !== true) {
      return failure(
        'E_PUBLISH',
        `branch ${branch} has a head commit (${existing.value.slice(0, 12)}) that agent-ci did not publish; refusing to replace its content`,
        'Merge or move that work elsewhere, delete the branch, or pass --adopt-branch to replace the content (history is kept).',
      );
    }
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-index-'));
  const index = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    const read = await git(['read-tree', base], { env: index });
    if (read.code !== 0) {
      return failure('E_PUBLISH', `git read-tree failed: ${gitError(read)}`);
    }
    for (const entry of changeSet.files) {
      if (entry.action === 'delete') {
        const removed = await git(
          ['update-index', '--force-remove', '--', entry.path],
          { env: index },
        );
        if (removed.code !== 0) {
          return failure(
            'E_PUBLISH',
            `git update-index failed: ${gitError(removed)}`,
          );
        }
        continue;
      }
      const content =
        entry.action === 'write'
          ? Buffer.from(entry.contentBase64, 'base64')
          : Buffer.from(entry.target, 'utf8');
      const hashed = await git(
        ['hash-object', '-w', '--stdin', '--no-filters'],
        {
          input: content,
        },
      );
      const blob = hashed.stdout.trim();
      if (hashed.code !== 0 || !/^[0-9a-f]{40}$/u.test(blob)) {
        return failure(
          'E_PUBLISH',
          `git hash-object failed: ${gitError(hashed)}`,
        );
      }
      const mode = entry.action === 'write' ? entry.mode : '120000';
      const added = await git(
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `${mode},${blob},${entry.path}`,
        ],
        { env: index },
      );
      if (added.code !== 0) {
        return failure(
          'E_PUBLISH',
          `git update-index failed: ${gitError(added)}`,
        );
      }
    }
    const written = await git(['write-tree'], { env: index });
    const tree = written.stdout.trim();
    if (written.code !== 0 || !/^[0-9a-f]{40}$/u.test(tree)) {
      return failure(
        'E_PUBLISH',
        `git write-tree failed: ${gitError(written)}`,
      );
    }

    const parents: string[] = [];
    if (existing.value !== null) {
      const head = existing.value;
      const headTree = (
        await git(['rev-parse', `${head}^{tree}`])
      ).stdout.trim();
      const body = (await git(['log', '-1', '--format=%B', head])).stdout;
      const recorded = new RegExp(
        `^${BASE_TRAILER}: ([0-9a-f]{40})$`,
        'mu',
      ).exec(body)?.[1];
      // Unchanged only when both the tree and the base it was built on are
      // the same. A moved base gets an ancestry commit (parents: head, new
      // base) even with an identical tree, so the pull request diff is
      // against the new base.
      if (headTree === tree && recorded === base) {
        return success({ branch, commit: head, action: 'unchanged' });
      }
      parents.push(head);
      if (recorded !== base) parents.push(base);
    } else {
      parents.push(base);
    }
    const identity = {
      GIT_AUTHOR_NAME: options.author.name,
      GIT_AUTHOR_EMAIL: options.author.email,
      GIT_COMMITTER_NAME: options.author.name,
      GIT_COMMITTER_EMAIL: options.author.email,
    };
    const message = `${options.title.replaceAll(/[\r\n]+/gu, ' ').slice(0, 200)}\n\n${BASE_TRAILER}: ${base}\n`;
    const committed = await git(
      [
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree,
        ...parents.flatMap((parent) => ['-p', parent]),
        '-F',
        '-',
      ],
      { input: message, env: identity },
    );
    const commit = committed.stdout.trim();
    if (committed.code !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
      return failure(
        'E_PUBLISH',
        `git commit-tree failed: ${gitError(committed)}`,
      );
    }
    // A fast-forward push: never --force. A concurrent update is refused by
    // the remote and reported instead of overwritten.
    const pushed = await git([
      'push',
      remote,
      `${commit}:refs/heads/${branch}`,
    ]);
    if (pushed.code !== 0) {
      return failure('E_PUBLISH', `git push failed: ${gitError(pushed)}`);
    }
    return success({
      branch,
      commit,
      action: existing.value === null ? 'created' : 'updated',
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
