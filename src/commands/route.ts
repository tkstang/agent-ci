import path from 'node:path';

import { oneOf, optional, parseFlags } from '@agent-ci/commands/flags.js';
import { appendGithubOutput } from '@agent-ci/commands/github.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { loadModelsFile, resolveRoute } from '@agent-ci/routing/resolve.js';
import { HARNESS_IDS } from '@agent-ci/routing/schema.js';

const USAGE = `agent-ci route — resolve the route a run would use, without running it.

Applies the routing policy for this environment (pool and login routes are
refused when CI or GITHUB_ACTIONS is set) but does not require the route's
credential to be present: a workflow resolves the route first, then passes
only that credential to the agent step.

Flags:
  --model <key> | --route <id>   What to resolve (one required).
  --harness <id>                 Pin a harness.
  --allow-pool                   Allow a local proxy-pool route (refused in CI).
  --models <path>                Routing table (default: packaged models.yaml).
  --github-output                Also write route_id, model, harness, account,
                                 billing and credential (the single credential
                                 variable name, empty for none) to
                                 $GITHUB_OUTPUT. Refuses a route that names
                                 more than one credential.`;

export const routeCommand: CommandSpec = {
  name: 'route',
  summary: 'Resolve a model to its route under the current policy',
  usage: USAGE,
  async run(argv, context) {
    const parsed = parseFlags(
      argv,
      {
        model: { type: 'string' },
        route: { type: 'string' },
        harness: { type: 'string' },
        'allow-pool': { type: 'boolean' },
        models: { type: 'string' },
        'github-output': { type: 'boolean' },
      },
      USAGE,
    );
    // Empty values (unset workflow inputs) behave like absent flags.
    const flags = {
      ...parsed,
      model: optional(parsed.model),
      route: optional(parsed.route),
      harness: optional(parsed.harness),
    };
    if (flags.model === undefined && flags.route === undefined) {
      throw new CliError('E_INVALID_INPUT', 'pass --model or --route');
    }
    const modelsPath =
      flags.models === undefined
        ? DEFAULT_MODELS_PATH
        : path.resolve(context.cwd, flags.models);
    const models = await loadModelsFile(modelsPath);
    if (!models.ok) throw CliError.fromFailure(models);
    const resolved = resolveRoute(models.value, {
      model: flags.model,
      routeId: flags.route,
      harness: oneOf(flags.harness, '--harness', HARNESS_IDS),
      allowPool: flags['allow-pool'] === true,
      seedLogin: false,
      requireCredentials: false,
      env: context.env,
    });
    if (!resolved.ok) throw CliError.fromFailure(resolved);
    const { route } = resolved.value;
    if (flags['github-output'] === true) {
      if (route.credentials.length > 1) {
        throw new CliError(
          'E_ROUTE_CONFIG',
          `route ${route.id} names ${route.credentials.length} credentials; a workflow passes exactly one`,
        );
      }
      await appendGithubOutput(context.env, {
        route_id: route.id,
        model: route.model,
        harness: route.harness,
        account: route.account,
        billing: route.billing,
        credential: route.credentials[0] ?? '',
      });
    }
    return {
      route: {
        id: route.id,
        model: route.model,
        harness: route.harness,
        providerModel: route.providerModel,
        billing: route.billing,
        account: route.account,
        credentials: route.credentials,
        login: route.login,
        qualified: route.qualified,
      },
      selectedBy: resolved.value.selectedBy,
      skipped: resolved.value.skipped,
    };
  },
};
