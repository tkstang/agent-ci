import path from 'node:path';

import { parseFlags } from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { loadModelsFile } from '@agent-ci/routing/resolve.js';

const USAGE = `agent-ci models — list qualified routes from models.yaml.

Flags:
  --models <path>   Routing table (default: the packaged models.yaml).
  --model <key>     Only routes for this model.`;

export const modelsCommand: CommandSpec = {
  name: 'models',
  summary: 'List qualified models and their routes',
  usage: USAGE,
  async run(argv, context) {
    const flags = parseFlags(
      argv,
      { models: { type: 'string' }, model: { type: 'string' } },
      USAGE,
    );
    const modelsPath =
      flags.models === undefined
        ? DEFAULT_MODELS_PATH
        : path.resolve(context.cwd, flags.models);
    const loaded = await loadModelsFile(modelsPath);
    if (!loaded.ok) throw CliError.fromFailure(loaded);
    const routes = loaded.value.routes.filter(
      (route) => flags.model === undefined || route.model === flags.model,
    );
    return {
      modelsPath,
      models: [...new Set(routes.map((route) => route.model))],
      routes,
    };
  },
};
