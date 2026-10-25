import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import {
  loadModelsFile,
  parseModelsFile,
  resolveRoute,
  type ResolveRequest,
} from '@agent-ci/routing/resolve.js';
import type { ModelsFile } from '@agent-ci/routing/schema.js';
import { describe, expect, it } from 'vitest';

// Synthetic credential placeholders; tests only check presence.
const PRESENT = 'synthetic-credential-placeholder';

const route = (overrides: Record<string, unknown>) => ({
  harness: 'claude',
  providerModel: 'claude-haiku-4-5-20251001',
  billing: 'subscription',
  account: 'personal',
  structuredOutput: 'json-schema',
  qualified: null,
  ...overrides,
});

function file(routes: Record<string, unknown>[]): ModelsFile {
  const parsed = parseModelsFile(JSON.stringify({ version: 1, routes }));
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.value;
}

const one = (r: Record<string, unknown>) =>
  parseModelsFile(JSON.stringify({ version: 1, routes: [r] }));

const request = (overrides: Partial<ResolveRequest> = {}): ResolveRequest => ({
  allowPool: false,
  seedLogin: false,
  env: {},
  ...overrides,
});

describe('checked-in models.yaml', () => {
  it('loads and passes every load-time policy check', async () => {
    const loaded = await loadModelsFile(DEFAULT_MODELS_PATH);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const ids = loaded.value.routes.map((entry) => entry.id);
    expect(ids).toContain('fake-echo');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never selects the work account for grok-4.7 by fallback', async () => {
    const loaded = await loadModelsFile(DEFAULT_MODELS_PATH);
    if (!loaded.ok) throw new Error(loaded.message);
    const resolved = resolveRoute(
      loaded.value,
      request({ model: 'grok-4.7', env: { CURSOR_API_KEY: PRESENT } }),
    );
    expect(resolved).toMatchObject({ code: 'E_POLICY_ACCOUNT_FALLBACK' });
    const pinned = resolveRoute(
      loaded.value,
      request({
        model: 'grok-4.7',
        harness: 'cursor',
        env: { CURSOR_API_KEY: PRESENT },
      }),
    );
    expect(pinned.ok && pinned.value.route.id).toBe('grok-4.7-cursor');
  });
});

describe('load-time policy', () => {
  it('rejects a Claude model on a non-Claude harness', () => {
    const parsed = parseModelsFile(
      JSON.stringify({
        version: 1,
        routes: [
          route({
            id: 'bad',
            model: 'claude-haiku-4-5',
            harness: 'opencode',
            credentials: ['OPENCODE_API_KEY'],
          }),
        ],
      }),
    );
    expect(parsed).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
  });

  it('rejects an Anthropic provider ID behind a non-Claude model key', () => {
    const parsed = parseModelsFile(
      JSON.stringify({
        version: 1,
        routes: [
          route({
            id: 'sneaky',
            model: 'fast-model',
            harness: 'cursor',
            providerModel: 'anthropic/haiku',
            credentials: ['CURSOR_API_KEY'],
          }),
        ],
      }),
    );
    expect(parsed).toMatchObject({ code: 'E_POLICY_HARNESS' });
  });

  it('rejects a subscription route that names a paid API credential', () => {
    const parsed = parseModelsFile(
      JSON.stringify({
        version: 1,
        routes: [
          route({
            id: 'mixed',
            model: 'claude-haiku-4-5',
            credentials: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
          }),
        ],
      }),
    );
    expect(parsed).toMatchObject({ code: 'E_POLICY_CREDENTIAL' });
  });

  it('rejects routes with no credential, misuse of billing none, duplicates and bad YAML', () => {
    expect(one(route({ id: 'a', model: 'claude-x' }))).toMatchObject({
      code: 'E_ROUTE_CONFIG',
    });
    expect(
      one(
        route({
          id: 'b',
          model: 'claude-x',
          billing: 'none',
          credentials: ['CLAUDE_CODE_OAUTH_TOKEN'],
        }),
      ),
    ).toMatchObject({ code: 'E_ROUTE_CONFIG' });
    const dup = route({
      id: 'c',
      model: 'claude-x',
      credentials: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });
    expect(
      parseModelsFile(JSON.stringify({ version: 1, routes: [dup, dup] })),
    ).toMatchObject({ code: 'E_ROUTE_CONFIG' });
    expect(parseModelsFile('routes: [unclosed')).toMatchObject({
      code: 'E_ROUTE_CONFIG',
    });
    expect(parseModelsFile('version: 2\nroutes: []')).toMatchObject({
      code: 'E_ROUTE_CONFIG',
    });
  });
});

