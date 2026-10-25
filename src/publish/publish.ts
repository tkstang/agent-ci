import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import {
  type RunResult,
  RunResultSchema,
  validateRunResult,
} from '@agent-ci/contracts/run-result.js';
import {
  CHANGE_SET_FILE,
  type ChangeSet,
  parseChangeSet,
} from '@agent-ci/publish/changes.js';
import type { GitRunner } from '@agent-ci/publish/git.js';
import type { GitHubClient } from '@agent-ci/publish/github.js';
import {
  commentMarker,
  renderComment,
  renderPullBody,
  renderPullTitle,
} from '@agent-ci/publish/render.js';
import {
  type CommitIdentity,
  publishStaticBranch,
} from '@agent-ci/publish/static-branch.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import { isWithin, resolvePhysical } from '@agent-ci/run/workspace.js';

/**
 * Publish a finished run: the static-branch pull request for an edit run that
 * changed files, and an updatable comment on a pull request. Runs in its own
 * job with write authority and no model credential; it reads the run's
 * outputs only from one canonical result directory (the downloaded artifact),
 * never from the agent's workspace.
 */

export const RESULT_FILE = 'run-result.json';
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_CHANGES_BYTES = 80 * 1024 * 1024;

export interface RunOutputs {
  readonly dir: string;
  readonly result: RunResult & { outputContract?: string };
  readonly changeSet: ChangeSet | null;
}

async function readNoFollow(
  file: string,
  maxBytes: number,
): Promise<Result<string | null>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return success(null);
    return failure(
      'E_PUBLISH',
      `cannot open ${path.basename(file)} in the result directory (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      return failure(
        'E_PUBLISH',
        `${path.basename(file)} is not a regular file under ${maxBytes} bytes`,
      );
    }
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, info.size + 1, 0);
    if (bytesRead > info.size) {
      return failure(
        'E_PUBLISH',
        `${path.basename(file)} changed while reading`,
      );
    }
    return success(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Read `run-result.json` and `changes.json` from the canonical result
 * directory: resolved once, physically; refused when it traverses a symlink
 * located inside the repository being published (a checkout could commit
 * `.agent-ci -> elsewhere`); each file is opened without following a link.
 */
export async function readRunOutputs(
  dir: string,
  options: { readonly workspaceRoot?: string } = {},
): Promise<Result<RunOutputs>> {
  let physical: Awaited<ReturnType<typeof resolvePhysical>>;
  try {
    physical = await resolvePhysical(path.resolve(dir));
  } catch {
    return failure('E_PUBLISH', `cannot resolve the result directory ${dir}`);
  }
  const { workspaceRoot } = options;
  const workspaceLink =
    workspaceRoot === undefined
      ? undefined
      : physical.links.find((link) =>
          isWithin(workspaceRoot, path.dirname(link)),
        );
  if (workspaceLink !== undefined) {
    return failure(
      'E_PUBLISH',
      `the result directory path goes through the symlink ${workspaceLink} inside the repository`,
      'Pass the canonical directory the run artifact was downloaded to.',
    );
  }
  const canonical = physical.real;
  const resultText = await readNoFollow(
    path.join(canonical, RESULT_FILE),
    MAX_RESULT_BYTES,
  );
  if (!resultText.ok) return resultText;
  if (resultText.value === null) {
    return failure('E_PUBLISH', `no ${RESULT_FILE} in ${canonical}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(resultText.value);
  } catch {
    return failure('E_INVALID_RUN_RESULT', `${RESULT_FILE} is not valid JSON`);
  }
  const contract =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>).outputContract
      : undefined;
  let result: RunOutputs['result'];
  if (contract === 'verdict') {
    // Verdict items are trusted workflow input; here only the shape matters.
    const parsed = RunResultSchema.safeParse(raw);
    if (!parsed.success) {
      return failure('E_INVALID_RUN_RESULT', `${RESULT_FILE} is malformed`);
    }
    result = parsed.data;
  } else {
    const validated = validateRunResult(raw, {
      outputContract: typeof contract === 'string' ? contract : undefined,
    });
    if (!validated.ok) return validated;
    result = validated.value;
  }
  const changesText = await readNoFollow(
    path.join(canonical, CHANGE_SET_FILE),
    MAX_CHANGES_BYTES,
  );
  if (!changesText.ok) return changesText;
  let changeSet: ChangeSet | null = null;
  if (changesText.value !== null) {
    const parsed = parseChangeSet(changesText.value);
    if (!parsed.ok) return parsed;
    changeSet = parsed.value;
  }
  return success({ dir: canonical, result, changeSet });
}

export interface PublishOptions {
  readonly outputs: RunOutputs;
  readonly github: GitHubClient;
  readonly git?: GitRunner;
  /** Publish the static-branch pull request. */
  readonly pullRequest: boolean;
  readonly branch: string;
  readonly baseBranch: string;
  readonly title?: string;
  /** Pull request number to comment on. */
  readonly commentOn?: number;
  readonly commentKey?: string;
  readonly runUrl?: string;
  readonly author: CommitIdentity;
  /** GITHUB_TOKEN cannot push `.github/workflows/*`; refuse those by default. */
  readonly allowWorkflowChanges?: boolean;
  /** Agent-owned static-branch namespace (default `agent-ci/`). */
  readonly branchPrefix?: string;
  /** Update a branch whose head agent-ci did not publish (history kept). */
  readonly adoptBranch?: boolean;
}

