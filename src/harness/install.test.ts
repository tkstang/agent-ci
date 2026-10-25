import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHarnessCommand } from '@agent-ci/commands/harness.js';
import {
  codexSandboxSmoke,
  cursorTarballUrl,
  installHarness,
  type ProcessRunner,
} from '@agent-ci/harness/install.js';
import { describe, expect, it } from 'vitest';

interface Call {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

function recorder(
  respond: (
    call: Call,
  ) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>,
): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (command, args, options) => {
    const call = { command, args, env: options.env };
    calls.push(call);
    const result = await respond(call);
    return { stdout: '', stderr: '', ...result };
  };
  return { run, calls };
}

const tmp = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));

describe('installHarness', () => {
  it('installs the pinned npm package into the prefix and checks --version with a scratch HOME', async () => {
    const prefix = await tmp('agent-ci-install-');
    const { run, calls } = recorder(async (call) =>
      call.command === 'npm'
        ? { exitCode: 0 }
        : { exitCode: 0, stdout: '2.1.310 (Claude Code)\n' },
    );
    const installed = await installHarness('claude', prefix, {
      run,
      env: { PATH: '/usr/bin', HOME: '/home/runner' },
    });
    expect(installed.ok && installed.value).toEqual({
      harness: 'claude',
      version: '2.1.310',
      command: path.join(prefix, 'bin', 'claude'),
      reported: '2.1.310 (Claude Code)',
    });
    expect(calls[0]?.args).toEqual([
      'install',
      '--global',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      '@anthropic-ai/claude-code@2.1.310',
    ]);
    expect(calls[1]?.command).toBe(path.join(prefix, 'bin', 'claude'));
    expect(calls[1]?.env.HOME).not.toBe('/home/runner');
    expect(calls[1]?.env.PATH?.startsWith(path.join(prefix, 'bin'))).toBe(true);
  });

  it('uses OpenCode 2 (@opencode/cli), not the OpenCode 1 package', async () => {
    const prefix = await tmp('agent-ci-install-');
    const { run, calls } = recorder(async () => ({
      exitCode: 0,
      stdout: '2.0.27',
    }));
    await installHarness('opencode', prefix, { run });
    expect(calls[0]?.args.at(-1)).toBe('@opencode/cli@2.0.27');
  });

  it('reports a failed install or version check as E_HARNESS_NOT_FOUND', async () => {
    const prefix = await tmp('agent-ci-install-');
    const npmFails = recorder(async () => ({ exitCode: 1, stderr: 'E404' }));
    const a = await installHarness('codex', prefix, { run: npmFails.run });
    expect(a.ok ? 'ok' : a.code).toBe('E_HARNESS_NOT_FOUND');
    const versionFails = recorder(async (call) => ({
      exitCode: call.command === 'npm' ? 0 : 127,
    }));
    const b = await installHarness('codex', prefix, { run: versionFails.run });
    expect(b.ok ? 'ok' : b.code).toBe('E_HARNESS_NOT_FOUND');
  });

  it('downloads and extracts the Cursor agent tarball and links agent', async () => {
    const prefix = await tmp('agent-ci-install-');
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const { run, calls } = recorder(async (call) => {
      if (call.command === 'tar') {
        const target = call.args[call.args.indexOf('-C') + 1] ?? '';
        await writeFile(path.join(target, 'cursor-agent'), '#!/bin/sh\n');
        return { exitCode: 0 };
      }
      return { exitCode: 0, stdout: '2026.10.22-27dcf5f\n' };
    });
    const installed = await installHarness('cursor', prefix, {
      run,
      fetch: fakeFetch,
      platform: 'linux',
      arch: 'x64',
    });
    expect(installed.ok).toBe(true);
    expect(fetched).toEqual([
      'https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/x64/agent-cli-package.tar.gz',
    ]);
    expect(calls[0]?.args.slice(0, 2)).toEqual([
      '--strip-components=1',
      '-xzf',
    ]);
    expect(await readlink(path.join(prefix, 'bin', 'agent'))).toBe(
      path.join(prefix, 'cursor-agent', '2026.10.22-27dcf5f', 'cursor-agent'),
    );
    // The downloaded archive is not left behind.
    await expect(
      lstat(path.join(prefix, 'cursor-agent-2026.10.22-27dcf5f.tar.gz')),
    ).rejects.toThrow();
  });

  it('refuses platforms without a Cursor build and needs nothing for the fake harness', async () => {
    expect(cursorTarballUrl('v', 'win32', 'x64').ok).toBe(false);
    const prefix = await tmp('agent-ci-install-');
    const { run, calls } = recorder(async () => ({ exitCode: 0 }));
    const fake = await installHarness('fake', prefix, { run });
    expect(fake.ok && fake.value.version).toBe('built-in');
    expect(calls).toEqual([]);
  });

  it('adds the bin directory to $GITHUB_PATH when asked', async () => {
    const prefix = await tmp('agent-ci-install-');
    const githubPath = path.join(prefix, 'github-path');
    await writeFile(githubPath, '');
    const { run } = recorder(async () => ({ exitCode: 0, stdout: 'v' }));
    const command = createHarnessCommand({ run });
    const data = (await command.run(
      [
        'install',
        '--harness',
        'codex,fake',
        '--prefix',
        prefix,
        '--github-path',
      ],
      { cwd: prefix, env: { GITHUB_PATH: githubPath }, log: () => undefined },
    )) as { binDir: string; installed: unknown[] };
    expect(data.installed).toHaveLength(2);
    expect(await readFile(githubPath, 'utf8')).toBe(
      `${path.join(prefix, 'bin')}\n`,
    );
  });
});

