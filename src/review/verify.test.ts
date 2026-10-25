import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type ChecksEvidence,
  checkEvidenceId,
  parseChecksConfig,
  validateChecksEvidence,
  verifySpecFromText,
} from '@agent-ci/review/checks.js';
import { sha256 } from '@agent-ci/review/contracts.js';
import type {
  LoadedSpec,
  ReviewSpecDocument,
} from '@agent-ci/review/prepare.js';
import {
  buildCheckEnv,
  controlledPath,
  detectIsolation,
  execCommand,
  isolatedArgv,
  runVerify,
  sandboxProfile,
} from '@agent-ci/review/verify.js';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = 'tkstang/app';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

const one = (check: string) =>
  `version: 1\nchecks:\n  - name: ${check}\n    command: pnpm test\n`;

describe('checks.yaml', () => {
  it('accepts named checks with defaults and an optional setup', () => {
    expect(
      parseChecksConfig(
        [
          'version: 1',
          'setup:',
          '  command: pnpm install --frozen-lockfile',
          'checks:',
          '  - name: test',
          '    command: pnpm test',
          '    description: unit tests',
          '    timeout_minutes: 20',
          '  - name: lint',
          '    command: pnpm lint',
        ].join('\n'),
      ),
    ).toEqual({
      version: 1,
      setup: { command: 'pnpm install --frozen-lockfile', timeout_minutes: 10 },
      checks: [
        {
          name: 'test',
          command: 'pnpm test',
          description: 'unit tests',
          timeout_minutes: 20,
        },
        {
          name: 'lint',
          command: 'pnpm lint',
          description: '',
          timeout_minutes: 10,
        },
      ],
    });
  });

  it('refuses malformed, oversized and ambiguous configurations', () => {
    const bad = [
      'version: 2\nchecks: []\n',
      'version: 1\nchecks: []\n',
      one('Test'),
      one('rm -rf'),
      'version: 1\nchecks:\n  - name: a\n    command: x\n  - name: a\n    command: y\n',
      'version: 1\nchecks:\n  - name: a\n    command: x\n    shell: zsh\n',
      'version: 1\nchecks:\n  - name: a\n    command: ""\n',
      'version: 1\nchecks:\n  - name: a\n    command: x\n    timeout_minutes: 31\n',
      `version: 1\nchecks:\n${Array.from({ length: 11 }, (_, i) => `  - name: c${i}\n    command: x\n`).join('')}`,
      'version: 1\nbase: &b {name: a, command: x}\nchecks: [*b]\n',
      `version: 1\nchecks:\n  - name: a\n    command: ${'x'.repeat(70_000)}\n`,
      'version: 1\nchecks:\n  - name: a\n    command: x\n    description: "a\\u202eb"\n',
      ': not yaml : [',
    ];
    for (const text of bad) {
      expect(() => parseChecksConfig(text), text.slice(0, 60)).toThrow(
        expect.objectContaining({ code: 'E_VERIFY_CONFIG' }),
      );
    }
  });
});

const HEAD = 'a'.repeat(40);
const CONFIG_TEXT =
  'version: 1\nchecks:\n  - name: test\n    command: pnpm test\n  - name: lint\n    command: pnpm lint\n';

function evidence(): ChecksEvidence {
  const entry = (name: string, command: string, exit: number) => {
    const outputSha = sha256(`${name} output`);
    return {
      evidence_id: checkEvidenceId({
        name,
        command,
        head_sha: HEAD,
        exit_code: exit,
        output_sha256: outputSha,
      }),
      name,
      command,
      exit_code: exit,
      timed_out: false,
      truncated: false,
      output_sha256: outputSha,
      output_tail: `${name} output`,
      duration_ms: 5,
      isolation: 'none' as const,
    };
  };
  return {
    version: 1,
    repository: REPO,
    head_sha: HEAD,
    config_sha256: sha256(CONFIG_TEXT),
    status: 'complete',
    setup: null,
    entries: [entry('test', 'pnpm test', 1), entry('lint', 'pnpm lint', 0)],
  };
}