describe('resolveRoute policy rejections', () => {
  const routes = file([
    route({
      id: 'claude-pool',
      model: 'claude-haiku-4-5',
      credentials: ['ANTHROPIC_AUTH_TOKEN'],
      account: 'pool',
    }),
    route({
      id: 'claude-personal',
      model: 'claude-haiku-4-5',
      credentials: ['CLAUDE_CODE_OAUTH_TOKEN'],
    }),
    route({
      id: 'claude-api',
      model: 'claude-haiku-4-5',
      credentials: ['ANTHROPIC_API_KEY'],
      billing: 'paid-api',
    }),
    route({
      id: 'grok-login',
      model: 'grok-4.7',
      harness: 'opencode',
      providerModel: 'opencode-go/grok-4.7',
      structuredOutput: 'prompt',
      login: true,
    }),
  ]);

  it('rejects a Claude model pinned to a non-Claude harness', () => {
    expect(
      resolveRoute(
        routes,
        request({ model: 'claude-haiku-4-5', harness: 'codex' }),
      ),
    ).toMatchObject({ code: 'E_POLICY_HARNESS' });
    expect(
      resolveRoute(
        routes,
        request({ routeId: 'claude-personal', harness: 'opencode' }),
      ),
    ).toMatchObject({ code: 'E_POLICY_HARNESS' });
  });

  it('refuses to fall back from subscription to paid billing', () => {
    const resolved = resolveRoute(
      routes,
      request({
        model: 'claude-haiku-4-5',
        env: { ANTHROPIC_API_KEY: PRESENT },
      }),
    );
    expect(resolved).toMatchObject({ ok: false, code: 'E_POLICY_FALLBACK' });
  });

  it('allows the paid route only when selected explicitly', () => {
    const resolved = resolveRoute(
      routes,
      request({ routeId: 'claude-api', env: { ANTHROPIC_API_KEY: PRESENT } }),
    );
    expect(resolved.ok && resolved.value.route.id).toBe('claude-api');
  });

  it('refuses a pool route without --allow-pool', () => {
    expect(
      resolveRoute(
        routes,
        request({
          routeId: 'claude-pool',
          env: { ANTHROPIC_AUTH_TOKEN: PRESENT },
        }),
      ),
    ).toMatchObject({ code: 'E_POLICY_POOL' });
  });

  it('refuses a pool route under CI or GITHUB_ACTIONS even with --allow-pool', () => {
    for (const flag of ['CI', 'GITHUB_ACTIONS']) {
      expect(
        resolveRoute(
          routes,
          request({
            routeId: 'claude-pool',
            allowPool: true,
            env: { ANTHROPIC_AUTH_TOKEN: PRESENT, [flag]: 'true' },
          }),
        ),
      ).toMatchObject({ code: 'E_POLICY_POOL_CI' });
    }
  });

  it('uses the pool when opted in locally', () => {
    const resolved = resolveRoute(
      routes,
      request({
        model: 'claude-haiku-4-5',
        allowPool: true,
        env: { ANTHROPIC_AUTH_TOKEN: PRESENT },
      }),
    );
    expect(resolved.ok && resolved.value.route.id).toBe('claude-pool');
  });

  it('skips the pool under CI and falls back within subscription billing', () => {
    const resolved = resolveRoute(
      routes,
      request({
        model: 'claude-haiku-4-5',
        allowPool: true,
        env: {
          CI: 'true',
          ANTHROPIC_AUTH_TOKEN: PRESENT,
          CLAUDE_CODE_OAUTH_TOKEN: PRESENT,
        },
      }),
    );
    expect(resolved.ok && resolved.value.route.id).toBe('claude-personal');
    expect(resolved.ok && resolved.value.skipped).toEqual([
      { id: 'claude-pool', code: 'E_POLICY_POOL_CI' },
    ]);
  });

  it('reports missing credentials by name only', () => {
    const resolved = resolveRoute(
      routes,
      request({ routeId: 'claude-personal' }),
    );
    expect(resolved).toMatchObject({
      code: 'E_CREDENTIAL_MISSING',
      message: 'route claude-personal needs CLAUDE_CODE_OAUTH_TOKEN',
    });
  });

  it('gates login routes on --seed-login and refuses them in CI', () => {
    expect(resolveRoute(routes, request({ model: 'grok-4.7' }))).toMatchObject({
      code: 'E_CREDENTIAL_MISSING',
    });
    expect(
      resolveRoute(routes, request({ model: 'grok-4.7', seedLogin: true })).ok,
    ).toBe(true);
    expect(
      resolveRoute(
        routes,
        request({ model: 'grok-4.7', seedLogin: true, env: { CI: '1' } }),
      ),
    ).toMatchObject({ code: 'E_POLICY_LOGIN_CI' });
  });

  it('reports unknown models and routes', () => {
    expect(resolveRoute(routes, request({ model: 'nope' }))).toMatchObject({
      code: 'E_ROUTE_NOT_FOUND',
    });
    expect(resolveRoute(routes, request({ routeId: 'nope' }))).toMatchObject({
      code: 'E_ROUTE_NOT_FOUND',
    });
    expect(resolveRoute(routes, request())).toMatchObject({
      code: 'E_INVALID_INPUT',
    });
  });
});
