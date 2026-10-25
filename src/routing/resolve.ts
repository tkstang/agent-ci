import { readFile } from 'node:fs/promises';

import { failure, success, type Result } from '@agent-ci/result.js';
import {
  checkEligibility,
  checkRoutePolicy,
  type EligibilityRequest,
  isClaudeModel,
} from '@agent-ci/routing/policy.js';
import {
  type HarnessId,
  type ModelsFile,
  ModelsFileSchema,
  type Route,
} from '@agent-ci/routing/schema.js';
import { parse as parseYaml } from 'yaml';

/** Parse and policy-check a models.yaml document. */
export function parseModelsFile(text: string): Result<ModelsFile> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return failure(
      'E_ROUTE_CONFIG',
      `models file is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = ModelsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.')}`;
    return failure(
      'E_ROUTE_CONFIG',
      `models file failed validation${where}: ${issue?.message ?? 'unknown error'}`,
    );
  }
  const seen = new Set<string>();
  for (const route of parsed.data.routes) {
    if (seen.has(route.id)) {
      return failure('E_ROUTE_CONFIG', `duplicate route id ${route.id}`);
    }
    seen.add(route.id);
    const checked = checkRoutePolicy(route);
    if (!checked.ok) return checked;
  }
  return success(parsed.data);
}

/** Read and parse a models.yaml file. */
export async function loadModelsFile(
  path: string,
): Promise<Result<ModelsFile>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return failure(
      'E_ROUTE_CONFIG',
      `could not read models file: ${path}`,
      'Pass --models <path> or run from the agent-ci package.',
    );
  }
  return parseModelsFile(text);
}

export interface ResolveRequest extends EligibilityRequest {
  readonly model?: string | undefined;
  readonly harness?: HarnessId | undefined;
  readonly routeId?: string | undefined;
}

export interface SkippedRoute {
  readonly id: string;
  readonly code: string;
}

export interface ResolvedRoute {
  readonly route: Route;
  readonly selectedBy: 'route-id' | 'model';
  /** Earlier candidates that were not eligible, in order. */
  readonly skipped: readonly SkippedRoute[];
}

function resolveById(
  file: ModelsFile,
  request: ResolveRequest,
  routeId: string,
): Result<ResolvedRoute> {
  const route = file.routes.find((candidate) => candidate.id === routeId);
  if (route === undefined) {
    return failure('E_ROUTE_NOT_FOUND', `no route with id ${routeId}`);
  }
  if (request.model !== undefined && route.model !== request.model) {
    return failure(
      'E_INVALID_INPUT',
      `route ${routeId} serves ${route.model}, not ${request.model}`,
    );
  }
  if (request.harness !== undefined && route.harness !== request.harness) {
    return failure(
      isClaudeModel(route) ? 'E_POLICY_HARNESS' : 'E_INVALID_INPUT',
      `route ${routeId} runs on ${route.harness}, not ${request.harness}`,
    );
  }
  const eligible = checkEligibility(route, request);
  if (!eligible.ok) return eligible;
  return success({ route, selectedBy: 'route-id', skipped: [] });
}

/**
 * Resolve a model (and optional harness pin) to one route. Candidates are
 * tried in file order; ineligible ones are skipped, but resolution never
 * falls back from a subscription route to a paid-api route, and never falls
 * back into a work account. An explicit `--route` is the only way to pick
 * such a route.
 */
export function resolveRoute(
  file: ModelsFile,
  request: ResolveRequest,
): Result<ResolvedRoute> {
  if (request.routeId !== undefined) {
    return resolveById(file, request, request.routeId);
  }
  if (request.model === undefined) {
    return failure('E_INVALID_INPUT', 'a model or a route id is required');
  }
  const forModel = file.routes.filter((route) => route.model === request.model);
  if (forModel.length === 0) {
    return failure(
      'E_ROUTE_NOT_FOUND',
      `no qualified route for model ${request.model}`,
      'Run agent-ci models to list qualified models.',
    );
  }
  const candidates = forModel.filter(
    (route) =>
      request.harness === undefined || route.harness === request.harness,
  );
  if (candidates.length === 0) {
    const claude = forModel.some(isClaudeModel);
    return failure(
      claude ? 'E_POLICY_HARNESS' : 'E_ROUTE_NOT_FOUND',
      claude
        ? `Claude model ${request.model} runs only in the claude harness`
        : `model ${request.model} has no route on harness ${request.harness}`,
    );
  }

  const skipped: { route: Route; code: string }[] = [];
  let firstFailure: Result<never> | undefined;
  for (const route of candidates) {
    const eligible = checkEligibility(route, request);
    if (!eligible.ok) {
      skipped.push({ route, code: eligible.code });
      firstFailure ??= eligible;
      continue;
    }
    if (
      route.billing === 'paid-api' &&
      skipped.some((entry) => entry.route.billing === 'subscription')
    ) {
      return failure(
        'E_POLICY_FALLBACK',
        `refusing to fall back from subscription route ${skipped.find((entry) => entry.route.billing === 'subscription')?.route.id} to paid route ${route.id}`,
        `Fix the subscription route, or select the paid route explicitly with --route ${route.id}.`,
      );
    }
    if (
      route.account === 'work' &&
      skipped.some((entry) => entry.route.account !== 'work')
    ) {
      return failure(
        'E_POLICY_ACCOUNT_FALLBACK',
        `refusing to fall back into work-account route ${route.id}`,
        `Pin it with --harness ${route.harness} or --route ${route.id} if the work account is intended.`,
      );
    }
    return success({
      route,
      selectedBy: 'model',
      skipped: skipped.map((entry) => ({
        id: entry.route.id,
        code: entry.code,
      })),
    });
  }
  return firstFailure ?? failure('E_ROUTE_NOT_FOUND', 'no eligible route');
}
