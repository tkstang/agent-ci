import { failure, success, type Result } from '@agent-ci/result.js';
import type { Route } from '@agent-ci/routing/schema.js';

/**
 * Routing policy. The local proxy cannot enforce per-key rules, so agent-ci
 * enforces them at load time (routes) and at resolution time (requests):
 *
 * - Claude models run only in the Claude Code harness.
 * - No automatic fallback from a subscription route to paid API billing.
 * - No automatic fallback into a work account.
 * - `pool` routes need an explicit opt-in and are refused under CI.
 * - Login-seeded routes are local only.
 */

/** API-key variables that are always metered (paid) billing. */
export const PAID_API_CREDENTIALS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_OPENAI_API_KEY',
];

/** Claude-looking model names, including Cursor's `sonnet`/`opus`/`haiku` IDs. */
const CLAUDE_NAME = /claude|anthropic|\bsonnet\b|\bopus\b|\bhaiku\b/iu;

/**
 * True for a Claude route: declared `family: claude`, or (defense in depth) a
 * model key or provider ID that looks like a Claude model.
 */
export function isClaudeModel(
  route: Pick<Route, 'model' | 'providerModel'> & { family?: Route['family'] },
): boolean {
  return (
    route.family === 'claude' ||
    CLAUDE_NAME.test(`${route.model} ${route.providerModel}`)
  );
}

/** True when the environment says this is a CI run. */
export function isCiEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return ['CI', 'GITHUB_ACTIONS'].some((name) => {
    const value = env[name];
    return value !== undefined && value !== '';
  });
}

/** Load-time checks for one route. */
export function checkRoutePolicy(route: Route): Result<Route> {
  if (isClaudeModel(route) && route.harness !== 'claude') {
    return failure(
      'E_POLICY_HARNESS',
      `route ${route.id}: Claude models run only in the claude harness`,
    );
  }
  if (route.harness === 'claude' && route.family !== 'claude') {
    return failure(
      'E_ROUTE_CONFIG',
      `route ${route.id}: the claude harness serves only family "claude"`,
    );
  }
  if ((route.harness === 'fake') !== (route.family === 'fake')) {
    return failure(
      'E_ROUTE_CONFIG',
      `route ${route.id}: family "fake" is reserved for the fake harness`,
    );
  }
  if (route.billing === 'subscription') {
    const paid = route.credentials.filter((name) =>
      PAID_API_CREDENTIALS.includes(name),
    );
    if (paid.length > 0) {
      return failure(
        'E_POLICY_CREDENTIAL',
        `route ${route.id}: a subscription route cannot name paid API credential ${paid.join(', ')}`,
        'Declare a separate paid-api route; it is selectable only with --route.',
      );
    }
  }
  if ((route.harness === 'fake') !== (route.billing === 'none')) {
    return failure(
      'E_ROUTE_CONFIG',
      `route ${route.id}: billing "none" is reserved for the fake harness`,
    );
  }
  if (
    route.harness !== 'fake' &&
    route.credentials.length === 0 &&
    !route.login
  ) {
    return failure(
      'E_ROUTE_CONFIG',
      `route ${route.id}: declares no credential and no login`,
    );
  }
  return success(route);
}

export interface EligibilityRequest {
  readonly allowPool: boolean;
  readonly seedLogin: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Request-time checks: may this run use this route right now? */
export function checkEligibility(
  route: Route,
  request: EligibilityRequest,
): Result<Route> {
  const ci = isCiEnvironment(request.env);
  if (route.account === 'pool') {
    if (ci) {
      return failure(
        'E_POLICY_POOL_CI',
        `route ${route.id} spends the local proxy pool, which is refused when CI or GITHUB_ACTIONS is set`,
        'Use a personal route with its own credential in CI.',
      );
    }
    if (!request.allowPool) {
      return failure(
        'E_POLICY_POOL',
        `route ${route.id} spends the local proxy pool`,
        'Pass --allow-pool to opt in for this local run.',
      );
    }
  }
  if (route.login) {
    if (ci) {
      return failure(
        'E_POLICY_LOGIN_CI',
        `route ${route.id} needs a seeded harness login, which is refused in CI`,
      );
    }
    if (!request.seedLogin) {
      return failure(
        'E_CREDENTIAL_MISSING',
        `route ${route.id} authenticates through a seeded ${route.harness} login`,
        'Pass --seed-login to copy your existing login into the isolated home (local runs only).',
      );
    }
  }
  const missing = route.credentials.filter((name) => {
    const value = request.env[name];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    return failure(
      'E_CREDENTIAL_MISSING',
      `route ${route.id} needs ${missing.join(', ')}`,
      'Export the named variable(s) or choose another route with --route.',
    );
  }
  return success(route);
}
