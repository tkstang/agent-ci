import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { escapingLink } from '@agent-ci/review/links.js';
import { describe, expect, it } from 'vitest';

async function repo(links: [string, string][]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-links-'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'real.md'), 'ok\n');
  for (const [at, target] of links) await symlink(target, path.join(root, at));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      {
        cwd: root,
      },
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'links');
  return root;
}

describe('escapingLink', () => {
  it('accepts links that stay inside the repository, dangling or not', async () => {
    const root = await repo([
      ['inside.md', 'docs/real.md'],
      ['dir-link', 'docs'],
      ['missing.md', 'docs/not-yet.md'],
    ]);
    expect(await escapingLink(root)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['an absolute target', [['environ', '/proc/self/environ']]],
    ['a relative climb', [['up', '../outside.txt']]],
    ['a dangling absolute target', [['gone', '/nonexistent/agent-ci/x']]],
    [
      'a chain through a link to the root',
      [
        ['self', '.'],
        ['sneaky', 'self/../outside.txt'],
      ],
    ],
  ] as [string, [string, string][]][])('refuses %s', async (_name, links) => {
    const root = await repo(links);
    const found = await escapingLink(root);
    expect(found.ok && found.value).toBeTruthy();
  });

  it('checks untracked links too', async () => {
    const root = await repo([]);
    await symlink('/etc/hosts', path.join(root, 'untracked'));
    expect(await escapingLink(root)).toEqual({ ok: true, value: 'untracked' });
  });
});
