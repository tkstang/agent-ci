import { adjudicatorTransport } from '@agent-ci/routing/adjudicator.js';
import type { Route } from '@agent-ci/routing/schema.js';
import { describe, expect, it } from 'vitest';

const route: Route = {
  id: 'sol-low',
  model: 'gpt-6.1-sol-low',
  providerModel: 'gpt-6.1-sol',
  effort: 'low',
  harness: 'codex',
  family: 'openai',
  billing: 'subscription',
  account: 'pool',
  credentials: ['AGENT_CI_PROXY_API_KEY'],
  login: false,
  baseUrl: 'http://127.0.0.1:8317/v1',
  structuredOutput: 'output-schema',
  qualified: null,
};
const request = {
  allowPool: true,
  seedLogin: false,
  env: {},
  requireCredentials: false,
};
describe('adjudicator route eligibility', () => {
  it('selects only the exact direct route without changing its CLI identity', () => {
    expect(adjudicatorTransport(route, request)).toEqual({
      ok: true,
      value: 'adjudicator-responses',
    });
  });
  it.each<Partial<Route>>([
    { model: 'alias' },
    { model: 'gpt-6.1-sol-high' },
    { providerModel: 'gpt-5.6-luna' },
    { harness: 'claude', family: 'claude', providerModel: 'claude-haiku-4-5' },
    { effort: 'high' },
    { effort: 'minimal' },
    { harness: 'opencode' },
    { family: 'other' },
    { billing: 'paid-api' },
    { account: 'personal' },
    { account: 'work' },
    { login: true },
    { credentials: ['CODEX_OPENAI_API_KEY'] },
    { credentials: [] },
    { credentials: ['AGENT_CI_PROXY_API_KEY', 'CURSOR_API_KEY'] },
    { baseUrl: undefined },
    { baseUrl: 'http://127.0.0.1:8317' },
    { baseUrl: 'http://127.0.0.1:8317/v1?query=1' },
    { baseUrl: 'http://127.0.0.1:8317/v1/../v1' },
  ])('refuses direct substitution %j', (change) => {
    expect(adjudicatorTransport({ ...route, ...change }, request).ok).toBe(
      false,
    );
  });
  it('enforces pool opt-in, self-hosted CI, credentials and no seeded login independently', () => {
    for (const change of [
      { allowPool: false },
      { env: { CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted' } },
      { requireCredentials: true },
      { seedLogin: true },
    ])
      expect(adjudicatorTransport(route, { ...request, ...change }).ok).toBe(
        false,
      );
  });
});
