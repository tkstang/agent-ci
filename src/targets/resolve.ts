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
 * That token can write, so the workflows reference it only in jobs that run
 * no repository code and no agent (resolve, publish): on a GitHub-hosted
 * runner any step can read every secret its job references. Jobs that do
 * run repository code check another repository out with the optional,
 * read-only `AGENT_CI_TARGET_READ_TOKEN` (else `GITHUB_TOKEN`, which reads
 * public repositories only); a private target without it, and a read token
 * that is the write token, is a scoped classic token or can write repository
 * contents, are refused here, before any job runs its code. Other write
 * permissions of a fine-grained or App token (pull requests, Actions,
 * secrets, administration) cannot be introspected and are not detected: the
 * operator must grant `contents: read` and nothing else.
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
  /** Read-only token the checkout of another repository uses. */
  readonly readToken?: string;
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

const RATE_LIMIT_MESSAGE = /rate limit|abuse/iu;
/** GitHub's permission denial for fine-grained, App and Actions tokens. */
const PERMISSION_DENIED =
  /^Resource not accessible by (?:personal access token|integration)$/u;

/**
 * Admission contract for the dry-run write probe (`POST git/refs` with an
 * all-zero SHA). Only a recognized permission denial proves the token cannot
 * write contents; everything else is refused or fails closed:
 * - 422: authorization passed and validation failed, so the token can write
 *   contents: `writer`.
 * - Any rate-limit signal, checked first and on every status:
 *   `x-ratelimit-remaining: 0`, a `retry-after` header, status 429, or a
 *   message that mentions a rate limit or abuse. GitHub documents these
 *   403/429 responses as unrelated to permissions, so the token's
 *   permission is unknown: `unknown`.
 * - 403 whose JSON `message` is exactly "Resource not accessible by personal
 *   access token" or "... by integration": `denied`.
 * - 404 whose JSON `message` is exactly "Not Found" (GitHub hides a write
 *   endpoint from a token that cannot use it): `denied`.
 * - Anything else (another message such as SAML enforcement, an unparsable
 *   body, another status): `unknown`.
 */
export function probeVerdict(response: {
  readonly status: number;
  readonly header: (name: string) => string | null;
  readonly text: string;
}): 'writer' | 'denied' | 'unknown' {
  let message = '';
  try {
    const body = JSON.parse(response.text) as unknown;
    const value = field(body, 'message');
    if (typeof value === 'string') message = value.trim();
  } catch {
    message = '';
  }
  if (
    response.header('x-ratelimit-remaining')?.trim() === '0' ||
    response.header('retry-after') !== null ||
    response.status === 429 ||
    RATE_LIMIT_MESSAGE.test(message)
  ) {
    return 'unknown';
  }
  if (response.status === 422) return 'writer';
  if (response.status === 403 && PERMISSION_DENIED.test(message)) {
    return 'denied';
  }
  if (response.status === 404 && message === 'Not Found') return 'denied';
  return 'unknown';
}

function notReadOnly(why: string): Result<never> {
  return failure(
    'E_TARGET_TOKEN',
    `AGENT_CI_TARGET_READ_TOKEN ${why}`,
    'It reaches the jobs that run repository code and the agent: use a fine-grained or GitHub App token granted contents: read and nothing else. agent-ci checks that it is not the write token, not a scoped classic token, and cannot write repository contents; other permissions cannot be checked.',
  );
}

/**
 * Another repository's checkout runs with the read-only token: it must read
 * the repository, a private repository needs one (GITHUB_TOKEN cannot), and
 * what can be checked through the API must show it cannot write contents:
 * - it may not be the write token;
 * - it may not be a classic token reporting any scope (`X-OAuth-Scopes`): a
 *   classic token reads a private repository only with the writable `repo`
 *   scope, and a public target needs no read token, so a scoped classic
 *   read token is never needed;
 * - a dry-run ref creation (an all-zero SHA, which GitHub rejects without
 *   creating anything) must be refused for lack of permission, as defined by
 *   {@link probeVerdict}.
 * Anything else fails closed. Pull-request, Actions, secrets and
 * administration permissions of fine-grained or App tokens cannot be
 * introspected (recorded residual).
 */
async function checkoutAccess(
  repo: unknown,
  repository: string,
  readToken: string,
  input: ResolveTargetInput,
): Promise<Result<void>> {
  if (readToken === '') {
    return field(repo, 'private') === false
      ? success(undefined)
      : failure(
          'E_TARGET_TOKEN',
          `${repository} is private and no AGENT_CI_TARGET_READ_TOKEN was supplied`,
          'Pass a read-only token (contents: read on the target) as AGENT_CI_TARGET_READ_TOKEN; the write token never reaches the jobs that run repository code or the agent.',
        );
  }
  if (readToken === blank(input.targetToken)) {
    return notReadOnly('is the same token as AGENT_CI_TARGET_TOKEN');
  }
  let reader: GithubClient;
  try {
    reader = new GithubClient(
      fetchTransport(readToken, input.apiUrl, input.fetch ?? fetch),
    );
  } catch {
    return notReadOnly('is not usable');
  }
  let scopes: string[];
  try {
    const response = await reader.send({
      method: 'GET',
      path: `/repos/${repository}`,
    });
    scopes = (response.header('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return failure(
      'E_TARGET_TOKEN',
      `AGENT_CI_TARGET_READ_TOKEN cannot read ${repository}`,
    );
  }
  if (scopes.length > 0) {
    return notReadOnly(
      `is a classic token with scopes (${scopes.join(', ')}); a classic token needs the writable repo scope to read a private repository`,
    );
  }
  try {
    const probe = await reader.send(
      {
        method: 'POST',
        path: `/repos/${repository}/git/refs`,
        body: {
          ref: 'refs/heads/agent-ci/read-token-check',
          sha: '0'.repeat(40),
        },
      },
      [403, 404, 422, 429],
    );
    const verdict = probeVerdict(probe);
    if (verdict === 'writer') {
      return notReadOnly(`can write the contents of ${repository}`);
    }
    if (verdict === 'unknown') {
      return notReadOnly(
        `could not be verified unable to write the contents of ${repository} (rate-limited or unrecognized response ${probe.status}); retry later`,
      );
    }
  } catch {
    return notReadOnly(
      `could not be verified unable to write the contents of ${repository}`,
    );
  }
  return success(undefined);
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
    if (cross) {
      const readable = await checkoutAccess(
        repo,
        requested,
        blank(input.readToken),
        input,
      );
      if (!readable.ok) return readable;
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
