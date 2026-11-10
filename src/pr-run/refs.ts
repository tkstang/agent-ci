import { failure, success, type Result } from '@agent-ci/result.js';
import { GithubError, type GithubClient } from '@agent-ci/review/github.js';
import { isBranchName } from '@agent-ci/review/trigger.js';
import { isRepository } from '@agent-ci/targets/schema.js';

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** PR metadata may cache old SHAs; pin and compare the actual branch ref. */
export async function readPrBranchTip(
  github: GithubClient,
  repository: string,
  branch: string,
): Promise<Result<string>> {
  if (!isRepository(repository) || !isBranchName(branch)) {
    return failure('E_PR_RUN_REQUEST', 'invalid PR branch reference');
  }
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  try {
    const value = await github.json({
      method: 'GET',
      path: `/repos/${repository}/git/ref/heads/${encoded}`,
    });
    const object = field(value, 'object');
    const sha = field(object, 'sha');
    if (
      field(value, 'ref') !== `refs/heads/${branch}` ||
      field(object, 'type') !== 'commit' ||
      typeof sha !== 'string' ||
      !/^[0-9a-f]{40}$/u.test(sha)
    ) {
      return failure(
        'E_GITHUB_API',
        'the branch lookup returned an invalid commit reference',
      );
    }
    return success(sha);
  } catch (error) {
    return failure(
      'E_GITHUB_API',
      error instanceof GithubError ? error.message : 'the branch lookup failed',
    );
  }
}
