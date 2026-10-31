import { execFileSync } from 'node:child_process';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readOutputFile,
  readOutputFileHead,
} from '@agent-ci/harness/output-file.js';
import { describe, expect, it } from 'vitest';

describe('readOutputFile', () => {
  it('reads a regular file within the limit and refuses one past it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-output-'));
    const file = path.join(dir, 'out.txt');
    await writeFile(file, 'x'.repeat(64));
    expect(await readOutputFile(file, 64)).toEqual({
      kind: 'ok',
      text: 'x'.repeat(64),
    });
    expect(await readOutputFile(file, 63)).toEqual({
      kind: 'too-large',
      size: 64,
    });
    expect(await readOutputFile(path.join(dir, 'none'), 64)).toEqual({
      kind: 'missing',
    });
  });

  it('never follows a link and never blocks on a FIFO', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-output-'));
    const link = path.join(dir, 'link');
    await symlink('/dev/zero', link);
    expect((await readOutputFile(link, 64)).kind).toBe('invalid');
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect((await readOutputFile(fifo, 64)).kind).toBe('invalid');
    expect(await readOutputFileHead(fifo, 64)).toBeUndefined();
  });

  it('reads only the head of a log', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-output-'));
    const file = path.join(dir, 'calls.jsonl');
    await writeFile(file, 'a'.repeat(1000));
    expect(await readOutputFileHead(file, 10)).toBe('a'.repeat(10));
    expect(await readOutputFileHead(path.join(dir, 'none'), 10)).toBe(
      undefined,
    );
  });
});
