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

/**
 * Parse the override into an origin, or fail without echoing the value.
 *
 * The value must already be the canonical origin (`scheme://host[:port]`,
 * exactly as `URL.origin` prints it). The secret guard matches the raw
 * variable as a substring, so a value that normalizes to a different string
 * (case, a default port, whitespace, an encoded or expanded host) would let
 * the effective URL appear in output unmasked. Syntax is checked on the raw
 * text before parsing, because WHATWG parsing hides `/a/..`, `%2e%2e`,
 * backslashes and an empty `@`.
 */
function parseOrigin(value: string): Result<string> {
  if (value !== value.trim()) {
    return invalid('it must not have surrounding whitespace');
  }
  if (!/^[a-z]+:\/\/[^/\\?#@\s]+$/iu.test(value)) {
    if (value.includes('@')) {
      return invalid('it must not contain a username or password');
    }
    if (value.includes('?')) return invalid('it must not contain a query');
    if (value.includes('#')) return invalid('it must not contain a fragment');
    if (/^[a-z]+:\/\/[^/\\]+[/\\]/iu.test(value)) {
      return invalid('it must not contain a path or a trailing slash');
    }
    return invalid('it is not an absolute URL origin');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('it is not an absolute URL origin');
  }
  if (url.protocol !== 'https:') {
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
      return invalid('it must use https (http only for a loopback host)');
    }
  }
  if (url.origin !== value) {
    return invalid(
      'it must be written as its canonical origin (lowercase, no default port, no encoded host)',
    );
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
  const value = env[PROXY_BASE_URL_ENV] ?? '';
  if (value.trim() === '') return success(route);
  const origin = parseOrigin(value);
  if (!origin.ok) return origin;
  const routePath = new URL(route.baseUrl).pathname;
  return success({
    ...route,
    baseUrl: `${origin.value}${routePath === '/' ? '' : routePath}`,
  });
}
