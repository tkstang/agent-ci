import { failure, success, type Result } from '@agent-ci/result.js';
import {
  fetchTransport,
  GithubClient,
  GithubError,
} from '@agent-ci/review/github.js';
import { isBranchName } from '@agent-ci/review/trigger.js';
import { isRepository } from '@agent-ci/targets/schema.js';

/**
 * Resolve where one run happens, once, in a trusted job that checks out no
 * repository code: the target repository (the calling repository unless a
 * target is named), whether it is another repository, the one commit every
 * job checks out, the publish base branch and the PR to comment on.
 *
 * Token rule: the calling repository is reached only with the job's
 * `GITHUB_TOKEN`; another repository only with the caller-supplied
 * `AGENT_CI_TARGET_TOKEN`, and the run stops when that token is missing.
 * Event-derived defaults (the triggering PR, its head commit, its head
 * branch) describe the calling repository, so they are never applied to
 * another repository.
 */

const SHA = /^[0-9a-f]{40}$/u;
const PR_NUMBER = /^[1-9]\d{0,9}$/u;

export interface ResolveTargetInput {
  /** `owner/name`; empty means the calling repository. */
  readonly repository?: string;
  /** `$GITHUB_REPOSITORY`. */
  readonly callingRepository: string;
  /** Explicit commit or branch to run on. */
  readonly ref?: string;
  /** The triggering commit (PR head for pull-request events). */
  readonly eventRef?: string;
  /** Explicit publish base branch. */
  readonly base?: string;
  /** The triggering branch (PR head branch, or the pushed branch). */
  readonly eventBase?: string;
  /** Explicit PR number to comment on (in the target repository). */
  readonly commentPr?: string;
  /** The triggering PR number. */
  readonly eventPr?: string;
  readonly githubToken?: string;
  readonly targetToken?: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface ResolvedTarget {
  readonly repository: string;
  readonly cross: boolean;
  readonly sha: string;
  readonly base: string;
  readonly commentPr: string;
  readonly defaultBranch: string;
}

const blank = (value: string | undefined): string => (value ?? '').trim();

function isRef(value: string): boolean {
  return SHA.test(value) || isBranchName(value);
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export async function resolveTarget(
  input: ResolveTargetInput,
): Promise<Result<ResolvedTarget>> {
  const calling = blank(input.callingRepository);
  if (!isRepository(calling)) {
    return failure(
      'E_INVALID_INPUT',
      'the calling repository (GITHUB_REPOSITORY) is not owner/name',
    );
  }
  const requested = blank(input.repository) || calling;
  if (!isRepository(requested)) {
    return failure(
      'E_INVALID_INPUT',
      `target repository ${JSON.stringify(requested)} is not owner/name`,
    );
  }
  const cross = requested.toLowerCase() !== calling.toLowerCase();
  const token = cross ? blank(input.targetToken) : blank(input.githubToken);
  if (token === '') {
    return cross
      ? failure(
          'E_TARGET_TOKEN',
          `${requested} is not the calling repository and no AGENT_CI_TARGET_TOKEN was supplied`,
          'Pass a token with contents and pull-requests access on the target as the AGENT_CI_TARGET_TOKEN secret. GITHUB_TOKEN never reaches another repository.',
        )
      : failure('E_INVALID_INPUT', 'GITHUB_TOKEN is not set');
  }
  for (const [name, value] of [
    ['ref', blank(input.ref)],
    ['base', blank(input.base)],
  ] as const) {
    if (value !== '' && !isRef(value)) {
      return failure(
        'E_INVALID_INPUT',
        `${name} ${JSON.stringify(value)} is not a valid ref`,
      );
    }
  }
  const commentPr =
    blank(input.commentPr) || (cross ? '' : blank(input.eventPr));
  if (commentPr !== '' && !PR_NUMBER.test(commentPr)) {
    return failure(
      'E_INVALID_INPUT',
      'the comment PR must be a pull request number',
    );
  }

  let github: GithubClient;
  try {
    github = new GithubClient(
      fetchTransport(token, input.apiUrl, input.fetch ?? fetch),
    );
  } catch (err) {
    return failure(
      'E_INVALID_INPUT',
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    const repo = await github.json({
      method: 'GET',
      path: `/repos/${requested}`,
    });
    const fullName = field(repo, 'full_name');
    const defaultBranch = field(repo, 'default_branch');
    if (
      typeof fullName !== 'string' ||
      fullName.toLowerCase() !== requested.toLowerCase() ||
      typeof defaultBranch !== 'string' ||
      !isBranchName(defaultBranch)
    ) {
      return failure(
        'E_GITHUB_API',
        `GitHub returned unexpected metadata for ${requested}`,
      );
    }
    const base =
      blank(input.base) ||
      (cross ? '' : blank(input.eventBase)) ||
      defaultBranch;
    if (!isBranchName(base)) {
      return failure(
        'E_INVALID_INPUT',
        `base ${JSON.stringify(base)} is not a branch name`,
      );
    }
    const ref = blank(input.ref) || (cross ? base : blank(input.eventRef));
    if (ref === '' || !isRef(ref)) {
      return failure(
        'E_INVALID_INPUT',
        'no commit to run on: pass a ref, or run from an event with a commit',
      );
    }
    const commit = await github.json({
      method: 'GET',
      path: `/repos/${fullName}/commits/${encodeURIComponent(ref)}`,
    });
    const sha = field(commit, 'sha');
    if (typeof sha !== 'string' || !SHA.test(sha)) {
      return failure('E_GITHUB_API', `cannot resolve ${ref} to a commit`);
    }
    return success({
      repository: fullName,
      cross,
      sha,
      base,
      commentPr,
      defaultBranch,
    });
  } catch (err) {
    if (err instanceof GithubError) {
      return failure(
        'E_GITHUB_API',
        err.message,
        cross && (err.status === 404 || err.status === 403)
          ? 'Check that AGENT_CI_TARGET_TOKEN can read the target repository.'
          : undefined,
      );
    }
    throw err;
  }
}
