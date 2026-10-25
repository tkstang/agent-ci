import { rm } from 'node:fs/promises';
import path from 'node:path';

import { parseFlags } from '@agent-ci/commands/flags.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { KNOWN_CREDENTIAL_ENV } from '@agent-ci/contracts/secret-guard.js';
import { CliError } from '@agent-ci/errors.js';
import { ADAPTERS } from '@agent-ci/harness/adapters/registry.js';
import { createHomeRoot } from '@agent-ci/harness/home.js';
import { spawnHarness } from '@agent-ci/harness/spawn.js';
import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { checkEligibility, isCiEnvironment } from '@agent-ci/routing/policy.js';
import { loadModelsFile } from '@agent-ci/routing/resolve.js';
import { HARNESS_IDS, type HarnessId } from '@agent-ci/routing/schema.js';

const USAGE = `agent-ci doctor — report harness CLIs and credential presence.

Never prints a credential value: credentials are reported as present or
absent by variable name only.

Flags:
  --models <path>   Routing table (default: the packaged models.yaml).
  --allow-pool      Evaluate pool routes as if --allow-pool were passed.
  --seed-login      Evaluate login routes as if --seed-login were passed.`;

export interface VersionProbe {
  (harness: HarnessId): Promise<{ found: boolean; version: string | null }>;
}

/** Run `<cli> --version` in an empty temp home with stdin closed. */
export const probeVersion: VersionProbe = async (harness) => {
  const adapter = ADAPTERS[harness];
  const home = await createHomeRoot();
  if (!home.ok) return { found: false, version: null };
  try {
    const command =
      harness === 'fake' ? process.execPath : adapter.defaultCommand;
    const result = await spawnHarness({
      command,
      args: [...adapter.versionArgs],
      cwd: home.value.home,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...home.value.env },
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    if (!result.started) return { found: false, version: null };
    const firstLine = result.stdout.trim().split('\n')[0] ?? '';
    return {
      found: true,
      version: result.exitCode === 0 && firstLine !== '' ? firstLine : null,
    };
  } finally {
    await rm(home.value.root, { recursive: true, force: true });
  }
};

const present = (value: string | undefined) =>
  value !== undefined && value !== '';

export function createDoctorCommand(probe: VersionProbe): CommandSpec {
  return {
    name: 'doctor',
    summary: 'Report harness CLIs and credential presence (never values)',
    usage: USAGE,
    async run(argv, context) {
      const flags = parseFlags(
        argv,
        {
          models: { type: 'string' },
          'allow-pool': { type: 'boolean' },
          'seed-login': { type: 'boolean' },
        },
        USAGE,
      );
      const modelsPath =
        flags.models === undefined
          ? DEFAULT_MODELS_PATH
          : path.resolve(context.cwd, flags.models);
      const loaded = await loadModelsFile(modelsPath);
      if (!loaded.ok) throw CliError.fromFailure(loaded);

      const harnesses = await Promise.all(
        HARNESS_IDS.map(async (id) => ({
          id,
          command:
            id === 'fake' ? 'node (built-in)' : ADAPTERS[id].defaultCommand,
          ...(await probe(id)),
        })),
      );
      const routes = loaded.value.routes.map((route) => {
        const eligible = checkEligibility(route, {
          allowPool: flags['allow-pool'] === true,
          seedLogin: flags['seed-login'] === true,
          env: context.env,
        });
        return {
          id: route.id,
          model: route.model,
          harness: route.harness,
          account: route.account,
          billing: route.billing,
          login: route.login,
          credentials: route.credentials.map((name) => ({
            name,
            present: present(context.env[name]),
          })),
          usable: eligible.ok,
          ...(eligible.ok ? {} : { blockedBy: eligible.code }),
        };
      });
      return {
        modelsPath,
        ci: isCiEnvironment(context.env),
        harnesses,
        credentialEnv: KNOWN_CREDENTIAL_ENV.map((name) => ({
          name,
          present: present(context.env[name]),
        })),
        routes,
      };
    },
  };
}

export const doctorCommand = createDoctorCommand(probeVersion);
