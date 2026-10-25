import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * Minimal GitHub REST client for publishing (native fetch, no dependency).
 * The token is sent only in the Authorization header and never appears in a
 * returned message.
 */

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  /** Login of the account that opened it (absent when GitHub omits it). */
  readonly author?: string;
}

export interface IssueComment {
  readonly id: number;
  readonly url: string;
  readonly author: string;
  readonly body: string;
}

export interface GitHubClient {
  /** The token's login (a bot login for GITHUB_TOKEN, when it cannot ask). */
  viewer(): Promise<string>;
  findOpenPull(head: string, base: string): Promise<Result<PullRequest | null>>;
  createPull(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<Result<PullRequest>>;
  updatePull(
    number: number,
    input: { title: string; body: string },
  ): Promise<Result<PullRequest>>;
  listComments(issue: number): Promise<Result<IssueComment[]>>;
  createComment(issue: number, body: string): Promise<Result<IssueComment>>;
  updateComment(id: number, body: string): Promise<Result<IssueComment>>;
}

export interface GitHubClientOptions {
  readonly token: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  /** Login assumed when the token cannot read `/user` (GITHUB_TOKEN). */
  readonly fallbackLogin?: string;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_COMMENT_PAGES = 20;

interface RawPull {
  number: number;
  html_url: string;
  user?: { login?: string } | null;
}
interface RawComment {
  id: number;
  html_url: string;
  body?: string | null;
  user?: { login?: string } | null;
}

const toPull = (raw: RawPull): PullRequest => ({
  number: raw.number,
  url: raw.html_url,
  ...(typeof raw.user?.login === 'string' ? { author: raw.user.login } : {}),
});
const toComment = (raw: RawComment): IssueComment => ({
  id: raw.id,
  url: raw.html_url,
  author: raw.user?.login ?? '',
  body: raw.body ?? '',
});

export function createGitHubClient(
  options: GitHubClientOptions,
): Result<GitHubClient> {
  if (!REPO.test(options.repo)) {
    return failure('E_INVALID_INPUT', `invalid repository ${options.repo}`);
  }
  if (options.token === '') {
    return failure(
      'E_PUBLISH',
      'no GitHub token (set GITHUB_TOKEN or GH_TOKEN)',
    );
  }
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
  const doFetch = options.fetch ?? fetch;
  const [owner, name] = options.repo.split('/') as [string, string];

  async function call<T>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<Result<T>> {
    let response: Response;
    try {
      response = await doFetch(`${api}${route}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agent-ci',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      return failure(
        'E_PUBLISH',
        `GitHub API ${method} ${route} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      let detail = '';
      try {
        const parsed = (await response.json()) as { message?: unknown };
        detail =
          typeof parsed.message === 'string' ? `: ${parsed.message}` : '';
      } catch {
        detail = '';
      }
      return failure(
        'E_PUBLISH',
        `GitHub API ${method} ${route} returned ${response.status}${detail.slice(0, 300)}`,
      );
    }
    return success((await response.json()) as T);
  }

  const repoPath = `/repos/${owner}/${name}`;
  return success({
    async viewer() {
      // Personal tokens can read /user; GITHUB_TOKEN and GitHub App tokens
      // cannot (403), so the caller names App identities explicitly. One
      // retry keeps a transient failure from switching identities.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const me = await call<{ login?: string }>('GET', '/user');
        if (me.ok && typeof me.value.login === 'string') return me.value.login;
      }
      return options.fallbackLogin ?? 'github-actions[bot]';
    },
    async findOpenPull(head, base) {
      const query = new URLSearchParams({
        head: `${owner}:${head}`,
        base,
        state: 'open',
      });
      const found = await call<RawPull[]>('GET', `${repoPath}/pulls?${query}`);
      if (!found.ok) return found;
      const [first] = found.value;
      return success(first === undefined ? null : toPull(first));
    },
    async createPull(input) {
      const created = await call<RawPull>('POST', `${repoPath}/pulls`, {
        ...input,
        maintainer_can_modify: false,
      });
      return created.ok ? success(toPull(created.value)) : created;
    },
    async updatePull(number, input) {
      const updated = await call<RawPull>(
        'PATCH',
        `${repoPath}/pulls/${number}`,
        input,
      );
      return updated.ok ? success(toPull(updated.value)) : updated;
    },
    async listComments(issue) {
      const all: IssueComment[] = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
        const listed = await call<RawComment[]>(
          'GET',
          `${repoPath}/issues/${issue}/comments?per_page=100&page=${page}`,
        );
        if (!listed.ok) return listed;
        all.push(...listed.value.map(toComment));
        if (listed.value.length < 100) break;
      }
      return success(all);
    },
    async createComment(issue, body) {
      const created = await call<RawComment>(
        'POST',
        `${repoPath}/issues/${issue}/comments`,
        { body },
      );
      return created.ok ? success(toComment(created.value)) : created;
    },
    async updateComment(id, body) {
      const updated = await call<RawComment>(
        'PATCH',
        `${repoPath}/issues/comments/${id}`,
        { body },
      );
      return updated.ok ? success(toComment(updated.value)) : updated;
    },
  });
}
