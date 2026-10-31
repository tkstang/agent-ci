import { ReviewError } from '@agent-ci/review/contracts.js';

/**
 * A small GitHub REST client for the PR review jobs. The transport is
 * injected (tests pass a fake; the workflow uses `fetch` with the job's
 * token), every response is untrusted, and any status other than the
 * expected ones fails closed with `E_GITHUB_API`. The token is sent only in
 * the Authorization header and never appears in a message.
 */

export type GithubMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type GithubRequest = {
  method: GithubMethod;
  /** Path below the API root, starting with `/`. */
  path: string;
  body?: unknown;
  /** `Accept` header; JSON by default. */
  accept?: string;
};
export type GithubResponse = {
  status: number;
  /** Lower-case header lookup. */
  header: (name: string) => string | null;
  text: string;
};
export type GithubTransport = (
  request: GithubRequest,
) => Promise<GithubResponse>;

export class GithubError extends ReviewError {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super('E_GITHUB_API', message);
    this.status = status;
  }
}

function githubError(message: string, status: number | null): GithubError {
  return new GithubError(message, status);
}

const JSON_ACCEPT = 'application/vnd.github+json';

/** A `fetch`-based transport bound to one token. */
export function fetchTransport(
  token: string,
  apiUrl = 'https://api.github.com',
  fetchImpl: typeof fetch = fetch,
): GithubTransport {
  if (token.trim() === '')
    throw githubError('a GitHub token is required', null);
  const root = apiUrl.replace(/\/+$/u, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._/-]*)?$/u.test(root))
    throw githubError('invalid GitHub API URL', null);
  return async (request) => {
    const response = await fetchImpl(`${root}${request.path}`, {
      method: request.method,
      headers: {
        accept: request.accept ?? JSON_ACCEPT,
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'agent-ci-pr-review',
        ...(request.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      redirect: 'error',
    });
    return {
      status: response.status,
      header: (name) => response.headers.get(name),
      text: await response.text(),
    };
  };
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export function repositoryPath(repository: string): string {
  if (!REPOSITORY.test(repository))
    throw githubError('invalid repository name', null);
  return `/repos/${repository}`;
}

export class GithubClient {
  readonly transport: GithubTransport;
  constructor(transport: GithubTransport) {
    this.transport = transport;
  }

  /**
   * Send a request and return the response when its status is one of
   * `ok` (default: any 2xx). Anything else fails closed.
   */
  async send(
    request: GithubRequest,
    ok: readonly number[] = [],
  ): Promise<GithubResponse> {
    let response: GithubResponse;
    try {
      response = await this.transport(request);
    } catch {
      throw githubError(
        `GitHub ${request.method} ${request.path.split('?')[0]} failed`,
        null,
      );
    }
    const accepted =
      ok.length === 0
        ? response.status >= 200 && response.status < 300
        : ok.includes(response.status);
    if (!accepted)
      throw githubError(
        `GitHub ${request.method} ${request.path.split('?')[0]} returned ${response.status}`,
        response.status,
      );
    return response;
  }

  /** JSON body of a successful request (untrusted). */
  async json(request: GithubRequest, ok?: readonly number[]): Promise<unknown> {
    const response = await this.send(request, ok);
    if (response.status === 204 || response.text.trim() === '') return null;
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw githubError(
        `GitHub ${request.method} ${request.path.split('?')[0]} returned invalid JSON`,
        response.status,
      );
    }
  }

  /**
   * Every page of a list endpoint (`per_page=100`), up to `maxPages`.
   * `truncated` is true when more pages remained.
   */
  async paginate(
    path: string,
    maxPages = 30,
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.send({
        method: 'GET',
        path: `${path}${separator}per_page=100&page=${page}`,
      });
      let batch: unknown;
      try {
        batch = JSON.parse(response.text);
      } catch {
        throw githubError(
          `GitHub GET ${path.split('?')[0]} returned invalid JSON`,
          response.status,
        );
      }
      if (!Array.isArray(batch))
        throw githubError(
          `GitHub GET ${path.split('?')[0]} did not return a list`,
          response.status,
        );
      items.push(...batch);
      const link = response.header('link') ?? '';
      if (batch.length < 100 || !/rel="next"/u.test(link))
        return { items, truncated: false };
    }
    return { items, truncated: true };
  }
}