export interface PublishReport {
  readonly status: RunResult['status'];
  readonly ok: boolean;
  readonly pull:
    | {
        readonly action: 'created' | 'updated' | 'unchanged';
        readonly url: string;
        readonly number: number;
        readonly branch: string;
        readonly commit: string;
      }
    | { readonly action: 'skipped'; readonly reason: string };
  readonly comment:
    | { readonly action: 'created' | 'updated'; readonly url: string }
    | { readonly action: 'skipped'; readonly reason: string };
}

const WORKFLOW_PATH = /^\.github\/workflows\//iu;

/** Check the change set against the result it belongs to. */
export function checkChangeSet(
  result: RunResult,
  changeSet: ChangeSet,
  allowWorkflowChanges: boolean,
): Result<void> {
  const claimed = new Set(result.changedFiles);
  const unlisted = changeSet.files.find((entry) => !claimed.has(entry.path));
  if (unlisted !== undefined) {
    return failure(
      'E_CHANGE_SET',
      `changes.json carries ${unlisted.path}, which run-result.json does not list`,
    );
  }
  if (changeSet.files.length === 0) {
    return failure('E_CHANGE_SET', 'changes.json is empty');
  }
  const workflow = changeSet.files.find((entry) =>
    WORKFLOW_PATH.test(entry.path),
  );
  if (workflow !== undefined && !allowWorkflowChanges) {
    return failure(
      'E_PUBLISH',
      `the run changed ${workflow.path}; GITHUB_TOKEN cannot push workflow files`,
      'Publish with a token that has the workflow scope and pass --allow-workflow-changes.',
    );
  }
  return success(undefined);
}

export async function publishRun(
  options: PublishOptions,
): Promise<Result<PublishReport>> {
  const { result, changeSet } = options.outputs;
  let pull: PublishReport['pull'] = {
    action: 'skipped',
    reason: 'pull request publishing not requested',
  };
  if (options.pullRequest) {
    if (!result.ok || result.status !== 'changed') {
      pull = { action: 'skipped', reason: `run status is ${result.status}` };
    } else if (changeSet === null) {
      return failure(
        'E_CHANGE_SET',
        'the run changed files but the result directory has no changes.json',
      );
    } else if (options.git === undefined) {
      return failure(
        'E_PUBLISH',
        'publishing a pull request needs a git checkout',
      );
    } else {
      const checked = checkChangeSet(
        result,
        changeSet,
        options.allowWorkflowChanges === true,
      );
      if (!checked.ok) return checked;
      const title = renderPullTitle(result, options.title);
      const branch = await publishStaticBranch({
        git: options.git,
        changeSet,
        branch: options.branch,
        baseBranch: options.baseBranch,
        title,
        author: options.author,
        ...(options.branchPrefix === undefined
          ? {}
          : { branchPrefix: options.branchPrefix }),
        adoptBranch: options.adoptBranch === true,
      });
      if (!branch.ok) return branch;
      const body = renderPullBody(result, {
        key: options.branch,
        runUrl: options.runUrl,
      });
      const existing = await options.github.findOpenPull(
        options.branch,
        options.baseBranch,
      );
      if (!existing.ok) return existing;
      const upserted =
        existing.value === null
          ? await options.github.createPull({
              head: options.branch,
              base: options.baseBranch,
              title,
              body,
            })
          : await options.github.updatePull(existing.value.number, {
              title,
              body,
            });
      if (!upserted.ok) return upserted;
      pull = {
        action:
          existing.value === null
            ? 'created'
            : branch.value.action === 'unchanged'
              ? 'unchanged'
              : 'updated',
        url: upserted.value.url,
        number: upserted.value.number,
        branch: options.branch,
        commit: branch.value.commit,
      };
    }
  }

  let comment: PublishReport['comment'] = {
    action: 'skipped',
    reason: 'no pull request to comment on',
  };
  if (options.commentOn !== undefined) {
    const key = options.commentKey ?? options.branch;
    const body = renderComment(result, {
      key,
      runUrl: options.runUrl,
      pullUrl: 'url' in pull ? pull.url : undefined,
    });
    const viewer = await options.github.viewer();
    const comments = await options.github.listComments(options.commentOn);
    if (!comments.ok) return comments;
    // Only our own marked comment is updated; a marker quoted by anyone else
    // (or forged into model text) never redirects the update.
    const mine = comments.value.findLast(
      (entry) =>
        entry.author === viewer && entry.body.includes(commentMarker(key)),
    );
    const written =
      mine === undefined
        ? await options.github.createComment(options.commentOn, body)
        : await options.github.updateComment(mine.id, body);
    if (!written.ok) return written;
    comment = {
      action: mine === undefined ? 'created' : 'updated',
      url: written.value.url,
    };
  }
  return success({ status: result.status, ok: result.ok, pull, comment });
}
