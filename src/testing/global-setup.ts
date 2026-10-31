import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Vitest global setup: give the whole test run one private temp root and
 * remove it afterwards. Workers inherit `TMPDIR`, so every `mkdtemp` under
 * `os.tmpdir()` (scratch repos, isolated home roots, replay controls) lands
 * here and nothing is left behind in the machine's temp directory.
 */
let root: string | undefined;

export function setup(): void {
  root = mkdtempSync(path.join(os.tmpdir(), 'agent-ci-tests-'));
  process.env.TMPDIR = root;
}

export function teardown(): void {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
}
