import { createGitHubClient } from '@agent-ci/publish/github.js';
import { notify, renderNotification } from '@agent-ci/publish/notify.js';
import {
  commentMarker,
  renderComment,
  sanitize,
} from '@agent-ci/publish/render.js';
import { describe, expect, it } from 'vitest';

const TOKEN = 'synthetic-github-token-0008';

const RESULT = {
  ok: true,
  status: 'changed' as const,
  useCase: 'docs-update',
  targetRepo: 'o/r',
  summary: 'Done',
  artifacts: [],
  materializedArtifacts: [],
  changedFiles: ['a.md'],
  errors: [],
};

describe('createGitHubClient', () => {
  it('authenticates every call and keeps the token out of errors', async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      if (url.endsWith('/user')) return new Response('{}', { status: 403 });
      return Response.json({ message: 'Validation Failed' }, { status: 422 });
    }) as unknown as typeof fetch;
    const client = createGitHubClient({
      token: TOKEN,
      repo: 'o/r',
      fetch: fakeFetch,
    });
    expect(client.ok).toBe(true);
    if (!client.ok) return;
    expect(await client.value.viewer()).toBe('github-actions[bot]');
    const created = await client.value.createPull({
      head: 'h',
      base: 'b',
      title: 't',
      body: 'x',
    });
    expect(created.ok ? 'ok' : created.code).toBe('E_PUBLISH');
    expect(JSON.stringify(created)).toContain('422: Validation Failed');
    expect(JSON.stringify(created)).not.toContain(TOKEN);
    expect(seen.every((value) => value === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('retries /user once before falling back', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 502 })
        : Response.json({ login: 'operator' });
    }) as unknown as typeof fetch;
    const client = createGitHubClient({
      token: TOKEN,
      repo: 'o/r',
      fetch: fakeFetch,
    });
    expect(client.ok && (await client.value.viewer())).toBe('operator');
    expect(calls).toBe(2);
  });

  it('pages through comments and refuses a bad repository or missing token', async () => {
    let page = 0;
    const fakeFetch = (async () => {
      page += 1;
      const count = page === 1 ? 100 : 3;
      return Response.json(
        Array.from({ length: count }, (_, index) => ({
          id: page * 1000 + index,
          html_url: 'u',
          body: 'b',
          user: { login: 'x' },
        })),
      );
    }) as unknown as typeof fetch;
    const client = createGitHubClient({
      token: TOKEN,
      repo: 'o/r',
      fetch: fakeFetch,
    });
    const listed = client.ok ? await client.value.listComments(1) : client;
    expect(listed.ok && listed.value).toHaveLength(103);
    expect(createGitHubClient({ token: TOKEN, repo: 'o/r/x' }).ok).toBe(false);
    expect(createGitHubClient({ token: '', repo: 'o/r' }).ok).toBe(false);
  });
});

describe('rendering', () => {
  it('neutralizes mentions and HTML comment markers and caps length', () => {
    expect(sanitize('hi @team <!-- agent-ci:pr:x -->')).toBe(
      'hi @​team &lt;!-- agent-ci:pr:x -->',
    );
    expect(sanitize('x'.repeat(50), 10)).toBe('xxxxxxxxxx\n\n_(truncated)_');
    const body = renderComment(
      {
        ...RESULT,
        summary: 'y'.repeat(100_000),
        report: { title: 'R', markdown: 'z'.repeat(100_000) },
      } as typeof RESULT,
      { key: 'k' },
    );
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('_(truncated)_');
    // The marker survives the cap, so the next run finds and updates it.
    expect(body.endsWith(commentMarker('k'))).toBe(true);
  });
});

describe('notify', () => {
  it('skips without a webhook, refuses http and never echoes the URL', async () => {
    expect(await notify({ webhookUrl: undefined, result: RESULT })).toEqual({
      ok: true,
      value: { sent: false, reason: 'no webhook configured' },
    });
    const http = await notify({
      webhookUrl: 'http://hooks.example/T0/secret-path',
      result: RESULT,
    });
    expect(http.ok ? 'ok' : http.code).toBe('E_PUBLISH');
    const posted: unknown[] = [];
    const failing = (async (_url: URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;
    const url = 'https://hooks.example/T0/secret-path';
    const failed = await notify({
      webhookUrl: url,
      result: RESULT,
      fetch: failing,
      pullUrl: 'https://gh/pull/1',
    });
    expect(failed.ok ? 'ok' : failed.code).toBe('E_PUBLISH');
    expect(JSON.stringify(failed)).not.toContain('secret-path');
    expect(posted).toEqual([
      {
        text: 'agent-ci docs-update: changed\nDone\nPull request: https://gh/pull/1',
      },
    ]);
    expect(
      renderNotification({ webhookUrl: url, result: RESULT, repo: 'o/r' }),
    ).toContain('on o/r');
  });
});
