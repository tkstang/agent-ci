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
 *
 * Because the tree is rebuilt from the change set's base, a change set built
 * on an older base than the one the branch already publishes would undo every
 * change the newer base made. Such a change set is refused
 * (`E_PUBLISH_STALE_BASE`), and so is one whose base cannot be shown to be the
 * branch's base or newer, unless the branch is adopted. Independently, a
 * caller may check the complete pull request diff (the new commit against its
 * merge base with the base branch) before anything is pushed.
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
   * It also accepts a base that cannot be related to the branch's recorded
   * base (a rewritten base branch); a base proven older is always refused.
   */
  readonly adoptBranch?: boolean;
  /**
   * Called with the complete pull request diff (the branch's resulting head,
   * new or `unchanged`, against its merge base with `baseBranch` on the
   * remote) before anything is pushed and before the caller writes to
   * GitHub; a failure stops the publish. An `unchanged` branch is checked
   * too: the same tree can be a different diff against another base.
   */
  readonly checkPullDiff?: (entries: readonly PullDiffEntry[]) => Result<void>;
}

/** One path of the pull request diff (`git diff-tree -r --no-renames`). */
export interface PullDiffEntry {
  readonly path: string;
  /** `A` added, `D` deleted, `M` modified, `T` type changed. */
  readonly status: 'A' | 'D' | 'M' | 'T';
  /** The new mode (`000000` for a deletion). */
  readonly mode: string;
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
 * How far back to look, in order, when a shallow clone hides an ancestry:
 * each miss fetches the commits involved to the next depth and asks again.
 */
const ANCESTRY_DEPTHS = [200, 2000] as const;

const SHA = /^[0-9a-f]{40}$/u;

async function isAncestor(
  git: GitRunner,
  older: string,
  newer: string,
): Promise<boolean> {
  return (await git(['merge-base', '--is-ancestor', older, newer])).code === 0;
}

/**
 * True when `base` is an ancestor of `head`. The clone is usually shallow,
 * so a miss is retried after fetching the head's history to each of
 * {@link ANCESTRY_DEPTHS}. Anything unknown counts as not contained, which
 * only costs an extra ancestry commit.
 */
async function containsBase(
  git: GitRunner,
  remote: string,
  head: string,
  base: string,
): Promise<boolean> {
  if (await isAncestor(git, base, head)) return true;
  for (const depth of ANCESTRY_DEPTHS) {
    const deepened = await git([
      'fetch',
      '--no-tags',
      `--depth=${depth}`,
      remote,
      head,
    ]);
    if (deepened.code === 0 && (await isAncestor(git, base, head))) {
      return true;
    }
  }
  return false;
}

/** How a change set's base relates to the base the branch last published. */
type BaseRelation = 'same' | 'newer' | 'older' | 'unknown';

/**
 * Relate `base` to the branch's recorded base `accepted`, fetching both
 * histories deeper on a miss. `unknown` covers unrelated commits (a
 * rewritten base branch) and ancestry deeper than the last fetch depth.
 */
async function relateBase(
  git: GitRunner,
  remote: string,
  accepted: string,
  base: string,
): Promise<BaseRelation> {
  if (accepted === base) return 'same';
  for (const depth of [0, ...ANCESTRY_DEPTHS]) {
    if (depth > 0) {
      const fetched = await git([
        'fetch',
        '--no-tags',
        `--depth=${depth}`,
        remote,
        base,
        accepted,
      ]);
      if (fetched.code !== 0) return 'unknown';
    }
    if (await isAncestor(git, accepted, base)) return 'newer';
    if (await isAncestor(git, base, accepted)) return 'older';
  }
  return 'unknown';
}

/**
 * The base recorded in an agent-ci commit: the LAST `Agent-CI-Base:` line of
 * its message (the trailer agent-ci writes), so a title that happens to look
 * like a trailer can never stand in for it. `undefined` when there is none.
 */
async function recordedBase(
  git: GitRunner,
  commit: string,
): Promise<Result<string | undefined>> {
  const shown = await git(['cat-file', 'commit', commit]);
  if (shown.code !== 0) {
    return failure(
      'E_PUBLISH',
      `cannot read commit ${commit}: ${gitError(shown)}`,
    );
  }
  const message = shown.stdout.split('\n\n').slice(1).join('\n\n');
  const pattern = new RegExp(`^${BASE_TRAILER}: ([0-9a-f]{40})\\s*$`, 'gmu');
  return success([...message.matchAll(pattern)].at(-1)?.[1]);
}

/**
 * The complete pull request diff of `commit`: against its merge base with
 * the base branch's current head on the remote, which is what the pull
 * request shows. Fails closed when the merge base cannot be found.
 */
async function pullRequestDiff(
  git: GitRunner,
  remote: string,
  baseBranch: string,
  commit: string,
  parents: readonly string[],
): Promise<Result<PullDiffEntry[]>> {
  const tip = await remoteHead(git, remote, baseBranch);
  if (!tip.ok) return tip;
  if (tip.value === null) {
    return failure(
      'E_PUBLISH',
      `the base branch ${baseBranch} does not exist on ${remote}`,
    );
  }
  const tipReady = await ensureCommit(git, remote, tip.value);
  if (!tipReady.ok) return tipReady;
  let mergeBase: string | undefined;
  for (const depth of [0, ...ANCESTRY_DEPTHS]) {
    if (depth > 0) {
      await git([
        'fetch',
        '--no-tags',
        `--depth=${depth}`,
        remote,
        tip.value,
        ...parents,
      ]);
    }
    const found = await git(['merge-base', tip.value, commit]);
    const sha = found.stdout.trim().split('\n')[0] ?? '';
    if (found.code === 0 && SHA.test(sha)) {
      mergeBase = sha;
      break;
    }
  }
  if (mergeBase === undefined) {
    return failure(
      'E_PUBLISH',
      `cannot find where the pull request into ${baseBranch} would start: the new commit and ${baseBranch} share no commit within ${ANCESTRY_DEPTHS.at(-1)} commits`,
      'Nothing was pushed. Rerun the agent on the current base branch.',
    );
  }
  const listed = await git([
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    mergeBase,
    commit,
  ]);
  if (listed.code !== 0) {
    return failure('E_PUBLISH', `git diff-tree failed: ${gitError(listed)}`);
  }
  const fields = listed.stdout.split('\0');
  const entries: PullDiffEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ADMT])$/u.exec(
      fields[index] ?? '',
    );
    const file = fields[index + 1];
    if (meta === null || file === undefined || file === '') {
      return failure(
        'E_PUBLISH',
        'unexpected git diff-tree output for the pull request diff',
      );
    }
    entries.push({
      path: file,
      status: meta[3] as PullDiffEntry['status'],
      mode: meta[2] ?? '',
    });
  }
  return success(entries);
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
  /** The caller's whole-diff check of `commit` against the PR's base. */
  const verifyPullDiff = async (
    commit: string,
    parents: readonly string[],
  ): Promise<Result<void>> => {
    if (options.checkPullDiff === undefined) return success(undefined);
    const diff = await pullRequestDiff(
      git,
      remote,
      options.baseBranch,
      commit,
      parents,
    );
    return diff.ok ? options.checkPullDiff(diff.value) : diff;
  };
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
  let recorded: string | undefined;
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
    // The tree is rebuilt from the change set's base, so a base older than
    // the one the branch already publishes would undo the newer base's
    // changes in the pull request. Refuse it, and refuse a base that cannot
    // be related to the recorded one unless the branch is adopted.
    const accepted = await recordedBase(git, existing.value);
    if (!accepted.ok) return accepted;
    recorded = accepted.value;
    if (recorded !== undefined && recorded !== base) {
      const acceptedReady = await ensureCommit(git, remote, recorded);
      const relation = acceptedReady.ok
        ? await relateBase(git, remote, recorded, base)
        : 'unknown';
      if (relation === 'older') {
        return failure(
          'E_PUBLISH_STALE_BASE',
          `the change set was built on ${base.slice(0, 12)}, an older commit than ${recorded.slice(0, 12)}, the base ${branch} already publishes; publishing it would undo the newer base's changes`,
          'Nothing was pushed. Rerun the agent on the current base branch.',
        );
      }
      if (relation === 'unknown' && options.adoptBranch !== true) {
        return failure(
          'E_PUBLISH_STALE_BASE',
          `cannot show that the change set's base ${base.slice(0, 12)} is the base ${branch} already publishes (${recorded.slice(0, 12)}) or a newer commit`,
          'Nothing was pushed. Rerun the agent on the current base branch; if the base branch was rewritten, delete the static branch or pass --adopt-branch.',
        );
      }
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
      // Unchanged when the tree is the same and the base is already in the
      // branch's history (the recorded base; an older one was refused
      // above). A base the branch does not contain gets an ancestry commit
      // (parents: head, new base) even with an identical tree, so the pull
      // request diff is against the new base.
      const included =
        recorded === base || (await containsBase(git, remote, head, base));
      if (headTree === tree && included) {
        // Nothing is pushed, but the caller will open or update a pull
        // request from this head against `baseBranch`: check that diff.
        const checked = await verifyPullDiff(head, [head]);
        if (!checked.ok) return checked;
        return success({ branch, commit: head, action: 'unchanged' });
      }
      parents.push(head);
      if (!included) parents.push(base);
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
    const checked = await verifyPullDiff(commit, parents);
    if (!checked.ok) return checked;
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
