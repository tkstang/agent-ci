import path from 'node:path';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import { runUrlFromEnv } from '@agent-ci/commands/publish.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { notify } from '@agent-ci/publish/notify.js';
import { readRunOutputs } from '@agent-ci/publish/publish.js';

const USAGE = `agent-ci notify — post a one-line run notification to a webhook.

Flags:
  --result-dir <dir>      Canonical result directory (required).
  --webhook-env <NAME>    Variable holding the https webhook URL
                          (default AGENT_CI_NOTIFY_WEBHOOK). Unset or empty:
                          nothing is sent.
  --pr-url <url>          Pull request to link (optional).
  --run-url <url>         Default: built from the GITHUB_* run variables.
  --result-digest <hex>   Refuse the directory unless its content digest matches.`;

export function createNotifyCommand(
  deps: { readonly fetch?: typeof fetch } = {},
): CommandSpec {
  return {
    name: 'notify',
    summary: 'Send an optional webhook notification for a run',
    usage: USAGE,
    async run(argv, context) {
      const flags = parseFlags(
        argv,
        {
          'result-dir': { type: 'string' },
          'webhook-env': { type: 'string' },
          'pr-url': { type: 'string' },
          'run-url': { type: 'string' },
          'result-digest': { type: 'string' },
        },
        USAGE,
      );
      const name = flags['webhook-env'] ?? 'AGENT_CI_NOTIFY_WEBHOOK';
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
        throw new CliError(
          'E_INVALID_INPUT',
          '--webhook-env must be a variable name',
        );
      }
      const outputs = await readRunOutputs(
        path.resolve(
          context.cwd,
          required(flags['result-dir'], '--result-dir'),
        ),
        flags['result-digest'] === undefined || flags['result-digest'] === ''
          ? {}
          : { digest: flags['result-digest'] },
      );
      if (!outputs.ok) throw CliError.fromFailure(outputs);
      const sent = await notify({
        webhookUrl: context.env[name],
        result: outputs.value.result,
        repo: context.env.GITHUB_REPOSITORY,
        pullUrl: flags['pr-url'] === '' ? undefined : flags['pr-url'],
        runUrl: flags['run-url'] ?? runUrlFromEnv(context.env),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      });
      if (!sent.ok) throw CliError.fromFailure(sent);
      return sent.value;
    },
  };
}

export const notifyCommand = createNotifyCommand();
