import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { bundleHelpers } from '@agent-ci/commands/helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A package root laid out like pnpm's: deps linked into a store. */
async function fakeRoot(nestedDependency = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-helpers-'));
  dirs.push(root);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'cli.js'), 'console.log("cli");\n');
  await writeFile(path.join(root, 'models.yaml'), 'version: 1\nroutes: []\n');
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { yaml: '^2' } }),
  );
  const store = path.join(
    root,
    'node_modules',
    '.pnpm',
    'yaml@2',
    'node_modules',
    'yaml',
  );
  await mkdir(store, { recursive: true });
  await writeFile(
    path.join(store, 'package.json'),
    JSON.stringify(nestedDependency ? { dependencies: { other: '1' } } : {}),
  );
  await writeFile(path.join(store, 'index.js'), 'export default 1;\n');
  await symlink(store, path.join(root, 'node_modules', 'yaml'));
  return root;
}

describe('helpers bundle', () => {
  it('packs dist, the manifest, the routing table and dereferenced runtime deps', async () => {
    const root = await fakeRoot();
    const out = path.join(root, 'out', 'helpers.tgz');
    const sha = await bundleHelpers(out, root);
    expect(sha).toBe(
      createHash('sha256')
        .update(await readFile(out))
        .digest('hex'),
    );
    const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((entry) => entry.replace(/^\.\//u, ''))
      .filter((entry) => entry !== '' && entry !== '.');
    expect(listing).toEqual(
      expect.arrayContaining([
        'dist/cli.js',
        'models.yaml',
        'package.json',
        'node_modules/yaml/index.js',
      ]),
    );
    // The store link became real files; nothing points back into the root.
    const verbose = execFileSync('tar', ['-tvzf', out], { encoding: 'utf8' });
    expect(verbose).not.toMatch(/^l/mu);
    expect(listing.some((entry) => entry.includes('.pnpm'))).toBe(false);
  });

  it('refuses a runtime dependency that has dependencies of its own', async () => {
    const root = await fakeRoot(true);
    await expect(
      bundleHelpers(path.join(root, 'out.tgz'), root),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });
});
