import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnHarness } from '@agent-ci/harness/spawn.js';
import { failure, success, type Result } from '@agent-ci/result.js';
import type { HarnessId } from '@agent-ci/routing/schema.js';

/**
 * Pinned harness CLI installs for CI runners. Versions are the ones
 * qualified locally (p01/p02 live probes); bump them deliberately. The
 * Cursor agent ships as a tarball (the same URL its install script uses),
 * which is downloaded and extracted without running a remote script.
 */
export type InstallableHarness = Exclude<HarnessId, 'fake'>;

export type InstallSpec =
  | {
      readonly kind: 'npm';
      readonly package: string;
      readonly version: string;
      readonly bin: string;
    }
  | {
      readonly kind: 'cursor-tarball';
      readonly version: string;
      readonly bin: string;
    };

export const HARNESS_INSTALLS: Readonly<
  Record<InstallableHarness, InstallSpec>
> = {
  claude: {
    kind: 'npm',
    package: '@anthropic-ai/claude-code',
    version: '2.1.310',
    bin: 'claude',
  },
  codex: {
    kind: 'npm',
    package: '@openai/codex',
    version: '0.163.0',
    bin: 'codex',
  },
  // OpenCode 2 is published as @opencode/cli; `opencode-ai` is OpenCode 1.
  opencode: {
    kind: 'npm',
    package: '@opencode/cli',
    version: '2.0.27',
    bin: 'opencode',
  },
  cursor: {
    kind: 'cursor-tarball',
    version: '2026.10.22-27dcf5f',
    bin: 'agent',
  },
};

export function cursorTarballUrl(
  version: string,
  platform: string,
  arch: string,
): Result<string> {
  const system = { linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = { x64: 'x64', arm64: 'arm64' }[arch];
  if (system === undefined || cpu === undefined) {
    return failure(
      'E_INVALID_INPUT',
      `the Cursor agent has no build for ${platform}/${arch}`,
    );
  }
  return success(
    `https://downloads.cursor.com/lab/${version}/${system}/${cpu}/agent-cli-package.tar.gz`,
  );
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one process with stdin closed; never throws for a non-zero exit. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  },
) => Promise<ProcessResult>;

export const defaultProcessRunner: ProcessRunner = async (
  command,
  args,
  options,
) => {
  const result = await spawnHarness({ command, args, ...options });
  if (!result.started) {
    return { exitCode: null, stdout: '', stderr: result.message };
  }
  return {
    exitCode: result.timedOut ? null : result.exitCode,
    stdout: result.stdout,
    stderr: result.timedOut ? `timed out\n${result.stderr}` : result.stderr,
  };
};

