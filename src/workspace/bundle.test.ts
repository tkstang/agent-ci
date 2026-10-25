import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  isInTreeLinkTarget,
  restoreWorkspace,
} from '@agent-ci/workspace/bundle.js';
import { describe, expect, it } from 'vitest';

const tmp = async (prefix: string) =>
  realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));

const sha256 = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

/** A fresh agent-job checkout: a git repository with a known .git/config. */
async function agentCheckout(): Promise<{ target: string; config: string }> {
  const base = await tmp('agent-ci-restore-');
  const target = path.join(base, 'target');
  await mkdir(target);
  execFileSync('git', ['init', '-q'], { cwd: target });
  await writeFile(path.join(target, 'README.md'), '# repo\n');
  const config = await readFile(path.join(target, '.git', 'config'), 'utf8');
  return { target, config };
}

interface Member {
  readonly name: string;
  readonly type?: string;
  readonly mode?: number;
  readonly content?: string;
  readonly linkname?: string;
}

/** A test-only ustar writer, to forge archives real tar would not produce. */
function ustar(members: Member[], trailing?: Buffer): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const content = Buffer.from(member.content ?? '');
    const block = Buffer.alloc(512);
    const put = (offset: number, length: number, value: string) =>
      block.write(value.slice(0, length), offset, length, 'utf8');
    const num = (offset: number, length: number, value: number) =>
      put(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
    put(0, 100, member.name);
    num(100, 8, member.mode ?? 0o644);
    num(108, 8, 0);
    num(116, 8, 0);
    num(124, 12, content.length);
    num(136, 12, 0);
    block.fill(0x20, 148, 156);
    put(156, 1, member.type ?? '0');
    put(157, 100, member.linkname ?? '');
    put(257, 6, 'ustar\0');
    put(263, 2, '00');
    let sum = 0;
    for (const byte of block) sum += byte;
    put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(
      block,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  if (trailing !== undefined) blocks.push(trailing);
  return gzipSync(Buffer.concat(blocks));
}

async function forged(
  members: Member[],
  trailing?: Buffer,
): Promise<{ archive: string; digest: string }> {
  const archive = path.join(await tmp('agent-ci-forged-'), 'prepared.tgz');
  await writeFile(archive, ustar(members, trailing));
  return { archive, digest: await sha256(archive) };
}

async function untouched(target: string, config: string): Promise<void> {
  expect(await readFile(path.join(target, '.git', 'config'), 'utf8')).toBe(
    config,
  );
  expect((await readdir(target)).toSorted()).toEqual(['.git', 'README.md']);
  expect(
    (await readdir(path.dirname(target))).filter((name) =>
      name.includes('agent-ci-'),
    ),
  ).toEqual([]);
}

describe('restoring an honest prepared tree', () => {
  it('restores a tar of the setup tree over the checkout and keeps its own .git', async () => {
    const source = await tmp('agent-ci-src-');
    execFileSync('git', ['init', '-q'], { cwd: source });
    await writeFile(
      path.join(source, '.git', 'config'),
      '[core]\n\tfsmonitor = evil\n',
    );
    await mkdir(path.join(source, 'node_modules', '.bin'), { recursive: true });
    await writeFile(path.join(source, 'node_modules', 'tool.js'), 'run()');
    await link(
      path.join(source, 'node_modules', 'tool.js'),
      path.join(source, 'node_modules', 'tool-copy.js'),
    );
    await symlink(
      '../tool.js',
      path.join(source, 'node_modules', '.bin', 'tool'),
    );
    await writeFile(path.join(source, 'build.sh'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    await writeFile(path.join(source, 'prepared.txt'), 'prepared\n');
    const archive = path.join(await tmp('agent-ci-out-'), 'prepared.tgz');
    // The workflow's honest pack (GNU tar on runners; bsdtar here).
    execFileSync(
      'tar',
      ['--exclude=.git', '-czf', archive, '-C', source, '.'],
      { env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' } },
    );

    const { target, config } = await agentCheckout();
    const restored = await restoreWorkspace({
      archive,
      target,
      sha256: await sha256(archive),
    });
    expect(restored.ok).toBe(true);
    expect(await readFile(path.join(target, '.git', 'config'), 'utf8')).toBe(
      config,
    );
    expect(await readFile(path.join(target, 'prepared.txt'), 'utf8')).toBe(
      'prepared\n',
    );
    expect(
      await readFile(path.join(target, 'node_modules', 'tool-copy.js'), 'utf8'),
    ).toBe('run()');
    expect(
      await readlink(path.join(target, 'node_modules', '.bin', 'tool')),
    ).toBe('../tool.js');
    expect((await lstat(path.join(target, 'build.sh'))).mode & 0o777).toBe(
      0o755,
    );
    // Only archive content remains: the checkout's README was not in it.
    await expect(lstat(path.join(target, 'README.md'))).rejects.toThrow();
  });
});

const DEEP = 'a/b/c/d/e/f/g/h';

const HOSTILE: [string, Member[]][] = [
  [
    'one-level chained link escape (review M1)',
    [
      { name: 'sub/', type: '5', mode: 0o755 },
      { name: 'sub/l1', type: '2', linkname: '..' },
      { name: 'esc', type: '2', linkname: 'sub/l1/../x' },
    ],
  ],
  [
    'eight-level chained link to /etc/passwd (review M1)',
    [
      { name: 'a/', type: '5', mode: 0o755 },
      { name: 'a/b/', type: '5', mode: 0o755 },
      { name: 'a/b/c/', type: '5', mode: 0o755 },
      { name: 'a/b/c/d/', type: '5', mode: 0o755 },
      { name: 'a/b/c/d/e/', type: '5', mode: 0o755 },
      { name: 'a/b/c/d/e/f/', type: '5', mode: 0o755 },
      { name: 'a/b/c/d/e/f/g/', type: '5', mode: 0o755 },
      { name: 'a/b/c/d/e/f/g/h/', type: '5', mode: 0o755 },
      { name: `${DEEP}/l1`, type: '2', linkname: '../../../../../../../../' },
      {
        name: 'etcpw',
        type: '2',
        linkname: `${DEEP}/l1/../../../../../../../../etc/passwd`,
      },
    ],
  ],
  [
    'link loop',
    [
      { name: 'x', type: '2', linkname: 'y' },
      { name: 'y', type: '2', linkname: 'x' },
    ],
  ],
  [
    '.git/config member (the reviewed attack)',
    [
      { name: '.git/', type: '5', mode: 0o755 },
      { name: '.git/config', content: '[core]\n\tfsmonitor = /tmp/hook.sh\n' },
    ],
  ],
  [
    './.git/config member',
    [
      { name: './', type: '5', mode: 0o755 },
      { name: './.git/', type: '5', mode: 0o755 },
      { name: './.git/config', content: 'x' },
    ],
  ],
  [
    'nested .git (any case)',
    [
      { name: 'a/', type: '5', mode: 0o755 },
      { name: 'a/.GIT/', type: '5', mode: 0o755 },
    ],
  ],
  ['absolute path', [{ name: '/etc/passwd', content: 'x' }]],
  ['dot-dot path', [{ name: '../outside', content: 'x' }]],
  ['setuid file', [{ name: 'x', mode: 0o4755, content: 'x' }]],
  ['setgid directory', [{ name: 'd/', type: '5', mode: 0o2755 }]],
  ['link leaving the tree', [{ name: 'l', type: '2', linkname: '../../etc' }]],
  ['absolute link', [{ name: 'l', type: '2', linkname: '/proc/self/environ' }]],
  ['link into .git', [{ name: 'l', type: '2', linkname: '.git/config' }]],
  [
    'entry under a link',
    [
      { name: 'real/', type: '5', mode: 0o755 },
      { name: 'lnk', type: '2', linkname: 'real' },
      { name: 'lnk/x', content: 'x' },
    ],
  ],
  ['entry without its parent directory', [{ name: 'missing/x', content: 'x' }]],
  [
    'duplicate (case-insensitive)',
    [
      { name: 'A', content: 'x' },
      { name: 'a', content: 'y' },
    ],
  ],
  ['character device', [{ name: 'dev', type: '3' }]],
  ['FIFO', [{ name: 'fifo', type: '6' }]],
  [
    'hard link to a path outside the archive',
    [{ name: 'h', type: '1', linkname: '/etc/passwd' }],
  ],
];

describe('hostile prepared trees are refused and leave the checkout untouched', () => {
  for (const [name, members] of HOSTILE) {
    it(name, async () => {
      const { target, config } = await agentCheckout();
      const { archive, digest } = await forged(members);
      const restored = await restoreWorkspace({
        archive,
        target,
        sha256: digest,
      });
      expect(restored.ok ? 'ok' : restored.code).toBe('E_WORKSPACE_BUNDLE');
      await untouched(target, config);
    });
  }

  it('counts hard-link copies toward the byte limit (review r3 L2)', async () => {
    const { target, config } = await agentCheckout();
    const { archive, digest } = await forged([
      { name: 'f', content: '12345678' },
      ...[1, 2, 3, 4, 5].map((n) => ({
        name: `h${n}`,
        type: '1',
        linkname: 'f',
      })),
    ]);
    const restored = await restoreWorkspace({
      archive,
      target,
      sha256: digest,
      limits: { maxEntries: 100, maxFileBytes: 8, maxTotalBytes: 10 },
    });
    expect(restored.ok ? 'ok' : restored.code).toBe('E_WORKSPACE_BUNDLE');
    await untouched(target, config);
  });

  it('refuses data after the end-of-archive marker', async () => {
    const { target, config } = await agentCheckout();
    const { archive, digest } = await forged(
      [{ name: 'x', content: 'x' }],
      Buffer.from('more'),
    );
    const restored = await restoreWorkspace({
      archive,
      target,
      sha256: digest,
    });
    expect(restored.ok ? 'ok' : restored.code).toBe('E_WORKSPACE_BUNDLE');
    await untouched(target, config);
  });

  it('refuses a digest mismatch before reading the archive', async () => {
    const { target, config } = await agentCheckout();
    const { archive } = await forged([{ name: 'x', content: 'x' }]);
    const restored = await restoreWorkspace({
      archive,
      target,
      sha256: 'f'.repeat(64),
    });
    expect(restored.ok ? 'ok' : restored.code).toBe('E_WORKSPACE_BUNDLE');
    await untouched(target, config);
  });

  it('is not steered by TAR_OPTIONS or any other environment (no tar process)', async () => {
    const { target, config } = await agentCheckout();
    const previous = process.env.TAR_OPTIONS;
    process.env.TAR_OPTIONS = '--transform=s,^\\./\\.dotgit,.git,';
    try {
      const { archive, digest } = await forged([
        { name: './', type: '5', mode: 0o755 },
        { name: './.dotgit/', type: '5', mode: 0o755 },
        { name: './.dotgit/config', content: '[core]\n\tfsmonitor = x\n' },
      ]);
      const restored = await restoreWorkspace({
        archive,
        target,
        sha256: digest,
      });
      expect(restored.ok).toBe(true);
      // `.dotgit` stays an ordinary directory; the checkout's .git is intact.
      expect(await readFile(path.join(target, '.git', 'config'), 'utf8')).toBe(
        config,
      );
      expect(
        await readFile(path.join(target, '.dotgit', 'config'), 'utf8'),
      ).toContain('fsmonitor');
    } finally {
      if (previous === undefined) delete process.env.TAR_OPTIONS;
      else process.env.TAR_OPTIONS = previous;
    }
  });
});

describe('chained links that stay in the tree', () => {
  it('are accepted', async () => {
    const { target } = await agentCheckout();
    const { archive, digest } = await forged([
      { name: 'pkg/', type: '5', mode: 0o755 },
      { name: 'pkg/real.js', content: 'x' },
      { name: 'pkg/alias', type: '2', linkname: 'real.js' },
      { name: 'bin/', type: '5', mode: 0o755 },
      { name: 'bin/tool', type: '2', linkname: '../pkg/alias' },
      { name: 'dangling', type: '2', linkname: 'pkg/not-yet' },
    ]);
    const restored = await restoreWorkspace({
      archive,
      target,
      sha256: digest,
    });
    expect(restored.ok).toBe(true);
    expect(await readFile(path.join(target, 'bin', 'tool'), 'utf8')).toBe('x');
  });
});

describe('isInTreeLinkTarget', () => {
  it('accepts only relative targets that stay inside the tree', () => {
    expect(isInTreeLinkTarget('a/b/l', '../c')).toBe(true);
    expect(isInTreeLinkTarget('a/l', '../../x')).toBe(false);
    expect(isInTreeLinkTarget('l', '/abs')).toBe(false);
    expect(isInTreeLinkTarget('a/l', '../.git/config')).toBe(false);
    expect(isInTreeLinkTarget('a/l', '../../../../a/b')).toBe(false);
  });
});
