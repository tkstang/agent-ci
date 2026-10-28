import { failure, success, type Result } from '@agent-ci/result.js';
import type { Route } from '@agent-ci/routing/schema.js';

/**
 * Optional override for the proxy-pool origin. When set and non-empty, every
 * `account: pool` route with a `baseUrl` is served from this origin instead
 * of the loopback default, keeping the route's own path (`/v1` for Codex).
 * The value is a private endpoint: it is guarded as a secret
 * (`KNOWN_CREDENTIAL_ENV`) and never appears in an error message.
 */
export const PROXY_BASE_URL_ENV = 'AGENT_CI_PROXY_BASE_URL';

/** Hosts for which a plain `http:` origin is accepted. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function invalid(rule: string): Result<never> {
  return failure(
    'E_ROUTE_CONFIG',
    `${PROXY_BASE_URL_ENV} is invalid: ${rule}`,
    `Set ${PROXY_BASE_URL_ENV} to an origin only, for example https://proxy.example.com, or leave it unset for the loopback default.`,
  );
}

/** Parse the override into an origin, or fail without echoing the value. */
function parseOrigin(value: string): Result<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('it is not an absolute URL');
  }
  if (url.protocol !== 'https:') {
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
      return invalid('it must use https (http only for a loopback host)');
    }
  }
  if (url.username !== '' || url.password !== '') {
    return invalid('it must not contain a username or password');
  }
  if (url.search !== '' || value.includes('?')) {
    return invalid('it must not contain a query');
  }
  if (url.hash !== '' || value.includes('#')) {
    return invalid('it must not contain a fragment');
  }
  if (url.pathname !== '/') {
    return invalid('it must not contain a path');
  }
  return success(url.origin);
}

/**
 * Apply the override to a resolved route. Non-pool routes, pool routes
 * without a `baseUrl`, and an unset or empty variable leave it unchanged.
 */
export function applyProxyOrigin(
  route: Route,
  env: Readonly<Record<string, string | undefined>>,
): Result<Route> {
  if (route.account !== 'pool' || route.baseUrl === undefined) {
    return success(route);
  }
  const value = env[PROXY_BASE_URL_ENV]?.trim() ?? '';
  if (value === '') return success(route);
  const origin = parseOrigin(value);
  if (!origin.ok) return origin;
  const routePath = new URL(route.baseUrl).pathname;
  return success({
    ...route,
    baseUrl: `${origin.value}${routePath === '/' ? '' : routePath}`,
  });
}
