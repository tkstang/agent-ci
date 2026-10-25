import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '@agent-ci/cli.js';
import { createPublishCommand } from '@agent-ci/commands/publish.js';
import type { ChangeSet } from '@agent-ci/publish/changes.js';
import { createGit } from '@agent-ci/publish/git.js';
import type { GitHubClient, IssueComment } from '@agent-ci/publish/github.js';
import {
  publishRun,
  readRunOutputs,
  type RunOutputs,
} from '@agent-ci/publish/publish.js';
import { commentMarker } from '@agent-ci/publish/render.js';
import {
  ACTIONS_BOT,
  publishStaticBranch,
} from '@agent-ci/publish/static-branch.js';
import { success } from '@agent-ci/result.js';
import { PATH_POLICIES } from '@agent-ci/use-cases/presets.js';
import { describe, expect, it } from 'vitest';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();

/** A bare "remote" with one commit on main, and a shallow clone of it. */
async function remoteAndClone(): Promise<{
  base: string;
  remote: string;
  clone: string;
  seed: string;
}> {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pub-')),
  );
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', seed);
  await writeFile(path.join(seed, 'README.md'), '# r\n');
  await writeFile(path.join(seed, 'old.txt'), 'old\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const clone = path.join(base, 'clone');
  git(base, 'clone', '-q', '--depth=1', `file://${remote}`, clone);
  return { base, remote, clone, seed };
}

function write(file: string, content: string): ChangeSet['files'][number] {
  return {
    path: file,
    action: 'write',
    mode: '100644',
    size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    contentBase64: Buffer.from(content).toString('base64'),
  };
}

