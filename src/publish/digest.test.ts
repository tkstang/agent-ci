import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import { digestResultDir, verifyResultDir } from '@agent-ci/publish/digest.js';
import { readRunOutputs } from '@agent-ci/publish/publish.js';
import { describe, expect, it } from 'vitest';

const RESULT = JSON.stringify({
  ok: true,
  status: 'no-op',
  useCase: 'u',
  targetRepo: 'o/r',
  summary: 's',
  artifacts: [],
  materializedArtifacts: [],
  changedFiles: [],
  errors: [],
  report: { title: 't', markdown: 'm' },
  outputContract: 'report',
});

async function resultDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-digest-'));
  await writeFile(path.join(dir, 'run-result.json'), RESULT);
  await writeFile(path.join(dir, 'run-log.jsonl'), '{}\n');
  return dir;
}

describe('result directory digest', () => {
  it('is stable and changes with any byte, name or extra file', async () => {
    const a = await resultDir();
    const b = await resultDir();
    const da = await digestResultDir(a);
    expect(da.ok && da.value).toMatch(/^[0-9a-f]{64}$/u);
    expect(await digestResultDir(b)).toEqual(da);
    await writeFile(path.join(b, 'changes.json'), '{}');
    expect(await digestResultDir(b)).not.toEqual(da);
    if (!da.ok) return;
    expect((await verifyResultDir(a, da.value)).ok).toBe(true);
    const forged = await verifyResultDir(b, da.value);
    expect(forged.ok ? 'ok' : forged.code).toBe('E_PUBLISH');
  });

  it('refuses links and directories inside the result directory', async () => {
    const dir = await resultDir();
    await symlink('/etc/passwd', path.join(dir, 'prompt.md'));
    const linked = await digestResultDir(dir);
    expect(linked.ok ? 'ok' : linked.code).toBe('E_PUBLISH');
    const nested = await resultDir();
    await mkdir(path.join(nested, 'sub'));
    const withDir = await digestResultDir(nested);
    expect(withDir.ok ? 'ok' : withDir.code).toBe('E_PUBLISH');
  });

  it('a forged result directory is refused before it is read', async () => {
    const honest = await resultDir();
    const digest = await digestResultDir(honest);
    if (!digest.ok) throw new Error(digest.message);
    const forged = await resultDir();
    await writeFile(
      path.join(forged, 'run-result.json'),
      RESULT.replace('"s"', '"forged"'),
    );
    const outputs = await readRunOutputs(forged, { digest: digest.value });
    expect(outputs.ok ? 'ok' : outputs.code).toBe('E_PUBLISH');
    const accepted = await readRunOutputs(honest, { digest: digest.value });
    expect(accepted.ok).toBe(true);
    // The CLI refuses before any GitHub call (no token needed to fail).
    const cli = await run(
      [
        'publish',
        '--result-dir',
        forged,
        '--repo',
        'o/r',
        '--result-digest',
        digest.value,
      ],
      { cwd: forged, env: { GITHUB_TOKEN: 'x' }, log: () => undefined },
    );
    expect(cli.envelope).toMatchObject({ ok: false, code: 'E_PUBLISH' });
    const digestCli = await run(['digest', '--dir', honest], {
      cwd: honest,
      env: {},
      log: () => undefined,
    });
    expect(digestCli.envelope).toMatchObject({
      ok: true,
      data: { digest: digest.value },
    });
  });
});