/** A stand-in `codex` that behaves like the sandbox (or does not). */
async function fakeCodex(enforces: boolean): Promise<string> {
  const dir = await tmp('agent-ci-fake-codex-');
  const bin = path.join(dir, 'codex');
  await writeFile(
    bin,
    `#!/bin/sh
# usage: codex sandbox [-c key=value] -- sh -c <script>
shift
mode=read-only
if [ "$1" = "-c" ]; then mode=workspace-write; shift 2; fi
shift
script="$3"
case "$script" in
  *">"*) if [ "${enforces ? 'yes' : 'no'}" = yes ] && [ "$mode" = read-only ]; then echo "Operation not permitted" >&2; exit 1; fi;;
esac
exec sh -c "$script"
`,
    { mode: 0o755 },
  );
  return bin;
}

describe('codex sandbox smoke check', () => {
  it('passes when reads run, default writes are denied and workspace writes are allowed', async () => {
    const checks = await codexSandboxSmoke(await fakeCodex(true));
    expect(checks.map((check) => [check.name, check.passed])).toEqual([
      ['read', true],
      ['write-denied', true],
      ['workspace-write', true],
    ]);
  });

  it('fails (unless --report-only) when the sandbox does not deny writes', async () => {
    const command = createHarnessCommand();
    const codex = await fakeCodex(false);
    const ctx = {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH },
      log: () => undefined,
    };
    await expect(
      command.run(['smoke', '--harness', 'codex', '--command', codex], ctx),
    ).rejects.toMatchObject({ code: 'E_HARNESS_FAILED' });
    const report = (await command.run(
      ['smoke', '--harness', 'codex', '--command', codex, '--report-only'],
      ctx,
    )) as { passed: boolean; checks: { name: string; passed: boolean }[] };
    expect(report.passed).toBe(false);
    expect(
      report.checks.find((check) => check.name === 'write-denied')?.passed,
    ).toBe(false);
  });

  it('reports a missing codex binary as failed checks', async () => {
    const dir = await tmp('agent-ci-nocodex-');
    await mkdir(path.join(dir, 'empty'));
    const checks = await codexSandboxSmoke(path.join(dir, 'empty', 'codex'));
    expect(
      checks.every((check) => !check.passed || check.name === 'write-denied'),
    ).toBe(true);
    expect(checks.find((check) => check.name === 'read')?.passed).toBe(false);
  });
});