describe('check evidence', () => {
  const expected = {
    repository: REPO,
    head_sha: HEAD,
    verify: verifySpecFromText(CONFIG_TEXT),
  };

  it('derives the evidence id from name, command, head, exit code and output digest', () => {
    const input = {
      name: 'test',
      command: 'pnpm test',
      head_sha: HEAD,
      exit_code: 1,
      output_sha256: sha256('x'),
    };
    const id = checkEvidenceId(input);
    expect(id).toMatch(/^check-[0-9a-f]{24}$/u);
    expect(checkEvidenceId({ ...input })).toBe(id);
    for (const change of [
      { name: 'lint' },
      { command: 'pnpm test --all' },
      { head_sha: 'b'.repeat(40) },
      { exit_code: 0 },
      { exit_code: null },
      { output_sha256: sha256('y') },
    ])
      expect(checkEvidenceId({ ...input, ...change })).not.toBe(id);
  });

  it('accepts a bound evidence file and refuses tampered, rebound or reordered ones', () => {
    expect(validateChecksEvidence(evidence(), expected).entries).toHaveLength(
      2,
    );
    const tamper = (mutate: (value: ChecksEvidence) => void) => {
      const value = structuredClone(evidence());
      mutate(value);
      return () => validateChecksEvidence(value, expected);
    };
    const refusals = [
      // A passing exit code swapped in without recomputing the id.
      tamper((v) => {
        v.entries[0]!.exit_code = 0;
      }),
      tamper((v) => {
        v.entries[1]!.evidence_id = v.entries[0]!.evidence_id;
      }),
      tamper((v) => {
        v.head_sha = 'b'.repeat(40);
      }),
      tamper((v) => {
        v.config_sha256 = sha256('other');
      }),
      tamper((v) => {
        v.entries.reverse();
      }),
      tamper((v) => {
        v.entries.pop();
      }),
      tamper((v) => {
        v.entries[0]!.command = 'true';
      }),
      tamper((v) => {
        (v as unknown as Record<string, unknown>).extra = 1;
      }),
      tamper((v) => {
        v.status = 'setup-failed';
      }),
      tamper((v) => {
        (v.entries[0] as unknown as Record<string, unknown>).isolation = 'vm';
      }),
    ];
    for (const refuse of refusals)
      expect(refuse).toThrow(
        expect.objectContaining({ code: 'E_VERIFY_EVIDENCE' }),
      );
  });
});

