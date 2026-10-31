import { maskSecrets } from '@agent-ci/contracts/secret-guard.js';
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
  family: 'claude',
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

  it.each([
    ['gpt-6.1-sol-high', 'gpt-6.1-sol', 'codex', 'high'],
    ['gpt-6.1-sol-low', 'gpt-6.1-sol', 'codex', 'low'],
    ['claude-opus-5-5-high', 'claude-opus-5-5', 'claude', 'high'],
  ])(
    'resolves %s to its exact provider model and effort',
    async (model, providerModel, harness, effort) => {
      const loaded = await loadModelsFile(DEFAULT_MODELS_PATH);
      if (!loaded.ok) throw new Error(loaded.message);
      const resolved = resolveRoute(
        loaded.value,
        request({
          model,
          allowPool: true,
          env: {
            CI: 'true',
            RUNNER_ENVIRONMENT: 'self-hosted',
            AGENT_CI_PROXY_API_KEY: PRESENT,
            ANTHROPIC_AUTH_TOKEN: PRESENT,
          },
        }),
      );
      expect(resolved.ok && resolved.value.route).toMatchObject({
        providerModel,
        harness,
        effort,
        billing: 'subscription',
        account: 'pool',
        qualified: null,
      });
    },
  );

  it('never selects account class work for grok-4.7 by fallback', async () => {
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
            family: 'other',
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
            family: 'other',
            providerModel: 'anthropic/haiku',
            credentials: ['CURSOR_API_KEY'],
          }),
        ],
      }),
    );
    expect(parsed).toMatchObject({ code: 'E_POLICY_HARNESS' });
  });

  it('rejects Cursor-style Claude IDs off the claude harness even when mislabeled', () => {
    for (const id of ['sonnet-4-thinking', 'opus-4.1', 'sonnet-4.5']) {
      const parsed = one(
        route({
          id: `cursor-${id}`,
          model: id,
          harness: 'cursor',
          family: 'other',
          providerModel: id,
          credentials: ['CURSOR_API_KEY'],
        }),
      );
      expect(parsed, id).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
    }
  });

  it.each([
    ['sonnet4.5', 'model'],
    ['sonnet4.5', 'providerModel'],
    ['opus41', 'model'],
    ['opus41', 'providerModel'],
    ['haiku4', 'model'],
    ['haiku4', 'providerModel'],
    ['vendor_SoNnEt4.5', 'providerModel'],
  ])('rejects separator-less Claude ID %s in %s', (name, field) => {
    const parsed = one(
      route({
        id: 'mislabeled',
        model: 'grok-4.7',
        harness: 'cursor',
        family: 'xai',
        providerModel: 'grok-4.7-low',
        credentials: ['CURSOR_API_KEY'],
        [field]: name,
      }),
    );
    expect(parsed).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
  });

  it.each([
    'auto',
    'auto-smart',
    'default',
    'auto(quality=high)',
    'auto[quality=high]',
    'auto:quality=high',
    'auto/quality/high',
    'auto?quality=high',
    'auto_smart',
    'auto-smart(quality=high)',
    ' AUTO ',
    '\tAuTo-SmArT\n',
    ' DeFaUlT ',
    ' AuTo (quality=high) ',
  ])('rejects Cursor automatic provider selector %j', (providerModel) => {
    const parsed = one(
      route({
        id: 'automatic',
        model: 'fast-model',
        harness: 'cursor',
        family: 'xai',
        providerModel,
        credentials: ['CURSOR_API_KEY'],
      }),
    );
    expect(parsed).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
  });

  it.each(['grok-4.7', 'auto'])(
    'loads and resolves explicit Grok under model key %s',
    (model) => {
      const models = file([
        route({
          id: 'grok-4.7-cursor',
          model,
          harness: 'cursor',
          family: 'xai',
          providerModel: 'grok-4.7-low',
          credentials: ['CURSOR_API_KEY'],
        }),
      ]);
      const resolved = resolveRoute(
        models,
        request({ model, env: { CURSOR_API_KEY: PRESENT } }),
      );
      expect(resolved.ok && resolved.value.route).toMatchObject({
        id: 'grok-4.7-cursor',
        model,
        harness: 'cursor',
        family: 'xai',
        providerModel: 'grok-4.7-low',
      });
    },
  );

  it('rejects family claude under a neutral name on a non-Claude harness', () => {
    const parsed = one(
      route({
        id: 'neutral',
        model: 'fast-cheap',
        harness: 'cursor',
        family: 'claude',
        providerModel: 'fast-cheap-1',
        credentials: ['CURSOR_API_KEY'],
      }),
    );
    expect(parsed).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
  });

  it('fails closed when a route omits its family', () => {
    const { family: _omitted, ...rest } = route({
      id: 'no-family',
      model: 'grok-4.7',
      harness: 'cursor',
      providerModel: 'grok-4.7-low',
      credentials: ['CURSOR_API_KEY'],
    });
    expect(one(rest)).toMatchObject({ ok: false, code: 'E_ROUTE_CONFIG' });
  });

  it('rejects a non-Claude family on the claude harness', () => {
    expect(
      one(
        route({
          id: 'gpt-on-claude',
          model: 'gpt-5.6-luna',
          family: 'openai',
          providerModel: 'gpt-5.6-luna',
          credentials: ['CLAUDE_CODE_OAUTH_TOKEN'],
        }),
      ),
    ).toMatchObject({ ok: false, code: 'E_ROUTE_CONFIG' });
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
      family: 'xai',
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

describe('pool policy under CI (operator change 2026-10-31)', () => {
  const pool = file([
    route({
      id: 'codex-pool',
      model: 'gpt-x',
      harness: 'codex',
      family: 'openai',
      providerModel: 'gpt-x',
      credentials: ['AGENT_CI_PROXY_API_KEY'],
      baseUrl: 'http://127.0.0.1:8317/v1',
      account: 'pool',
      structuredOutput: 'output-schema',
    }),
    route({
      id: 'claude-pool',
      model: 'claude-x',
      credentials: ['ANTHROPIC_AUTH_TOKEN'],
      baseUrl: 'http://127.0.0.1:8317',
      account: 'pool',
    }),
  ]);
  const ci = (
    runner: string | undefined,
    extra: Record<string, string> = {},
  ) => ({
    CI: 'true',
    AGENT_CI_PROXY_API_KEY: PRESENT,
    ANTHROPIC_AUTH_TOKEN: PRESENT,
    ...(runner === undefined ? {} : { RUNNER_ENVIRONMENT: runner }),
    ...extra,
  });
  const resolve = (
    routeId: string,
    allowPool: boolean,
    env: Record<string, string>,
  ) => resolveRoute(pool, request({ routeId, allowPool, env }));

  for (const routeId of ['codex-pool', 'claude-pool']) {
    it(`${routeId}: requires self-hosted CI and explicit pool opt-in`, () => {
      expect(resolve(routeId, true, ci('self-hosted')).ok).toBe(true);
      for (const runner of ['github-hosted', undefined]) {
        expect(resolve(routeId, true, ci(runner))).toMatchObject({
          code: 'E_POLICY_POOL_CI',
        });
      }
      expect(resolve(routeId, false, ci('self-hosted'))).toMatchObject({
        code: 'E_POLICY_POOL',
      });
    });
  }

  it('requires the same explicit opt-in for local pool runs', () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: PRESENT,
      AGENT_CI_PROXY_API_KEY: PRESENT,
    };
    for (const routeId of ['claude-pool', 'codex-pool']) {
      expect(resolve(routeId, true, env).ok).toBe(true);
      expect(resolve(routeId, false, env)).toMatchObject({
        code: 'E_POLICY_POOL',
      });
    }
  });
});

