import { run } from '@agent-ci/cli.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { describe, expect, it } from 'vitest';

function context(): CommandContext & { logs: string[] } {
  const logs: string[] = [];
  return { env: {}, cwd: '/tmp', log: (line) => logs.push(line), logs };
}

const echo: CommandSpec = {
  name: 'echo',
  summary: 'echo argv',
  usage: 'agent-ci echo [args]',
  run: async (argv) => ({ argv }),
};
const userError: CommandSpec = {
  name: 'bad',
  summary: 'fails',
  usage: 'agent-ci bad',
  run: async () => {
    throw new CliError('E_INVALID_INPUT', 'nope', { hint: 'try again' });
  },
};
const harnessError: CommandSpec = {
  name: 'boom',
  summary: 'system failure',
  usage: 'agent-ci boom',
  run: async () => {
    throw new CliError('E_HARNESS_TIMEOUT', 'timed out');
  },
};
const crash: CommandSpec = {
  name: 'crash',
  summary: 'unexpected',
  usage: 'agent-ci crash',
  run: async () => {
    throw new Error('kaboom');
  },
};
const commands = [echo, userError, harnessError, crash];

describe('cli run()', () => {
  it('lists commands for --help and logs usage to stderr only', async () => {
    const ctx = context();
    const { envelope, exitCode } = await run(['--help'], ctx, commands);
    expect(exitCode).toBe(0);
    expect(envelope).toEqual({
      ok: true,
      command: 'help',
      data: { commands: ['echo', 'bad', 'boom', 'crash'] },
    });
    expect(ctx.logs.join('\n')).toContain('Usage: agent-ci <command>');
  });

  it('treats no arguments as help', async () => {
    const { envelope, exitCode } = await run([], context(), commands);
    expect(exitCode).toBe(0);
    expect(envelope.command).toBe('help');
  });

  it('dispatches to a registered command and wraps its data', async () => {
    const { envelope, exitCode } = await run(
      ['echo', 'a', 'b'],
      context(),
      commands,
    );
    expect(exitCode).toBe(0);
    expect(envelope).toEqual({
      ok: true,
      command: 'echo',
      data: { argv: ['a', 'b'] },
    });
  });

  it('prints command usage for <command> --help', async () => {
    const ctx = context();
    const { envelope } = await run(['echo', '--help'], ctx, commands);
    expect(envelope).toEqual({
      ok: true,
      command: 'echo',
      data: { help: true },
    });
    expect(ctx.logs).toEqual(['agent-ci echo [args]']);
  });

  it('maps an unknown command to E_INVALID_INPUT (exit 1)', async () => {
    const { envelope, exitCode } = await run(['nope'], context(), commands);
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, code: 'E_INVALID_INPUT' });
  });

  it('maps CliError codes to exit codes and keeps the hint', async () => {
    const user = await run(['bad'], context(), commands);
    expect(user.exitCode).toBe(1);
    expect(user.envelope).toEqual({
      ok: false,
      command: 'bad',
      code: 'E_INVALID_INPUT',
      message: 'nope',
      hint: 'try again',
    });
    const system = await run(['boom'], context(), commands);
    expect(system.exitCode).toBe(2);
    expect(system.envelope).toMatchObject({ code: 'E_HARNESS_TIMEOUT' });
  });

  it('maps an unexpected throw to E_UNEXPECTED (exit 2)', async () => {
    const { envelope, exitCode } = await run(['crash'], context(), commands);
    expect(exitCode).toBe(2);
    expect(envelope).toMatchObject({ ok: false, code: 'E_UNEXPECTED' });
  });
});
