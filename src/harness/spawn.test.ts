import { spawnHarness } from '@agent-ci/harness/spawn.js';
import { afterEach, describe, expect, it } from 'vitest';

const node = process.execPath;
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

function script(source: string) {
  return { command: node, args: ['-e', source], cwd: process.cwd(), env };
}

// A detached (setsid) grandchild that inherits stdout/stderr and outlives
// the leader; it prints its pid first so the test can clean it up.
const escaped = (after: string) => `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  process.stdout.write('pid:' + child.pid + '\\n');
  ${after}
`;

/** Wait until `pid` is gone (killed with its group, then reaped), up to 3 s. */
async function gone(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 60; tries += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('spawnHarness', () => {
  it('always gives the child /dev/null as stdin', async () => {
    const result = await spawnHarness({
      ...script(`
        const fs = require('node:fs');
        const a = fs.fstatSync(0), b = fs.statSync('/dev/null');
        process.stdout.write(JSON.stringify({
          devNull: a.rdev === b.rdev && a.ino === b.ino,
          bytes: fs.readFileSync(0).length,
        }));
      `),
      timeoutMs: 10_000,
    });
    expect(result.started && JSON.parse(result.stdout)).toEqual({
      devNull: true,
      bytes: 0,
    });
  });

  it('passes exactly the given environment', async () => {
    const result = await spawnHarness({
      ...script(
        'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))',
      ),
      env: { PATH: env.PATH, ONLY_THIS: '1' },
      timeoutMs: 10_000,
    });
    const keys: string[] = result.started ? JSON.parse(result.stdout) : [];
    expect(keys.filter((key) => key !== '__CF_USER_TEXT_ENCODING')).toEqual([
      'ONLY_THIS',
      'PATH',
    ]);
  });

  it('kills the whole process group at the deadline', async () => {
    const result = await spawnHarness({
      ...script(`
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        process.stdout.write(String(child.pid) + '\\n');
        setInterval(() => {}, 1000);
      `),
      timeoutMs: 500,
      killGraceMs: 200,
    });
    expect(result.started).toBe(true);
    if (!result.started) return;
    expect(result.timedOut).toBe(true);
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await gone(grandchild)).toBe(true);
  });

  it('stops a child that exceeds the output cap', async () => {
    const result = await spawnHarness({
      ...script(
        `setInterval(() => process.stdout.write('x'.repeat(65536)), 1)`,
      ),
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024,
      killGraceMs: 200,
    });
    expect(result.started && result.outputLimitExceeded).toBe(true);
    expect(result.started && result.stdout.length).toBeLessThanOrEqual(
      256 * 1024,
    );
  });

  it('reports a missing executable without throwing', async () => {
    const result = await spawnHarness({
      command: 'agent-ci-definitely-missing-binary',
      args: [],
      cwd: process.cwd(),
      env,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ started: false, errorCode: 'ENOENT' });
  });

  it('captures exit code, stdout and stderr', async () => {
    const result = await spawnHarness({
      ...script(
        `process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;`,
      ),
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({
      started: true,
      exitCode: 3,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
    });
  });

  describe('hard bound when a descendant leaves the process group', () => {
    const strays: number[] = [];
    const remember = (stdout: string) => {
      const pid = Number(/pid:(\d+)/u.exec(stdout)?.[1]);
      if (pid > 0) strays.push(pid);
    };
    afterEach(() => {
      for (const pid of strays.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });

    it('settles at deadline + grace even if an escaped descendant holds stdout', async () => {
      const started = Date.now();
      const result = await spawnHarness({
        ...script(escaped('setInterval(() => {}, 1000);')),
        timeoutMs: 1_000,
        killGraceMs: 200,
      });
      const elapsed = Date.now() - started;
      expect(result.started && result.timedOut).toBe(true);
      if (result.started) remember(result.stdout);
      expect(elapsed).toBeLessThan(1_000 + 200 + 800);
    });

    it('settles after an output-cap stop even if an escaped descendant holds stdout', async () => {
      const started = Date.now();
      const result = await spawnHarness({
        ...script(
          escaped(
            "setInterval(() => process.stdout.write('x'.repeat(65536)), 1);",
          ),
        ),
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
        killGraceMs: 200,
      });
      expect(result.started && result.outputLimitExceeded).toBe(true);
      if (result.started) remember(result.stdout);
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it('keeps the exit status when the leader exits but an escaped descendant holds stdout', async () => {
      const started = Date.now();
      const result = await spawnHarness({
        ...script(escaped("process.stdout.write('done');")),
        timeoutMs: 30_000,
        killGraceMs: 200,
      });
      expect(result).toMatchObject({
        started: true,
        exitCode: 0,
        timedOut: false,
      });
      if (result.started) {
        remember(result.stdout);
        expect(result.stdout).toContain('done');
      }
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });
});
