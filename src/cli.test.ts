import { run } from '@agent-ci/cli.js';
import { describe, expect, it } from 'vitest';

describe('cli run()', () => {
  it('emits an ok envelope for a valid inline config', async () => {
    const { envelope, exitCode } = await run(['--config', '{"name":"my-app"}']);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.command).toBe('parse-config');
      expect(envelope.data).toMatchObject({ name: 'my-app', retries: 3 });
    }
  });

  it('emits a failure envelope with a code on invalid JSON (exit 1)', async () => {
    const { envelope, exitCode } = await run(['--config', '{bad}']);
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.code).toBe('E_INVALID_INPUT');
    }
  });

  it('treats an unknown flag as a user error (exit 1, E_INVALID_INPUT)', async () => {
    const { envelope, exitCode } = await run(['--nope']);
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.code).toBe('E_INVALID_INPUT');
      expect(envelope.hint).toBeTypeOf('string');
    }
  });

  it('errors when no input source is provided', async () => {
    const { envelope, exitCode } = await run([]);
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
  });

  it('returns an ok envelope for --help', async () => {
    const { envelope, exitCode } = await run(['--help']);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
  });
});