describe('publishStaticBranch', () => {
  it('creates, keeps and fast-forwards a static branch without touching the checkout', async () => {
    const { remote, clone, seed } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const runner = createGit(clone, { PATH: process.env.PATH });
    const changeSet: ChangeSet = {
      version: 1,
      baseSha,
      files: [
        write('docs/new.md', 'new\n'),
        { path: 'old.txt', action: 'delete' },
        { path: 'link', action: 'symlink', target: 'README.md' },
      ],
    };
    const options = {
      git: runner,
      changeSet,
      branch: 'agent-ci/test',
      baseBranch: 'main',
      title: 'agent-ci: test',
      author: ACTIONS_BOT,
    };
    const created = await publishStaticBranch(options);
    expect(created.ok && created.value.action).toBe('created');
    if (!created.ok) return;
    const first = created.value.commit;
    expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/test')).toBe(first);
    expect(git(remote, 'log', '-1', '--format=%P%n%an%n%B', first)).toBe(
      `${baseSha}\ngithub-actions[bot]\nagent-ci: test\n\nAgent-CI-Base: ${baseSha}`,
    );
    expect(
      git(remote, 'ls-tree', '-r', '--name-only', first).split('\n'),
    ).toEqual(['README.md', 'docs/new.md', 'link']);
    expect(git(remote, 'ls-tree', first, 'link')).toMatch(/^120000 blob/u);
    // The clone's checkout is untouched.
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(baseSha);

    const again = await publishStaticBranch(options);
    expect(again.ok && again.value).toEqual({
      branch: 'agent-ci/test',
      commit: first,
      action: 'unchanged',
    });

    const updated = await publishStaticBranch({
      ...options,
      changeSet: { ...changeSet, files: [write('docs/new.md', 'newer\n')] },
    });
    expect(updated.ok && updated.value.action).toBe('updated');
    if (!updated.ok) return;
    expect(git(remote, 'log', '-1', '--format=%P', updated.value.commit)).toBe(
      first,
    );

    // The base moves on: the next commit merges the new base, so the pull
    // request still shows only this run's change.
    await writeFile(path.join(seed, 'other.txt'), 'other\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'advance');
    git(seed, 'push', '-q', 'origin', 'main');
    const newBase = git(seed, 'rev-parse', 'HEAD');
    const merged = await publishStaticBranch({
      ...options,
      changeSet: {
        version: 1,
        baseSha: newBase,
        files: [write('docs/new.md', 'newest\n')],
      },
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(git(remote, 'log', '-1', '--format=%P', merged.value.commit)).toBe(
      `${updated.value.commit} ${newBase}`,
    );
    expect(
      git(remote, 'diff', '--name-only', newBase, merged.value.commit),
    ).toBe('docs/new.md');
    // Never rewritten: the first commit is still in the branch history.
    expect(() =>
      git(
        remote,
        'merge-base',
        '--is-ancestor',
        first,
        'refs/heads/agent-ci/test',
      ),
    ).not.toThrow();
  });

  it('records a moved base, then refuses an older base that would undo it (gate M1 A/B/C, final H1)', async () => {
    const { remote, clone, seed } = await remoteAndClone();
    // Base A: README.md = old (seed has "# r\n"; set it explicitly).
    await writeFile(path.join(seed, 'README.md'), 'old\n');
    git(seed, 'commit', '-qam', 'A');
    git(seed, 'push', '-q', 'origin', 'main');
    const a = git(seed, 'rev-parse', 'HEAD');
    const runner = createGit(clone, { PATH: process.env.PATH });
    const options = {
      git: runner,
      branch: 'agent-ci/abc',
      baseBranch: 'main',
      title: 't',
      author: ACTIONS_BOT,
    };
    const changes = (baseSha: string): ChangeSet => ({
      version: 1,
      baseSha,
      files: [write('README.md', 'agent\n')],
    });
    const b = await publishStaticBranch({ ...options, changeSet: changes(a) });
    expect(b.ok && b.value.action).toBe('created');
    if (!b.ok) return;
    // Same base again: idempotent.
    const same = await publishStaticBranch({
      ...options,
      changeSet: changes(a),
    });
    expect(same.ok && same.value).toMatchObject({
      action: 'unchanged',
      commit: b.value.commit,
    });
    // Base C moves README.md, adds an unrelated file and modifies another.
    await writeFile(path.join(seed, 'README.md'), 'new-base\n');
    await mkdir(path.join(seed, 'src'));
    await writeFile(path.join(seed, 'src', 'new.ts'), 'export const x = 1;\n');
    await writeFile(path.join(seed, 'old.txt'), 'changed on main\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'C');
    git(seed, 'push', '-q', 'origin', 'main');
    const c = git(seed, 'rev-parse', 'HEAD');
    // Accepted control: the newer base publishes with parents [B, C], and
    // the pull request diff against C is only this run's path.
    const moved = await publishStaticBranch({
      ...options,
      changeSet: changes(c),
    });
    expect(moved.ok && moved.value.action).toBe('updated');
    if (!moved.ok) return;
    expect(git(remote, 'log', '-1', '--format=%P', moved.value.commit)).toBe(
      `${b.value.commit} ${c}`,
    );
    expect(
      git(remote, 'diff', '--name-status', `${c}...${moved.value.commit}`),
    ).toBe('M\tREADME.md');
    expect(
      git(remote, 'diff', `${c}...${moved.value.commit}`, '--', 'README.md'),
    ).toContain('-new-base');
    // And from C again: idempotent.
    const again = await publishStaticBranch({
      ...options,
      changeSet: changes(c),
    });
    expect(again.ok && again.value.action).toBe('unchanged');
    // A delayed or rerun artifact from the older base A, from a fresh
    // shallow clone: its tree would drop src/new.ts and revert old.txt, so
    // it is refused and the branch is untouched, for the same change set
    // and for a new one.
    const fresh = path.join(path.dirname(clone), 'fresh');
    git(
      path.dirname(clone),
      'clone',
      '-q',
      '--depth=1',
      `file://${remote}`,
      fresh,
    );
    const freshOptions = {
      ...options,
      git: createGit(fresh, { PATH: process.env.PATH }),
    };
    for (const files of [changes(a).files, [write('README.md', 'agent 2\n')]]) {
      const older = await publishStaticBranch({
        ...freshOptions,
        changeSet: { version: 1, baseSha: a, files },
      });
      expect(older.ok ? 'ok' : older.code).toBe('E_PUBLISH_STALE_BASE');
      expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/abc')).toBe(
        moved.value.commit,
      );
    }
    expect(
      git(remote, 'diff', '--name-status', `${c}...refs/heads/agent-ci/abc`),
    ).toBe('M\tREADME.md');
    // A newer base after the refusals still publishes normally.
    await writeFile(path.join(seed, 'later.txt'), 'later\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'D');
    git(seed, 'push', '-q', 'origin', 'main');
    const d = git(seed, 'rev-parse', 'HEAD');
    const newer = await publishStaticBranch({
      ...freshOptions,
      changeSet: changes(d),
    });
    expect(newer.ok && newer.value.action).toBe('updated');
    expect(
      git(remote, 'diff', '--name-status', `${d}...refs/heads/agent-ci/abc`),
    ).toBe('M\tREADME.md');
  });

  it('refuses a base it cannot relate to the recorded one unless the branch is adopted', async () => {
    const { remote, clone, seed } = await remoteAndClone();
    const a = git(seed, 'rev-parse', 'HEAD');
    const options = {
      git: createGit(clone, { PATH: process.env.PATH }),
      branch: 'agent-ci/rewritten',
      baseBranch: 'main',
      title: 't',
      author: ACTIONS_BOT,
    };
    const first = await publishStaticBranch({
      ...options,
      changeSet: { version: 1, baseSha: a, files: [write('a.md', 'a\n')] },
    });
    expect(first.ok && first.value.action).toBe('created');
    if (!first.ok) return;
    // The base branch is rewritten to an unrelated history.
    git(seed, 'checkout', '-q', '--orphan', 'rewrite');
    await writeFile(path.join(seed, 'README.md'), 'rewritten\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'rewritten');
    git(seed, 'push', '-q', '--force', 'origin', 'rewrite:main');
    const x = git(seed, 'rev-parse', 'HEAD');
    const changeSet: ChangeSet = {
      version: 1,
      baseSha: x,
      files: [write('a.md', 'a\n')],
    };
    const refused = await publishStaticBranch({ ...options, changeSet });
    expect(refused.ok ? 'ok' : refused.code).toBe('E_PUBLISH_STALE_BASE');
    expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/rewritten')).toBe(
      first.value.commit,
    );
    const adopted = await publishStaticBranch({
      ...options,
      changeSet,
      adoptBranch: true,
    });
    expect(adopted.ok && adopted.value.action).toBe('updated');
  });

  it('refuses protected or base branch names and a change set without a base', async () => {
    const { clone } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const runner = createGit(clone, { PATH: process.env.PATH });
    for (const branch of [
      'main',
      'release',
      '-x',
      'a b',
      'master',
      'feature/human',
      'agent-ci/',
      'agent-ci-x',
    ]) {
      const result = await publishStaticBranch({
        git: runner,
        changeSet: { version: 1, baseSha, files: [write('a', 'a')] },
        branch,
        baseBranch: 'release',
        title: 't',
        author: ACTIONS_BOT,
      });
      expect(result.ok ? 'ok' : result.code).toBe('E_PUBLISH');
    }
    const noBase = await publishStaticBranch({
      git: runner,
      changeSet: { version: 1, baseSha: null, files: [write('a', 'a')] },
      branch: 'agent-ci/x',
      baseBranch: 'main',
      title: 't',
      author: ACTIONS_BOT,
    });
    expect(noBase.ok ? 'ok' : noBase.code).toBe('E_PUBLISH');
  });
});

describe('static branch ownership', () => {
  it('refuses a non-agent branch (the review probe) and leaves it untouched', async () => {
    const { remote, clone, seed } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    git(seed, 'checkout', '-q', '-b', 'feature/human');
    await writeFile(path.join(seed, 'human-work.txt'), 'human\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'human work');
    git(seed, 'push', '-q', 'origin', 'feature/human');
    const before = git(remote, 'rev-parse', 'refs/heads/feature/human');
    const result = await publishStaticBranch({
      git: createGit(clone, { PATH: process.env.PATH }),
      changeSet: { version: 1, baseSha, files: [write('agent.txt', 'a')] },
      branch: 'feature/human',
      baseBranch: 'main',
      title: 't',
      author: ACTIONS_BOT,
    });
    expect(result.ok ? 'ok' : result.code).toBe('E_PUBLISH');
    expect(git(remote, 'rev-parse', 'refs/heads/feature/human')).toBe(before);
  });

  it('refuses an agent-ci branch whose head someone else committed, unless adopted', async () => {
    const { remote, clone, seed } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const options = {
      git: createGit(clone, { PATH: process.env.PATH }),
      changeSet: {
        version: 1 as const,
        baseSha,
        files: [write('agent.txt', 'a')],
      },
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      title: 't',
      author: ACTIONS_BOT,
    };
    const created = await publishStaticBranch(options);
    expect(created.ok && created.value.action).toBe('created');
    // A person pushes a fix-up onto the static branch.
    git(seed, 'fetch', '-q', 'origin', 'agent-ci/docs');
    git(seed, 'checkout', '-q', '-b', 'docs', 'FETCH_HEAD');
    await writeFile(path.join(seed, 'human-fix.txt'), 'fix\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'human fix-up');
    git(seed, 'push', '-q', 'origin', 'docs:agent-ci/docs');
    const human = git(remote, 'rev-parse', 'refs/heads/agent-ci/docs');

    const refused = await publishStaticBranch({
      ...options,
      changeSet: { ...options.changeSet, files: [write('agent.txt', 'b')] },
    });
    expect(refused.ok ? 'ok' : refused.code).toBe('E_PUBLISH');
    expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/docs')).toBe(human);

    // A different publishing identity does not own the bot's commits either.
    const otherIdentity = await publishStaticBranch({
      ...options,
      branch: 'agent-ci/other',
      author: { name: 'someone', email: 'someone@example.com' },
    });
    expect(otherIdentity.ok).toBe(true);
    const foreign = await publishStaticBranch({
      ...options,
      branch: 'agent-ci/other',
      changeSet: { ...options.changeSet, files: [write('agent.txt', 'c')] },
    });
    expect(foreign.ok ? 'ok' : foreign.code).toBe('E_PUBLISH');

    // Adopting keeps the person's commit in history (no force push).
    const adopted = await publishStaticBranch({
      ...options,
      changeSet: { ...options.changeSet, files: [write('agent.txt', 'b')] },
      adoptBranch: true,
    });
    expect(adopted.ok && adopted.value.action).toBe('updated');
    expect(() =>
      git(
        remote,
        'merge-base',
        '--is-ancestor',
        human,
        'refs/heads/agent-ci/docs',
      ),
    ).not.toThrow();
  });

  it('honours a custom agent-owned prefix', async () => {
    const { clone } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const base = {
      git: createGit(clone, { PATH: process.env.PATH }),
      changeSet: { version: 1 as const, baseSha, files: [write('a', 'a')] },
      baseBranch: 'main',
      title: 't',
      author: ACTIONS_BOT,
      branchPrefix: 'bots/',
    };
    const ok = await publishStaticBranch({ ...base, branch: 'bots/run' });
    expect(ok.ok).toBe(true);
    const outside = await publishStaticBranch({
      ...base,
      branch: 'agent-ci/run',
    });
    expect(outside.ok ? 'ok' : outside.code).toBe('E_PUBLISH');
    const badPrefix = await publishStaticBranch({
      ...base,
      branch: 'main/x',
      branchPrefix: 'main/',
    });
    expect(badPrefix.ok ? 'ok' : badPrefix.code).toBe('E_PUBLISH');
  });
});

interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  author?: string;
}

/** In-memory GitHub for publishRun. */
function fakeGitHub(viewer = 'github-actions[bot]') {
  const pulls: FakePull[] = [];
  const comments = new Map<number, IssueComment[]>();
  let nextId = 100;
  const client: GitHubClient = {
    viewer: async () => viewer,
    findOpenPull: async (head, base) => {
      const found = pulls.find(
        (pull) => pull.head === head && pull.base === base,
      );
      return success(
        found === undefined
          ? null
          : {
              number: found.number,
              url: `https://gh/pull/${found.number}`,
              author: found.author ?? viewer,
            },
      );
    },
    createPull: async (input) => {
      const number = pulls.length + 1;
      pulls.push({ number, ...input });
      return success({ number, url: `https://gh/pull/${number}` });
    },
    updatePull: async (number, input) => {
      const pull = pulls.find((entry) => entry.number === number);
      if (pull !== undefined) Object.assign(pull, input);
      return success({ number, url: `https://gh/pull/${number}` });
    },
    listComments: async (issue) => success([...(comments.get(issue) ?? [])]),
    createComment: async (issue, body) => {
      nextId += 1;
      const comment = {
        id: nextId,
        url: `https://gh/c/${nextId}`,
        author: viewer,
        body,
      };
      comments.set(issue, [...(comments.get(issue) ?? []), comment]);
      return success(comment);
    },
    updateComment: async (id, body) => {
      for (const list of comments.values()) {
        const index = list.findIndex((entry) => entry.id === id);
        const found = list[index];
        if (found !== undefined) {
          list[index] = { ...found, body };
          return success(list[index] ?? found);
        }
      }
      throw new Error('no comment');
    },
  };
  return { client, pulls, comments };
}

function outputs(
  overrides: Partial<RunOutputs['result']> = {},
  changeSet: ChangeSet | null = null,
): RunOutputs {
  return {
    dir: '/x',
    result: {
      ok: true,
      status: 'changed',
      useCase: 'docs-update',
      targetRepo: 'o/r',
      summary: 'Updated docs @someone <!-- agent-ci:comment:agent-ci/docs -->',
      artifacts: [],
      materializedArtifacts: [],
      changedFiles: ['docs/new.md'],
      errors: [],
      ...overrides,
    },
    changeSet,
  };
}

describe('publisher identity', () => {
  it('updates the comment of an explicitly named identity (GitHub App token) instead of duplicating it', async () => {
    const gh = fakeGitHub(); // viewer() answers github-actions[bot]
    gh.comments.set(5, [
      {
        id: 1,
        url: 'u',
        author: 'my-app[bot]',
        body: commentMarker('agent-ci/docs'),
      },
    ]);
    const base = {
      outputs: outputs({ status: 'no-op', changedFiles: [] }),
      github: gh.client,
      pullRequest: false,
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      commentOn: 5,
      author: ACTIONS_BOT,
    };
    const named = await publishRun({ ...base, publisherLogin: 'my-app[bot]' });
    expect(named.ok && named.value.comment).toMatchObject({
      action: 'updated',
    });
    expect(gh.comments.get(5)).toHaveLength(1);
    // Without the name, the fallback identity cannot see the App's comment.
    const unnamed = await publishRun(base);
    expect(unnamed.ok && unnamed.value.comment).toMatchObject({
      action: 'created',
    });
  });

  it('refuses to rewrite a pull request someone else opened from the static branch, before pushing', async () => {
    const { remote, clone } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const gh = fakeGitHub();
    gh.pulls.push({
      number: 1,
      head: 'agent-ci/docs',
      base: 'main',
      title: 'mine',
      body: 'human text',
      author: 'mallory',
    });
    const report = await publishRun({
      outputs: outputs(
        {},
        { version: 1, baseSha, files: [write('docs/new.md', 'n\n')] },
      ),
      github: gh.client,
      git: createGit(clone, { PATH: process.env.PATH }),
      pullRequest: true,
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      author: ACTIONS_BOT,
    });
    expect(report.ok ? 'ok' : report.code).toBe('E_PUBLISH');
    expect(gh.pulls[0]?.body).toBe('human text');
    expect(() =>
      git(remote, 'rev-parse', '--verify', 'refs/heads/agent-ci/docs'),
    ).toThrow();
  });
});

describe('use-case path policy', () => {
  it('refuses a change set with a path outside the policy before anything is pushed', async () => {
    const { remote, clone } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const gh = fakeGitHub();
    const report = await publishRun({
      outputs: outputs(
        { changedFiles: ['docs/new.md', 'src/evil.ts'] },
        {
          version: 1,
          baseSha,
          files: [write('docs/new.md', 'n\n'), write('src/evil.ts', 'x\n')],
        },
      ),
      github: gh.client,
      git: createGit(clone, { PATH: process.env.PATH }),
      pullRequest: true,
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      author: ACTIONS_BOT,
      pathPolicy: {
        name: 'docs-update',
        policy: PATH_POLICIES['docs-update'],
      },
    });
    expect(report.ok ? 'ok' : report.code).toBe('E_PATH_POLICY');
    expect(report.ok ? '' : report.message).toContain('src/evil.ts');
    expect(gh.pulls).toHaveLength(0);
    expect(() =>
      git(remote, 'rev-parse', '--verify', 'refs/heads/agent-ci/docs'),
    ).toThrow();
  });

  it('publishes a change set inside the policy', async () => {
    const { clone } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const gh = fakeGitHub();
    const report = await publishRun({
      outputs: outputs(
        {},
        { version: 1, baseSha, files: [write('docs/new.md', 'n\n')] },
      ),
      github: gh.client,
      git: createGit(clone, { PATH: process.env.PATH }),
      pullRequest: true,
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      author: ACTIONS_BOT,
      pathPolicy: {
        name: 'docs-update',
        policy: PATH_POLICIES['docs-update'],
      },
    });
    expect(report.ok && report.value.pull.action).toBe('created');
  });

  it('refuses a delayed older-base docs run that would delete a newer-base file (final H1 probe)', async () => {
    const { remote, clone, seed } = await remoteAndClone();
    const gh = fakeGitHub();
    const publish = (baseSha: string, text: string) =>
      publishRun({
        outputs: outputs(
          {},
          { version: 1, baseSha, files: [write('docs/new.md', text)] },
        ),
        github: gh.client,
        git: createGit(clone, { PATH: process.env.PATH }),
        pullRequest: true,
        branch: 'agent-ci/docs',
        baseBranch: 'main',
        author: ACTIONS_BOT,
        pathPolicy: {
          name: 'docs-update',
          policy: PATH_POLICIES['docs-update'],
        },
      });
    const a = git(seed, 'rev-parse', 'HEAD');
    const initial = await publish(a, 'agent initial\n');
    expect(initial.ok && initial.value.pull.action).toBe('created');
    // main advances with source.
    await mkdir(path.join(seed, 'src'));
    await writeFile(path.join(seed, 'src', 'new.ts'), 'export const x = 1;\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'main advances with source');
    git(seed, 'push', '-q', 'origin', 'main');
    const c = git(seed, 'rev-parse', 'HEAD');
    // Accepted control: a docs run on C changes only the docs file.
    const latest = await publish(c, 'agent new base\n');
    expect(latest.ok && latest.value.pull.action).toBe('updated');
    const head = git(remote, 'rev-parse', 'refs/heads/agent-ci/docs');
    expect(
      git(remote, 'diff', '--name-status', `${c}...refs/heads/agent-ci/docs`),
    ).toBe('A\tdocs/new.md');
    // The delayed run from A is refused; the branch and pull request stay.
    const body = gh.pulls[0]?.body;
    const stale = await publish(a, 'agent delayed old base\n');
    expect(stale.ok ? 'ok' : stale.code).toBe('E_PUBLISH_STALE_BASE');
    expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/docs')).toBe(head);
    expect(
      git(remote, 'diff', '--name-status', `${c}...refs/heads/agent-ci/docs`),
    ).toBe('A\tdocs/new.md');
    expect(gh.pulls[0]?.body).toBe(body);
  });

  it('checks the whole pull request diff, not only the change set (adopted branch carrying a newer base)', async () => {
    const { remote, clone, seed } = await remoteAndClone();
    const a = git(seed, 'rev-parse', 'HEAD');
    const gh = fakeGitHub();
    const base = {
      github: gh.client,
      git: createGit(clone, { PATH: process.env.PATH }),
      pullRequest: true,
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      author: ACTIONS_BOT,
    };
    const docs = (baseSha: string) =>
      outputs(
        {},
        { version: 1, baseSha, files: [write('docs/new.md', 'n\n')] },
      );
    const created = await publishRun({ ...base, outputs: docs(a) });
    expect(created.ok && created.value.pull.action).toBe('created');
    // main advances (a source file and a workflow), and a person merges it
    // into the static branch: the head has no agent-ci trailer, so only the
    // pull request diff shows what an older-base tree would undo.
    await mkdir(path.join(seed, 'src'));
    await writeFile(path.join(seed, 'src', 'new.ts'), 'export const x = 1;\n');
    await mkdir(path.join(seed, '.github', 'workflows'), { recursive: true });
    await writeFile(
      path.join(seed, '.github', 'workflows', 'ci.yml'),
      'on: push\n',
    );
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'main advances');
    git(seed, 'push', '-q', 'origin', 'main');
    git(seed, 'fetch', '-q', 'origin', 'agent-ci/docs');
    git(seed, 'checkout', '-q', '-b', 'docs', 'FETCH_HEAD');
    git(seed, 'merge', '-q', '--no-edit', 'main');
    git(seed, 'push', '-q', 'origin', 'docs:agent-ci/docs');
    const human = git(remote, 'rev-parse', 'refs/heads/agent-ci/docs');

    // With the docs policy: the deletions are outside it.
    const policed = await publishRun({
      ...base,
      outputs: docs(a),
      adoptBranch: true,
      pathPolicy: {
        name: 'docs-update',
        policy: PATH_POLICIES['docs-update'],
      },
    });
    expect(policed.ok ? 'ok' : policed.code).toBe('E_PATH_POLICY');
    expect(policed.ok ? '' : policed.message).toContain('src/new.ts');
    expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/docs')).toBe(human);
    // Without a policy, the workflow-file rule still sees the deletion.
    const unpoliced = await publishRun({
      ...base,
      outputs: docs(a),
      adoptBranch: true,
    });
    expect(unpoliced.ok ? 'ok' : unpoliced.code).toBe('E_PUBLISH');
    expect(unpoliced.ok ? '' : unpoliced.message).toContain(
      '.github/workflows/ci.yml',
    );
    expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/docs')).toBe(human);
  });

  it('checks an unchanged branch against the base the pull request will use, before any GitHub write (final H1 r2)', async () => {
    for (const variant of ['policy', 'workflow'] as const) {
      const { remote, clone, seed } = await remoteAndClone();
      // `release` carries a path the publish must not bring into `main`.
      git(seed, 'checkout', '-q', '-b', 'release');
      const extra =
        variant === 'policy' ? 'src/new.ts' : '.github/workflows/ci.yml';
      await mkdir(path.join(seed, path.dirname(extra)), { recursive: true });
      await writeFile(path.join(seed, extra), 'x\n');
      git(seed, 'add', '.');
      git(seed, 'commit', '-qm', 'release only');
      git(seed, 'push', '-q', 'origin', 'release');
      const releaseSha = git(seed, 'rev-parse', 'HEAD');
      const gh = fakeGitHub();
      const publish = (baseBranch: string, adoptBranch = false) =>
        publishRun({
          outputs: outputs(
            {},
            {
              version: 1,
              baseSha: releaseSha,
              files: [write('docs/new.md', 'n\n')],
            },
          ),
          github: gh.client,
          git: createGit(clone, { PATH: process.env.PATH }),
          pullRequest: true,
          branch: 'agent-ci/docs',
          baseBranch,
          author: ACTIONS_BOT,
          commentOn: 7,
          adoptBranch,
          ...(variant === 'policy'
            ? {
                pathPolicy: {
                  name: 'docs-update',
                  policy: PATH_POLICIES['docs-update'],
                },
              }
            : {}),
        });
      // Accepted: against release the diff is docs-only.
      const created = await publish('release');
      expect(created.ok && created.value.pull.action).toBe('created');
      // Accepted control: the same artifact again is unchanged.
      const unchanged = await publish('release');
      expect(unchanged.ok && unchanged.value.pull.action).toBe('unchanged');
      const head = git(remote, 'rev-parse', 'refs/heads/agent-ci/docs');
      const comments = gh.comments.get(7)?.length;
      // The same artifact and branch against main would carry `extra`:
      // refused before a pull request or comment is written, also when
      // the branch is adopted.
      for (const adopt of [false, true]) {
        const refused = await publish('main', adopt);
        expect(refused.ok ? 'ok' : refused.code).toBe(
          variant === 'policy' ? 'E_PATH_POLICY' : 'E_PUBLISH',
        );
        expect(refused.ok ? '' : refused.message).toContain(extra);
      }
      expect(gh.pulls.map((pull) => pull.base)).toEqual(['release']);
      expect(gh.comments.get(7)?.length).toBe(comments);
      expect(git(remote, 'rev-parse', 'refs/heads/agent-ci/docs')).toBe(head);
    }
  });

  it('validates --path-policy and --adopt values at the command boundary', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-pub-flags-'));
    for (const flags of [
      ['--path-policy', 'anything'],
      ['--adopt', 'yes'],
    ]) {
      const result = await run(
        ['publish', '--result-dir', dir, '--repo', 'o/r', ...flags],
        { cwd: dir, env: {}, log: () => undefined },
      );
      expect(result.envelope.ok ? 'ok' : result.envelope.code).toBe(
        'E_INVALID_INPUT',
      );
    }
  });
});

describe('publishRun', () => {
  it('creates then updates the pull request and one marked comment', async () => {
    const { clone } = await remoteAndClone();
    const baseSha = git(clone, 'rev-parse', 'HEAD');
    const gh = fakeGitHub();
    const changeSet: ChangeSet = {
      version: 1,
      baseSha,
      files: [write('docs/new.md', 'n\n')],
    };
    const options = {
      outputs: outputs({}, changeSet),
      github: gh.client,
      git: createGit(clone, { PATH: process.env.PATH }),
      pullRequest: true,
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      commentOn: 7,
      runUrl: 'https://gh/run/1',
      author: ACTIONS_BOT,
    };
    const first = await publishRun(options);
    expect(first.ok && first.value.pull).toMatchObject({
      action: 'created',
      number: 1,
    });
    expect(first.ok && first.value.comment).toMatchObject({
      action: 'created',
    });
    expect(gh.pulls[0]?.body).toContain('<!-- agent-ci:pr:agent-ci/docs -->');
    expect(gh.pulls[0]?.body).toContain('@​someone');
    // Model text cannot plant a second marker.
    const comment = gh.comments.get(7)?.[0]?.body ?? '';
    expect(comment.split('<!-- agent-ci:').length).toBe(2);
    expect(comment).toContain('**Pull request:** https://gh/pull/1');

    const second = await publishRun(options);
    expect(second.ok && second.value.pull).toMatchObject({
      action: 'unchanged',
      number: 1,
    });
    expect(second.ok && second.value.comment).toMatchObject({
      action: 'updated',
    });
    expect(gh.pulls).toHaveLength(1);
    expect(gh.comments.get(7)).toHaveLength(1);
  });

  it('never updates a marked comment written by someone else', async () => {
    const gh = fakeGitHub();
    gh.comments.set(7, [
      {
        id: 1,
        url: 'u',
        author: 'mallory',
        body: commentMarker('agent-ci/docs'),
      },
    ]);
    const report = await publishRun({
      outputs: outputs({ status: 'no-op', changedFiles: [] }),
      github: gh.client,
      pullRequest: true,
      branch: 'agent-ci/docs',
      baseBranch: 'main',
      commentOn: 7,
      author: ACTIONS_BOT,
    });
    expect(report.ok && report.value.pull).toEqual({
      action: 'skipped',
      reason: 'run status is no-op',
    });
    expect(report.ok && report.value.comment).toMatchObject({
      action: 'created',
    });
    expect(gh.comments.get(7)?.[0]?.body).toBe(commentMarker('agent-ci/docs'));
  });

  it('refuses inconsistent or unpublishable change sets', async () => {
    const gh = fakeGitHub();
    const base = {
      github: gh.client,
      git: createGit(os.tmpdir(), {}),
      pullRequest: true,
      branch: 'agent-ci/x',
      baseBranch: 'main',
      author: ACTIONS_BOT,
    };
    const sha = 'a'.repeat(40);
    const missing = await publishRun({ ...base, outputs: outputs({}, null) });
    expect(missing.ok ? 'ok' : missing.code).toBe('E_CHANGE_SET');
    const unlisted = await publishRun({
      ...base,
      outputs: outputs(
        {},
        { version: 1, baseSha: sha, files: [write('.env', 'x')] },
      ),
    });
    expect(unlisted.ok ? 'ok' : unlisted.code).toBe('E_CHANGE_SET');
    const workflow = await publishRun({
      ...base,
      outputs: outputs(
        { changedFiles: ['.github/workflows/ci.yml'] },
        {
          version: 1,
          baseSha: sha,
          files: [write('.github/workflows/ci.yml', 'x')],
        },
      ),
    });
    expect(workflow.ok ? 'ok' : workflow.code).toBe('E_PUBLISH');
    expect(gh.pulls).toHaveLength(0);
  });

  it('comments a failed run and publishes no pull request', async () => {
    const gh = fakeGitHub();
    const report = await publishRun({
      outputs: outputs({
        ok: false,
        status: 'failed',
        errors: ['E_HARNESS_AUTH: not logged in'],
      }),
      github: gh.client,
      pullRequest: true,
      branch: 'agent-ci/x',
      baseBranch: 'main',
      commentOn: 3,
      author: ACTIONS_BOT,
    });
    expect(report.ok && report.value.pull.action).toBe('skipped');
    expect(gh.comments.get(3)?.[0]?.body).toContain(
      '**Status:** failed (failed)',
    );
  });
});

const VALID_RESULT = {
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
};

describe('readRunOutputs', () => {
  it('reads the canonical directory and refuses links and malformed files', async () => {
    const dir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'agent-ci-out-')),
    );
    const out = path.join(dir, 'out');
    await mkdir(out);
    await writeFile(
      path.join(out, 'run-result.json'),
      JSON.stringify(VALID_RESULT),
    );
    const ok = await readRunOutputs(out);
    expect(ok.ok && ok.value.result.status).toBe('no-op');
    expect(ok.ok && ok.value.changeSet).toBeNull();

    // A link inside the repository on the way to the directory.
    const repo = path.join(dir, 'repo');
    await mkdir(repo);
    await symlink(out, path.join(repo, '.agent-ci'));
    const viaLink = await readRunOutputs(path.join(repo, '.agent-ci'), {
      workspaceRoot: repo,
    });
    expect(viaLink.ok ? 'ok' : viaLink.code).toBe('E_PUBLISH');

    // A linked result file is never followed.
    const linked = path.join(dir, 'linked');
    await mkdir(linked);
    await symlink(
      path.join(out, 'run-result.json'),
      path.join(linked, 'run-result.json'),
    );
    const leaf = await readRunOutputs(linked);
    expect(leaf.ok ? 'ok' : leaf.code).toBe('E_PUBLISH');

    await writeFile(
      path.join(out, 'changes.json'),
      '{"version":1,"baseSha":null,"files":[{"path":"../x","action":"delete"}]}',
    );
    const tampered = await readRunOutputs(out);
    expect(tampered.ok ? 'ok' : tampered.code).toBe('E_CHANGE_SET');

    await writeFile(path.join(out, 'run-result.json'), '{"ok":true}');
    const malformed = await readRunOutputs(out);
    expect(malformed.ok ? 'ok' : malformed.code).toBe('E_INVALID_RUN_RESULT');
    const empty = await readRunOutputs(path.join(dir, 'nothing'));
    expect(empty.ok ? 'ok' : empty.code).toBe('E_PUBLISH');
  });
});

describe('agent-ci publish', () => {
  it('publishes a real fake-harness edit run against a git remote and a GitHub API double', async () => {
    const { base, remote, clone } = await remoteAndClone();
    // A real fake-harness edit run produces the outputs.
    const work = path.join(base, 'work');
    git(base, 'clone', '-q', `file://${remote}`, work);
    const out = path.join(base, 'result');
    const ran = await run(
      [
        'run',
        '--model',
        'fake-edit',
        '--prompt',
        'Edit',
        '--mode',
        'edit',
        '--contract',
        'changes',
        '--out',
        out,
      ],
      { cwd: work, env: { PATH: process.env.PATH }, log: () => undefined },
    );
    expect(ran.envelope).toMatchObject({
      ok: true,
      data: { status: 'changed' },
    });

    const calls: { method: string; url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? 'GET',
        url,
        auth: headers.get('authorization'),
      });
      if (url.endsWith('/user')) return new Response('{}', { status: 403 });
      if (url.includes('/pulls?')) return Response.json([]);
      if (url.endsWith('/pulls')) {
        return Response.json({ number: 9, html_url: 'https://gh/pull/9' });
      }
      if (url.includes('/comments?')) return Response.json([]);
      return Response.json({
        id: 1,
        html_url: 'https://gh/c/1',
        user: { login: 'github-actions[bot]' },
      });
    }) as unknown as typeof fetch;
    const githubOutput = path.join(base, 'github-output');
    await writeFile(githubOutput, '');
    const command = createPublishCommand({ fetch: fakeFetch });
    const token = 'synthetic-github-token-0007';
    const data = (await command.run(
      [
        '--result-dir',
        out,
        '--cwd',
        clone,
        '--repo',
        'o/r',
        '--pr',
        '--base',
        'main',
        '--branch',
        'agent-ci/fake',
        '--comment-on',
        '4',
        '--github-output',
      ],
      {
        cwd: base,
        env: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: token,
          GITHUB_OUTPUT: githubOutput,
        },
        log: () => undefined,
      },
    )) as {
      pull: { action: string; url: string };
      comment: { action: string };
    };
    expect(data.pull).toMatchObject({
      action: 'created',
      url: 'https://gh/pull/9',
    });
    expect(data.comment.action).toBe('created');
    expect(
      git(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/agent-ci/fake'),
    ).toContain('agent-ci-fake-edit.md');
    expect(calls.every((call) => call.auth === `Bearer ${token}`)).toBe(true);
    expect(await readFile(githubOutput, 'utf8')).toContain(
      'pr_url=https://gh/pull/9\n',
    );
    expect(JSON.stringify(data)).not.toContain(token);
  });
});
