import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { pinFiles, pinHarness, verifyPin } from '@agent-ci/harness/pin.js';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pin-'));
  dirs.push(dir);
  return dir;
}

describe('harness pinning', () => {
  it('pins a binary by absolute real path and detects a later change or swap', async () => {
    const dir = await tempDir();
    const binary = path.join(dir, 'claude');
    await writeFile(binary, '#!/bin/sh\necho real\n', { mode: 0o755 });
    const pinned = await pinHarness('claude', `${dir}:/usr/bin:/bin`);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    // A script runs with its pinned interpreter; the script is pinned too.
    expect(pinned.value.prefixArgs).toEqual([
      path.join(await realDir(dir), 'claude'),
    ]);
    expect(path.isAbsolute(pinned.value.command)).toBe(true);
    expect((await verifyPin(pinned.value)).ok).toBe(true);
    // Content rewritten in place (what a planted binary does).
    await writeFile(binary, '#!/bin/sh\necho PLANTED\n', { mode: 0o755 });
    expect(await verifyPin(pinned.value)).toMatchObject({
      ok: false,
      code: 'E_UNSAFE_WORKSPACE',
    });
    // Swapped by rename: a new inode even with the original content.
    const again = await pinHarness('claude', dir);
    if (!again.ok) throw new Error(again.message);
    await writeFile(path.join(dir, 'swap'), '#!/bin/sh\necho PLANTED\n', {
      mode: 0o755,
    });
    await rename(path.join(dir, 'swap'), binary);
    expect((await verifyPin(again.value)).ok).toBe(false);
  });

  it('pins the interpreter of an env-node script and runs the script with it', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'codex'),
      '#!/usr/bin/env node\nconsole.log(1)\n',
      { mode: 0o755 },
    );
    const nodeDir = path.dirname(process.execPath);
    const pinned = await pinHarness('codex', `${dir}:${nodeDir}`);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.value.prefixArgs).toEqual([
      path.join(await realDir(dir), 'codex'),
    ]);
    expect(path.isAbsolute(pinned.value.command)).toBe(true);
    expect(pinned.value.files).toHaveLength(2);
  });

  it('refuses a harness that is not on PATH and fingerprints fixed files', async () => {
    const dir = await tempDir();
    expect(await pinHarness('claude', dir)).toMatchObject({
      ok: false,
      code: 'E_HARNESS_NOT_FOUND',
    });
    const file = path.join(dir, 'server.js');
    await writeFile(file, 'x');
    const pinned = await pinFiles([file]);
    expect((await verifyPin(pinned)).ok).toBe(true);
    await writeFile(file, 'y');
    expect((await verifyPin(pinned)).ok).toBe(false);
  });
});

function realDir(dir: string): Promise<string> {
  return realpath(dir);
}