describe('controlled environment', () => {
  it('passes only allowlisted variables and never a credential, with a scratch HOME', () => {
    const env = buildCheckEnv({
      source: {
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        CI: 'true',
        GITHUB_TOKEN: 'ghs_x',
        GH_TOKEN: 'x',
        ANTHROPIC_API_KEY: 'x',
        ANTHROPIC_AUTH_TOKEN: 'x',
        CLAUDE_CODE_OAUTH_TOKEN: 'x',
        OPENCODE_API_KEY: 'x',
        CURSOR_API_KEY: 'x',
        AGENT_CI_CREDENTIAL: 'x',
        AGENT_CI_PROXY_API_KEY: 'x',
        AGENT_CI_SOURCE_TOKEN: 'x',
        ACTIONS_RUNTIME_TOKEN: 'x',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x',
        AWS_SECRET_ACCESS_KEY: 'x',
        GITHUB_OUTPUT: '/tmp/out',
        GITHUB_ENV: '/tmp/env',
        HOME: '/Users/operator',
        CODEX_HOME: '/Users/operator/.codex',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        NPM_CONFIG_USERCONFIG: '/Users/operator/.npmrc',
      },
      home: '/work/home',
      excludedPaths: ['/work'],
    });
    expect(Object.keys(env).toSorted()).toEqual(
      [
        'CI',
        'COREPACK_ENABLE_DOWNLOAD_PROMPT',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'HOME',
        'LANG',
        'PATH',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
      ].toSorted(),
    );
    expect(env.HOME).toBe('/work/home');
  });

  it('drops PATH entries inside the checkout or the copies, and relative ones', () => {
    expect(
      controlledPath(
        '/checkout/node_modules/.bin:/usr/bin:relative/bin:/work/prepared/bin:/checkout:/opt/node/bin:/usr/bin:/checkout-sibling/bin',
        ['/checkout', '/work'],
      ),
    ).toBe('/usr/bin:/opt/node/bin:/checkout-sibling/bin');
  });

  it('kills the whole process group when the shell exits, and at the deadline', async () => {
    const dir = await tempDir('agent-ci-exec-');
    const marker = path.join(dir, 'survived');
    const result = await execCommand({
      argv: ['/bin/bash', '-c', `(sleep 2; touch ${marker}) & echo started`],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 60_000,
      maxBytes: 1024,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output.toString()).toBe('started\n');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(existsSync(marker)).toBe(false);

    const slow = await execCommand({
      argv: ['/bin/bash', '-c', 'sleep 30'],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 300,
      maxBytes: 1024,
    });
    expect(slow).toMatchObject({ exitCode: null, timedOut: true });
  }, 20_000);

  it('caps the captured output', async () => {
    const dir = await tempDir('agent-ci-exec-');
    const result = await execCommand({
      argv: ['/bin/bash', '-c', 'head -c 5000 /dev/zero | tr "\\0" x'],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
      maxBytes: 1000,
    });
    expect(result.output.length).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it('wraps checks in loopback-only namespaces on Linux and a no-network sandbox on macOS', () => {
    expect(
      isolatedArgv({
        isolation: 'linux-namespaces',
        command: 'pnpm test',
        network: false,
      }),
    ).toEqual([
      'unshare',
      '--user',
      '--map-root-user',
      '--pid',
      '--fork',
      '--kill-child',
      '--net',
      '--',
      '/bin/bash',
      '-c',
      'ip link set lo up >/dev/null 2>&1 || true; exec /bin/bash -c "$1"',
      'agent-ci-check',
      'pnpm test',
    ]);
    expect(
      isolatedArgv({
        isolation: 'linux-namespaces',
        command: 'pnpm i',
        network: true,
      }),
    ).not.toContain('--net');
    const profile = sandboxProfile({
      work: '/w',
      denied: ['/out', '/Users/me/.ssh'],
      homeParents: ['/tmp'],
      network: false,
    });
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(allow file-write* (subpath "/w")');
    expect(profile).toContain('(deny file-read* file-write* (subpath "/out"))');
    expect(profile).toContain('(regex "^/tmp/agent-ci-home-")');
    expect(profile).toContain('(deny network*)');
    expect(
      sandboxProfile({
        work: '/w',
        denied: [],
        homeParents: [],
        network: true,
      }),
    ).not.toContain('network');
    expect(
      isolatedArgv({ isolation: 'none', command: 'x', network: false }),
    ).toEqual(['/bin/bash', '-c', 'x']);
  });
});

/** A checkout at a head commit plus a verify spec for it. */
async function verifyScenario(configText: string) {
  const root = await tempDir('agent-ci-verify-test-');
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'bin'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), '# app\n');
  // A tool the checkout could try to put first on PATH.
  await writeFile(
    path.join(repo, 'bin', 'pnpm'),
    '#!/bin/sh\necho shadowed\n',
    {
      mode: 0o755,
    },
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  const spec: ReviewSpecDocument = {
    version: 1,
    request: {
      version: 1,
      mode: 'verify-review',
      primary: { model: 'fake-verify-review' },
      second: { enabled: false, model: 'fake-verify-review' },
      adjudicator: { enabled: false, model: 'fake-adjudicate' },
      instruction: '',
    },
    request_id: 'd'.repeat(64),
    repository: REPO,
    pr_number: 7,
    base_ref: 'main',
    base_sha: head,
    merge_base_sha: head,
    head_sha: head,
    guidance: {},
    diff: {
      truncated: false,
      files: 0,
      additions: 0,
      deletions: 0,
      sha256: sha256(''),
    },
    changed_files: [],
    pr: { title: 't', body: '' },
    verify: verifySpecFromText(configText),
  };
  const loaded: LoadedSpec = { spec, diffText: '' };
  return { root, repo, head, spec: loaded, out: path.join(root, 'out') };
}

describe('runVerify', () => {
  it('runs each check in a fresh copy with no credential, no .git and a PATH without the checkout', async () => {
    const config = [
      'version: 1',
      'setup:',
      '  command: echo prepared > setup.txt',
      'checks:',
      '  - name: env',
      '    command: env | sort',
      '  - name: tree',
      '    command: ls -a; test -e .git && echo has-git || echo no-git; echo leak > written.txt; command -v pnpm || echo no-pnpm-shadow',
      '  - name: again',
      '    command: test -e written.txt && echo saw-previous || echo fresh; cat setup.txt',
    ].join('\n');
    const s = await verifyScenario(config);
    const ran = await runVerify(
      {
        cwd: s.repo,
        spec: s.spec,
        outDir: s.out,
        env: {
          PATH: `${path.join(s.repo, 'bin')}:/usr/bin:/bin`,
          LANG: 'C',
          ANTHROPIC_AUTH_TOKEN: 'synthetic-secret-value-123',
          GITHUB_TOKEN: 'synthetic-github-token-value',
          HOME: '/Users/operator',
        },
      },
      { isolation: 'none' },
    );
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    const recorded = ran.value.evidence;
    expect(recorded.status).toBe('complete');
    expect(recorded.setup?.exit_code).toBe(0);
    const [env, tree, again] = recorded.entries;
    expect(env?.output_tail).not.toContain('synthetic');
    expect(env?.output_tail).not.toContain('/Users/operator');
    expect(env?.output_tail).not.toContain(path.join(s.repo, 'bin'));
    expect(tree?.output_tail).toContain('no-git');
    expect(tree?.output_tail).toContain('setup.txt');
    expect(tree?.output_tail).not.toContain('shadowed');
    expect(again?.output_tail).toContain('fresh');
    expect(again?.output_tail).toContain('prepared');
    // The checkout itself is never written.
    expect(git(s.repo, 'status', '--porcelain')).toBe('');
    // The written file validates against the same spec.
    const text = await readFile(ran.value.evidencePath, 'utf8');
    expect(
      validateChecksEvidence(JSON.parse(text), {
        repository: REPO,
        head_sha: s.head,
        verify: s.spec.spec.verify!,
      }).entries.map((e) => e.name),
    ).toEqual(['env', 'tree', 'again']);
  }, 30_000);

  it('records a failed setup and runs no check', async () => {
    const s = await verifyScenario(
      'version: 1\nsetup:\n  command: echo nope; exit 3\nchecks:\n  - name: test\n    command: echo never\n',
    );
    const ran = await runVerify(
      {
        cwd: s.repo,
        spec: s.spec,
        outDir: s.out,
        env: { PATH: '/usr/bin:/bin' },
      },
      { isolation: 'none' },
    );
    expect(ran.ok && ran.value.evidence).toMatchObject({
      status: 'setup-failed',
      setup: { exit_code: 3 },
      entries: [],
    });
  });

  it('refuses a checkout at another head and an output directory inside the checkout', async () => {
    const s = await verifyScenario(
      'version: 1\nchecks:\n  - name: test\n    command: "true"\n',
    );
    const inside = await runVerify(
      {
        cwd: s.repo,
        spec: s.spec,
        outDir: path.join(s.repo, 'out'),
        env: { PATH: '/usr/bin:/bin' },
      },
      { isolation: 'none' },
    );
    expect(inside).toMatchObject({ ok: false, code: 'E_OUTPUT_PATH' });
    await writeFile(path.join(s.repo, 'more.txt'), 'x');
    git(s.repo, 'add', '.');
    git(s.repo, 'commit', '-qm', 'moved');
    const moved = await runVerify(
      {
        cwd: s.repo,
        spec: s.spec,
        outDir: s.out,
        env: { PATH: '/usr/bin:/bin' },
      },
      { isolation: 'none' },
    );
    expect(moved).toMatchObject({ ok: false, code: 'E_REVIEW_STALE_HEAD' });
  });

  const isolation = detectIsolation();
  it.runIf(isolation !== 'none')(
    `contains checks on this host (${isolation}): no outside network, no writes outside the run, no reads of protected paths`,
    async () => {
      const s = await verifyScenario(
        [
          'version: 1',
          'checks:',
          '  - name: net',
          `    command: node -e "require('net').connect(53,'1.1.1.1').on('error',e=>{console.log('neterr',e.code);process.exit(3)}).on('connect',()=>{console.log('connected');process.exit(0)}).setTimeout(4000,()=>{console.log('neterr timeout');process.exit(4)})"`,
          '  - name: write',
          '    command: echo x > "$OUTSIDE/escape.txt" && echo wrote || echo write-denied',
          '  - name: read',
          '    command: cat "$PROTECTED/token" || echo read-denied',
          '  - name: background',
          '    command: (sleep 2; echo late > "$OUTSIDE/late.txt") & disown; setsid sleep 0 2>/dev/null; echo started',
        ].join('\n'),
      );
      const outside = await tempDir('agent-ci-outside-');
      const protectedDir = await tempDir('agent-ci-protected-');
      await writeFile(path.join(protectedDir, 'token'), 'synthetic-protected');
      // The command reads OUTSIDE and PROTECTED from its own text: pass them
      // as allowlisted-free literals by rewriting the config commands.
      const verify = s.spec.spec.verify!;
      for (const check of verify.config.checks)
        check.command = check.command
          .replaceAll('$OUTSIDE', outside)
          .replaceAll('$PROTECTED', protectedDir);
      const ran = await runVerify({
        cwd: s.repo,
        spec: s.spec,
        outDir: s.out,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        protectedPaths: [protectedDir],
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) return;
      const byName = new Map(
        ran.value.evidence.entries.map((e) => [e.name, e]),
      );
      expect(byName.get('net')?.isolation).toBe(isolation);
      expect(byName.get('net')?.output_tail).toContain('neterr');
      if (isolation === 'macos-sandbox') {
        expect(byName.get('write')?.output_tail).toContain('write-denied');
        expect(byName.get('read')?.output_tail).toContain('read-denied');
        expect(existsSync(path.join(outside, 'escape.txt'))).toBe(false);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (isolation === 'linux-namespaces')
        expect(existsSync(path.join(outside, 'late.txt'))).toBe(false);
    },
    60_000,
  );
});
