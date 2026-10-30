import { run } from '@agent-ci/cli.js';
import {
  createDoctorCommand,
  type VersionProbe,
} from '@agent-ci/commands/doctor.js';
import { KNOWN_CREDENTIAL_ENV } from '@agent-ci/contracts/secret-guard.js';
import { describe, expect, it } from 'vitest';

// Synthetic credential values. The doctor must report presence only.
const SECRETS = Object.fromEntries(
  KNOWN_CREDENTIAL_ENV.map((name, index) => [
    name,
    `synthetic-doctor-value-${index}-${name.toLowerCase()}`,
  ]),
);

const probe: VersionProbe = async (harness) =>
  harness === 'cursor'
    ? { found: false, version: null }
    : { found: true, version: `${harness} 1.0.0` };

function context(env: Record<string, string | undefined>) {
  const logs: string[] = [];
  return {
    env,
    cwd: process.cwd(),
    log: (line: string) => logs.push(line),
    logs,
  };
}

describe('agent-ci doctor', () => {
  it('reports credential presence by name and never prints a credential value', async () => {
    const ctx = context({ ...SECRETS, PATH: '/usr/bin' });
    const { envelope, exitCode } = await run(['doctor'], ctx, [
      createDoctorCommand(probe),
    ]);
    expect(exitCode).toBe(0);
    const text = JSON.stringify(envelope) + ctx.logs.join('\n');
    for (const value of Object.values(SECRETS)) {
      expect(text).not.toContain(value);
    }
    if (!envelope.ok) throw new Error('doctor failed');
    const data = envelope.data as {
      credentialEnv: { name: string; present: boolean }[];
      harnesses: { id: string; found: boolean }[];
      routes: { id: string; usable: boolean; blockedBy?: string }[];
    };
    expect(data.credentialEnv.every((entry) => entry.present)).toBe(true);
    expect(data.harnesses.find((entry) => entry.id === 'cursor')?.found).toBe(
      false,
    );
    expect(
      data.routes.find((entry) => entry.id === 'claude-haiku-4-5-pool'),
    ).toMatchObject({
      usable: false,
      blockedBy: 'E_POLICY_POOL',
    });
  });

  it('reports absence and CI', async () => {
    const { envelope } = await run(
      ['doctor', '--allow-pool'],
      context({ CI: 'true' }),
      [createDoctorCommand(probe)],
    );
    if (!envelope.ok) throw new Error('doctor failed');
    const data = envelope.data as {
      ci: boolean;
      credentialEnv: { present: boolean }[];
      routes: { id: string; blockedBy?: string }[];
    };
    expect(data.ci).toBe(true);
    expect(data.credentialEnv.some((entry) => entry.present)).toBe(false);
    expect(
      data.routes.find((entry) => entry.id === 'claude-haiku-4-5-pool')
        ?.blockedBy,
    ).toBe('E_POLICY_POOL_CI');
    expect(data.routes.find((entry) => entry.id === 'fake-echo')).toMatchObject(
      {
        usable: true,
      },
    );
  });
});
