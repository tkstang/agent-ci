import {
  GithubClient,
  type GithubRequest,
  type GithubResponse,
} from '@agent-ci/review/github.js';

/**
 * Test support: a GitHub REST fake. Each route matches `METHOD path` (the
 * path without its query string) and returns a status and a body; every
 * request is recorded. Unmatched requests answer 404. Excluded from the
 * build (see tsconfig.build.json).
 */

export type FakeRoute = {
  readonly status?: number;
  readonly body?: unknown;
  /** Raw text (for diffs); wins over `body`. */
  readonly text?: string;
  readonly link?: string;
};

export type FakeHandler =
  | FakeRoute
  | ((request: GithubRequest) => FakeRoute | Promise<FakeRoute>);

export class FakeGithub {
  readonly requests: GithubRequest[] = [];
  readonly routes = new Map<string, FakeHandler>();

  on(method: string, routePath: string, handler: FakeHandler): this {
    this.routes.set(`${method} ${routePath}`, handler);
    return this;
  }

  client(): GithubClient {
    return new GithubClient(async (request): Promise<GithubResponse> => {
      this.requests.push(request);
      const key = `${request.method} ${request.path.split('?')[0]}`;
      const handler = this.routes.get(key);
      const route =
        handler === undefined
          ? { status: 404, body: { message: 'Not Found' } }
          : typeof handler === 'function'
            ? await handler(request)
            : handler;
      const text =
        route.text ??
        (route.body === undefined ? '' : JSON.stringify(route.body));
      return {
        status: route.status ?? 200,
        header: (name) =>
          name.toLowerCase() === 'link' ? (route.link ?? null) : null,
        text,
      };
    });
  }

  sent(method: string): GithubRequest[] {
    return this.requests.filter((request) => request.method === method);
  }
}
