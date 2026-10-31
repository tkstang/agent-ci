import { KNOWN_CREDENTIAL_ENV } from '@agent-ci/contracts/secret-guard.js';
import {
  BASE_ENV_ALLOWLIST,
  buildChildEnv,
  CredentialLeakError,
} from '@agent-ci/harness/env.js';
import { homeLayout } from '@agent-ci/harness/home.js';
import { describe, expect, it } from 'vitest';

// Every known credential set to a synthetic placeholder, plus an inherited
// config home and provider override that must not reach the child.
const parentEnv: Record<string, string> = {
  ...Object.fromEntries(
    KNOWN_CREDENTIAL_ENV.map((name) => [
      name,
      `synthetic-${name.toLowerCase()}`,
    ]),
  ),
  PATH: '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  HOME: '/Users/operator',
  CLAUDE_CONFIG_DIR: '/Users/operator/.claude',
  CODEX_HOME: '/Users/operator/.codex',
  XDG_CONFIG_HOME: '/Users/operator/.config',
  ANTHROPIC_BASE_URL: 'http://inherited.example',
  CLAUDE_CODE_USE_BEDROCK: '1',
  GITHUB_ACTIONS: 'true',
};
const home = homeLayout('/tmp/agent-ci-home-test');

describe('buildChildEnv', () => {
  it('keeps only allowlisted base variables, the route credential and the isolated home', () => {
    const env = buildChildEnv({
      parentEnv,
      route: { credentials: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      homeEnv: home.env,
    });
    const expected = new Set([
      ...BASE_ENV_ALLOWLIST.filter((name) => parentEnv[name] !== undefined),
      'CLAUDE_CODE_OAUTH_TOKEN',
      ...Object.keys(home.env),
    ]);
    expect(new Set(Object.keys(env))).toEqual(expected);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'synthetic-claude_code_oauth_token',
    );
  });

  it('drops every credential the route does not name, per billing class', () => {
    const cases: Record<string, string[]> = {
      subscription: ['CLAUDE_CODE_OAUTH_TOKEN'],
      'paid-api': ['ANTHROPIC_API_KEY'],
      pool: ['ANTHROPIC_AUTH_TOKEN'],
      none: [],
    };
    for (const credentials of Object.values(cases)) {
      const env = buildChildEnv({
        parentEnv,
        route: { credentials },
        homeEnv: home.env,
      });
      const visible = KNOWN_CREDENTIAL_ENV.filter((name) => name in env);
      expect(visible).toEqual(credentials);
    }
  });

  it('never carries the inherited config home or provider overrides', () => {
    const env = buildChildEnv({
      parentEnv,
      route: { credentials: [] },
      homeEnv: home.env,
    });
    expect(env.HOME).toBe('/tmp/agent-ci-home-test/home');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/agent-ci-home-test/home/.claude');
    expect(env.CODEX_HOME).toBe('/tmp/agent-ci-home-test/home/.codex');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/agent-ci-home-test/home/.config');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.GITHUB_ACTIONS).toBeUndefined();
  });

  it('applies non-secret settings but refuses a credential smuggled as a setting', () => {
    const env = buildChildEnv({
      parentEnv,
      route: { credentials: ['ANTHROPIC_AUTH_TOKEN'] },
      homeEnv: home.env,
      settings: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8317');
    expect(() =>
      buildChildEnv({
        parentEnv,
        route: { credentials: [] },
        homeEnv: home.env,
        settings: { OPENAI_API_KEY: 'x' },
      }),
    ).toThrow(CredentialLeakError);
  });

  it('skips a named credential that is empty in the parent', () => {
    const env = buildChildEnv({
      parentEnv: { ...parentEnv, CURSOR_API_KEY: '' },
      route: { credentials: ['CURSOR_API_KEY'] },
      homeEnv: home.env,
    });
    expect('CURSOR_API_KEY' in env).toBe(false);
  });
});
