import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_CREDENTIAL_ENV } from '@agent-ci/contracts/secret-guard.js';
import { createHomeRoot } from '@agent-ci/harness/home.js';
import { type HarnessRun, runHarness } from '@agent-ci/harness/run.js';
import type {
  HarnessAdapter,
  HarnessRequest,
} from '@agent-ci/harness/types.js';
import type { Route } from '@agent-ci/routing/schema.js';

/**
 * Test support for adapter suites: run an adapter against the replay CLI,
 * which plays back recorded probe output and records the invocation.
 * Excluded from the build (see tsconfig.build.json).
 */

const REPLAY_CLI = fileURLToPath(new URL('./replay-cli.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Synthetic value for every known credential variable (never real). */
export function syntheticCredentialEnv(): Record<string, string> {
  return Object.fromEntries(
    KNOWN_CREDENTIAL_ENV.map((name) => [
      name,
      `synthetic-${name.toLowerCase()}`,
    ]),
  );
}

export async function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), 'utf8');
}

export interface ReplayControl {
  readonly mode?: 'replay' | 'hang' | 'flood';
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly writeArgFile?: { readonly flag: string; readonly content: string };
  /** Create a symlink to `target` at the path that follows `flag`. */
  readonly linkArgFile?: { readonly flag: string; readonly target: string };
}

export interface Observed {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly stdinDevNull: boolean;
  readonly grandchildPid?: number;
}

export async function makeRequest(
  route: Route,
  overrides: Partial<HarnessRequest> = {},
): Promise<HarnessRequest> {
  const home = await createHomeRoot();
  if (!home.ok) throw new Error(home.message);
  return {
    route,
    prompt: 'Reply with exactly: agent-ci-probe-ok',
    cwd: process.cwd(),
    mode: 'read-only',
    home: home.value,
    scratchDir: await mkdtemp(path.join(os.tmpdir(), 'agent-ci-scratch-')),
    parentEnv: {
      ...syntheticCredentialEnv(),
      PATH: process.env.PATH,
      LANG: 'en_US.UTF-8',
      HOME: '/Users/operator',
      CODEX_HOME: '/Users/operator/.codex',
      CLAUDE_CONFIG_DIR: '/Users/operator/.claude',
      XDG_CONFIG_HOME: '/Users/operator/.config',
      GITHUB_TOKEN: 'synthetic-github-token-placeholder',
    },
    ...overrides,
  };
}

export async function replay(
  adapter: HarnessAdapter,
  request: HarnessRequest,
  control: ReplayControl,
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ run: HarnessRun; observed: Observed }> {
  const controlPath = path.join(request.scratchDir, 'replay-control.json');
  const observedPath = path.join(request.scratchDir, 'replay-observed.json');
  await writeFile(controlPath, JSON.stringify({ ...control, observedPath }));
  const run = await runHarness(
    adapter,
    request,
    {
      timeoutMs: limits.timeoutMs ?? 20_000,
      ...(limits.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: limits.maxOutputBytes }),
    },
    {
      commandOverride: {
        command: process.execPath,
        prefixArgs: [REPLAY_CLI, controlPath],
      },
    },
  );
  const observed = JSON.parse(await readFile(observedPath, 'utf8')) as Observed;
  return { run, observed };
}

/** Env names the child saw, minus OS noise. */
export function envNames(observed: Observed): string[] {
  return Object.keys(observed.env)
    .filter((name) => name !== '__CF_USER_TEXT_ENCODING')
    .toSorted();
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