describe('proxy origin override (AGENT_CI_PROXY_BASE_URL)', () => {
  const ORIGIN = 'https://proxy.example.com';
  const routes = file([
    route({
      id: 'codex-pool',
      model: 'gpt-x',
      harness: 'codex',
      family: 'openai',
      providerModel: 'gpt-x',
      credentials: ['AGENT_CI_PROXY_API_KEY'],
      baseUrl: 'http://127.0.0.1:8317/v1',
      account: 'pool',
      structuredOutput: 'output-schema',
    }),
    route({
      id: 'claude-pool',
      model: 'claude-x',
      credentials: ['ANTHROPIC_AUTH_TOKEN'],
      baseUrl: 'http://127.0.0.1:8317',
      account: 'pool',
    }),
    route({
      id: 'codex-personal',
      model: 'gpt-y',
      harness: 'codex',
      family: 'openai',
      providerModel: 'gpt-y',
      credentials: ['SYNTHETIC_GATEWAY_KEY'],
      baseUrl: 'https://gateway.example.org/v1',
      account: 'personal',
      structuredOutput: 'output-schema',
    }),
  ]);
  const local = (override: string | undefined) => ({
    AGENT_CI_PROXY_API_KEY: PRESENT,
    ANTHROPIC_AUTH_TOKEN: PRESENT,
    SYNTHETIC_GATEWAY_KEY: PRESENT,
    ...(override === undefined ? {} : { AGENT_CI_PROXY_BASE_URL: override }),
  });
  const baseUrl = (routeId: string, env: Record<string, string>) => {
    const resolved = resolveRoute(
      routes,
      request({ routeId, allowPool: true, env }),
    );
    if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
    return resolved.value.route.baseUrl;
  };

  it('serves pool routes from the override origin, keeping the route path', () => {
    expect(baseUrl('codex-pool', local(ORIGIN))).toBe(
      'https://proxy.example.com/v1',
    );
    expect(baseUrl('claude-pool', local(ORIGIN))).toBe(
      'https://proxy.example.com',
    );
    // A non-default port is part of the origin.
    expect(baseUrl('codex-pool', local('https://proxy.example.com:8443'))).toBe(
      'https://proxy.example.com:8443/v1',
    );
    // Selection by model takes the same path as --route.
    const byModel = resolveRoute(
      routes,
      request({ model: 'gpt-x', allowPool: true, env: local(ORIGIN) }),
    );
    expect(byModel.ok && byModel.value.route.baseUrl).toBe(
      'https://proxy.example.com/v1',
    );
  });

  it('never touches a non-pool route, even when the override is invalid', () => {
    expect(baseUrl('codex-personal', local(ORIGIN))).toBe(
      'https://gateway.example.org/v1',
    );
    expect(baseUrl('codex-personal', local('not a url'))).toBe(
      'https://gateway.example.org/v1',
    );
  });

  it('keeps the loopback default when the variable is unset, empty or blank', () => {
    for (const override of [undefined, '', '   ']) {
      expect(baseUrl('codex-pool', local(override))).toBe(
        'http://127.0.0.1:8317/v1',
      );
      expect(baseUrl('claude-pool', local(override))).toBe(
        'http://127.0.0.1:8317',
      );
    }
  });

  it('accepts plain http only for a loopback host', () => {
    expect(baseUrl('codex-pool', local('http://127.0.0.1:9000'))).toBe(
      'http://127.0.0.1:9000/v1',
    );
    expect(baseUrl('codex-pool', local('http://localhost:9000'))).toBe(
      'http://localhost:9000/v1',
    );
    expect(baseUrl('codex-pool', local('http://[::1]:9000'))).toBe(
      'http://[::1]:9000/v1',
    );
  });

  it('rejects anything but an https origin with E_ROUTE_CONFIG, never echoing the value', () => {
    // Each value carries a marker the error must not repeat.
    const cases: [string, RegExp][] = [
      ['http://private-marker.example.com', /https/u],
      ['ftp://private-marker.example.com', /https/u],
      ['https://user-marker:pw-marker@proxy.example.com', /username/u],
      ['https://token-marker@proxy.example.com', /username/u],
      ['https://proxy.example.com/?k=query-marker', /query/u],
      ['https://proxy.example.com?', /query/u],
      ['https://proxy.example.com/#frag-marker', /fragment/u],
      ['https://proxy.example.com/path-marker', /path/u],
      ['https://proxy.example.com/v1', /path/u],
      ['private-marker.example.com', /absolute URL/u],
      // Forms WHATWG parsing would normalize into a bare origin.
      ['https://proxy.example.com/marker/..', /path/u],
      ['https://proxy.example.com/%2e%2e', /path/u],
      ['https://proxy.example.com\\marker', /path/u],
      ['https://@marker-proxy.example.com', /username/u],
      ['https://marker-proxy.example.com/', /trailing slash/u],
      // Values the secret guard would not match after normalization.
      ['HTTPS://MARKER-PROXY.EXAMPLE.COM', /canonical/u],
      ['https://marker-proxy.example.com:443', /canonical/u],
      ['https://märker-proxy.example.com', /canonical/u],
      ['https://marker-proxy.example.com\n', /whitespace/u],
      [' https://marker-proxy.example.com', /whitespace/u],
    ];
    for (const [value, rule] of cases) {
      const resolved = resolveRoute(
        routes,
        request({ routeId: 'codex-pool', allowPool: true, env: local(value) }),
      );
      expect(resolved.ok, value).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.code, value).toBe('E_ROUTE_CONFIG');
      expect(resolved.message, value).toContain('AGENT_CI_PROXY_BASE_URL');
      expect(resolved.message, value).toMatch(rule);
      const shown = `${resolved.message} ${resolved.hint ?? ''}`;
      expect(shown, value).not.toContain(value);
      expect(shown, value).not.toMatch(/marker/u);
    }
  });

  it('accepts only values the secret guard masks wherever the effective URL appears', () => {
    // The guard matches the raw variable as a substring; every accepted
    // value must therefore be a prefix of each effective base URL.
    for (const value of [
      ORIGIN,
      'https://proxy.example.com:8443',
      'http://[::1]:9000',
    ]) {
      for (const routeId of ['codex-pool', 'claude-pool']) {
        const effective = baseUrl(routeId, local(value));
        expect(effective?.startsWith(value), `${routeId} ${value}`).toBe(true);
        expect(
          maskSecrets(`connect ${effective}/responses failed`, [value]),
        ).not.toContain(effective);
      }
    }
  });

  it('leaves the pool policy unchanged when the override is set', () => {
    const ci = (runner: string) => ({
      ...local(ORIGIN),
      CI: 'true',
      RUNNER_ENVIRONMENT: runner,
    });
    const resolve = (routeId: string, allowPool: boolean, runner: string) =>
      resolveRoute(routes, request({ routeId, allowPool, env: ci(runner) }));
    for (const routeId of ['codex-pool', 'claude-pool']) {
      expect(resolve(routeId, true, 'github-hosted')).toMatchObject({
        code: 'E_POLICY_POOL_CI',
      });
      expect(resolve(routeId, false, 'self-hosted')).toMatchObject({
        code: 'E_POLICY_POOL',
      });
    }
    // Both harnesses resolve on the opted-in self-hosted runner, preserving
    // each route's endpoint path under the same private origin.
    const allowed = resolve('codex-pool', true, 'self-hosted');
    expect(allowed.ok && allowed.value.route.baseUrl).toBe(
      'https://proxy.example.com/v1',
    );
    const claudeAllowed = resolve('claude-pool', true, 'self-hosted');
    expect(claudeAllowed.ok && claudeAllowed.value.route.baseUrl).toBe(ORIGIN);
  });
});