export interface InstallDeps {
  readonly run?: ProcessRunner;
  readonly fetch?: typeof fetch;
  readonly platform?: string;
  readonly arch?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface InstalledHarness {
  readonly harness: HarnessId;
  readonly version: string;
  readonly command: string;
  /** First line of `<bin> --version`. */
  readonly reported: string;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 60_000;

const lastLine = (text: string) =>
  text.trim().split('\n').slice(-3).join(' | ').slice(0, 300);

/** Install one pinned harness into `<prefix>/bin` and check `--version`. */
export async function installHarness(
  harness: HarnessId,
  prefix: string,
  deps: InstallDeps = {},
): Promise<Result<InstalledHarness>> {
  if (harness === 'fake') {
    return success({
      harness,
      version: 'built-in',
      command: process.execPath,
      reported: 'built-in fake harness',
    });
  }
  const run = deps.run ?? defaultProcessRunner;
  const parentPath = deps.env?.PATH ?? process.env.PATH ?? '/usr/bin:/bin';
  const binDir = path.join(prefix, 'bin');
  const env = { PATH: `${binDir}${path.delimiter}${parentPath}` };
  await mkdir(binDir, { recursive: true });
  const spec = HARNESS_INSTALLS[harness];
  if (spec.kind === 'npm') {
    const installed = await run(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        `${spec.package}@${spec.version}`,
      ],
      {
        cwd: prefix,
        env: { ...env, HOME: deps.env?.HOME ?? os.homedir() },
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    if (installed.exitCode !== 0) {
      return failure(
        'E_HARNESS_NOT_FOUND',
        `npm install ${spec.package}@${spec.version} failed: ${lastLine(installed.stderr)}`,
      );
    }
  } else {
    const url = cursorTarballUrl(
      spec.version,
      deps.platform ?? process.platform,
      deps.arch ?? process.arch,
    );
    if (!url.ok) return url;
    const doFetch = deps.fetch ?? fetch;
    let body: ArrayBuffer;
    try {
      const response = await doFetch(url.value);
      if (!response.ok) {
        return failure(
          'E_HARNESS_NOT_FOUND',
          `downloading the Cursor agent failed with HTTP ${response.status}`,
        );
      }
      body = await response.arrayBuffer();
    } catch (err) {
      return failure(
        'E_HARNESS_NOT_FOUND',
        `downloading the Cursor agent failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const archive = path.join(prefix, `cursor-agent-${spec.version}.tar.gz`);
    const target = path.join(prefix, 'cursor-agent', spec.version);
    await writeFile(archive, Buffer.from(body));
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const extracted = await run(
      'tar',
      ['--strip-components=1', '-xzf', archive, '-C', target],
      { cwd: prefix, env, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    await rm(archive, { force: true });
    if (extracted.exitCode !== 0) {
      return failure(
        'E_HARNESS_NOT_FOUND',
        `extracting the Cursor agent failed: ${lastLine(extracted.stderr)}`,
      );
    }
    const link = path.join(binDir, spec.bin);
    await rm(link, { force: true });
    await symlink(path.join(target, 'cursor-agent'), link);
  }
  const command = path.join(binDir, spec.bin);
  // A throwaway HOME: `--version` must not touch the runner's real config.
  const scratchHome = await mkdtemp(
    path.join(os.tmpdir(), 'agent-ci-version-'),
  );
  try {
    const version = await run(command, ['--version'], {
      cwd: scratchHome,
      env: { ...env, HOME: scratchHome },
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    if (version.exitCode !== 0) {
      return failure(
        'E_HARNESS_NOT_FOUND',
        `${command} --version failed: ${lastLine(version.stderr || version.stdout)}`,
      );
    }
    return success({
      harness,
      version: spec.version,
      command,
      reported: version.stdout.trim().split('\n')[0] ?? '',
    });
  } finally {
    await rm(scratchHome, { recursive: true, force: true });
  }
}

export interface SandboxCheck {
  readonly name: 'read' | 'write-denied' | 'workspace-write';
  readonly expected: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly detail: string;
}

/**
 * Codex sandbox smoke check on this host (credential-free, no model): a
 * command runs under the default read-only sandbox, a write in the workspace
 * is denied there, and the same write is allowed in workspace-write mode.
 */
export async function codexSandboxSmoke(
  command: string,
  deps: { readonly run?: ProcessRunner; readonly path?: string } = {},
): Promise<readonly SandboxCheck[]> {
  const run = deps.run ?? defaultProcessRunner;
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-sandbox-'));
  const workspace = path.join(root, 'ws');
  const codexHome = path.join(root, 'codex-home');
  await mkdir(workspace);
  await mkdir(codexHome);
  const env = {
    PATH: deps.path ?? process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    CODEX_HOME: codexHome,
  };
  const exists = async (file: string) => {
    try {
      await lstat(path.join(workspace, file));
      return true;
    } catch {
      return false;
    }
  };
  const sandbox = (extra: readonly string[], script: string) =>
    run(command, ['sandbox', ...extra, '--', 'sh', '-c', script], {
      cwd: workspace,
      env,
      timeoutMs: 60_000,
    });
  const detail = (result: ProcessResult) =>
    lastLine(`${result.stdout}\n${result.stderr}`);
  try {
    const read = await sandbox([], 'echo agent-ci-sandbox-ok');
    const denied = await sandbox([], 'echo x > probe-default.txt');
    const allowed = await sandbox(
      ['-c', 'sandbox_mode="workspace-write"'],
      'echo x > probe-workspace.txt',
    );
    return [
      {
        name: 'read',
        expected: 'exit 0 and the marker on stdout',
        passed:
          read.exitCode === 0 && read.stdout.includes('agent-ci-sandbox-ok'),
        exitCode: read.exitCode,
        detail: detail(read),
      },
      {
        name: 'write-denied',
        expected: 'non-zero exit and no file (default read-only sandbox)',
        passed: denied.exitCode !== 0 && !(await exists('probe-default.txt')),
        exitCode: denied.exitCode,
        detail: detail(denied),
      },
      {
        name: 'workspace-write',
        expected: 'exit 0 and the file written (workspace-write sandbox)',
        passed: allowed.exitCode === 0 && (await exists('probe-workspace.txt')),
        exitCode: allowed.exitCode,
        detail: detail(allowed),
      },
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
