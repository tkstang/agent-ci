import { failure, success, type Result } from '@agent-ci/result.js';
import {
  checkEligibility,
  checkRoutePolicy,
  type EligibilityRequest,
} from '@agent-ci/routing/policy.js';
import type { Route } from '@agent-ci/routing/schema.js';

/** A purpose-specific transport, never a new harness or CLI capability. */
export type AdjudicatorTransport = 'harness' | 'adjudicator-responses';

/** Shared by planning, route outputs and execution; never includes the endpoint. */
export function adjudicatorTransport(
  route: Route,
  request: EligibilityRequest,
): Result<AdjudicatorTransport> {
  const policy = checkRoutePolicy(route);
  if (!policy.ok) return policy;
  const eligible = checkEligibility(route, request);
  if (!eligible.ok) return eligible;
  if (
    route.model !== 'gpt-6.1-sol-low' &&
    (route.harness === 'claude' || route.harness === 'fake')
  )
    return success('harness');
  let endpoint = false;
  try {
    const url = new URL(route.baseUrl ?? '');
    endpoint =
      route.baseUrl === `${url.origin}/v1` &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)));
  } catch {
    // Refuse without exposing the configured endpoint.
  }
  if (
    route.model === 'gpt-6.1-sol-low' &&
    route.providerModel === 'gpt-6.1-sol' &&
    route.effort === 'low' &&
    route.harness === 'codex' &&
    route.family === 'openai' &&
    route.account === 'pool' &&
    route.billing === 'subscription' &&
    !route.login &&
    !request.seedLogin &&
    route.credentials.length === 1 &&
    route.credentials[0] === 'AGENT_CI_PROXY_API_KEY' &&
    endpoint
  )
    return success('adjudicator-responses');
  return failure(
    'E_POLICY_HARNESS',
    'the adjudicator requires a tool-free Claude/fake harness or the exact Sol 6.1 Low subscription pool route',
  );
}
