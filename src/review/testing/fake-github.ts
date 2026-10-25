import { execFileSync } from 'node:child_process';

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
  readonly prefixes: [string, FakeHandler][] = [];

  on(method: string, routePath: string, handler: FakeHandler): this {
    this.routes.set(`${method} ${routePath}`, handler);
    return this;
  }

  /** Answer every `METHOD <prefix>...` request not matched exactly. */
  onPrefix(method: string, prefix: string, handler: FakeHandler): this {
    this.prefixes.push([`${method} ${prefix}`, handler]);
    return this;
  }

  /**
   * Serve `GET /git/trees/{sha}` and `GET /git/blobs/{sha}` from a real
   * local repository, the way GitHub's git database API answers them
   * (tree entries with mode, type, sha and size; base64 blobs).
   */
  serveGitDatabase(apiRepoPath: string, localRepo: string): this {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: localRepo,
        maxBuffer: 64 * 1024 * 1024,
      });
    this.onPrefix('GET', `${apiRepoPath}/git/trees/`, (request) => {
      const sha = request.path.split('?')[0]?.split('/').at(-1) ?? '';
      let listing: string;
      try {
        listing = git('ls-tree', '-l', '-z', sha).toString('utf8');
      } catch {
        return { status: 404, body: { message: 'Not Found' } };
      }
      const tree = listing
        .split('\u0000')
        .filter(Boolean)
        .map((line) => {
          const [meta = '', name = ''] = line.split('\t');
          const [mode = '', type = '', object = '', size = '-'] =
            meta.split(/ +/u);
          return {
            path: name,
            mode,
            type,
            sha: object,
            size: size === '-' ? null : Number(size),
          };
        });
      return { body: { sha, tree, truncated: false } };
    });
    this.onPrefix('GET', `${apiRepoPath}/git/blobs/`, (request) => {
      const sha = request.path.split('?')[0]?.split('/').at(-1) ?? '';
      try {
        const bytes = git('cat-file', 'blob', sha);
        return {
          body: {
            sha,
            size: bytes.length,
            encoding: 'base64',
            content: bytes.toString('base64'),
          },
        };
      } catch {
        return { status: 404, body: { message: 'Not Found' } };
      }
    });
    return this;
  }

  client(): GithubClient {
    return new GithubClient(async (request): Promise<GithubResponse> => {
      this.requests.push(request);
      const key = `${request.method} ${request.path.split('?')[0]}`;
      const handler =
        this.routes.get(key) ??
        this.prefixes.find(([prefix]) => key.startsWith(prefix))?.[1];
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

  /** The same fake as a `fetch` for code that builds its own client. */
  fetch(): typeof fetch {
    const client = this.client();
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : undefined;
      const response = await client.transport({
        method: (init?.method ?? 'GET') as GithubRequest['method'],
        path: `${url.pathname}${url.search}`,
        ...(body === undefined ? {} : { body }),
      });
      return new Response(response.text === '' ? null : response.text, {
        status: response.status,
        headers:
          response.header('link') === null
            ? {}
            : { link: response.header('link') ?? '' },
      });
    }) as typeof fetch;
  }

  sent(method: string): GithubRequest[] {
    return this.requests.filter((request) => request.method === method);
  }
}
