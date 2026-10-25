import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { digestResultDir } from '@agent-ci/publish/digest.js';
import { verifySpecFromText } from '@agent-ci/review/checks.js';
import {
  REVIEW_WORKFLOW,
  sha256,
  validateGatedReview,
} from '@agent-ci/review/contracts.js';
import { gateArtifacts, loadPassDir } from '@agent-ci/review/findings.js';
import { loadSpecDir, runReviewPass } from '@agent-ci/review/pass.js';
import { SPEC_FILES } from '@agent-ci/review/prepare.js';
import { renderFindingBody, renderSummary } from '@agent-ci/review/render.js';
import { gitSourceReader } from '@agent-ci/review/sources.js';
import { runVerify } from '@agent-ci/review/verify.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * verify-review end to end with the credential-free fake harness: the
 * verify stage records real checks, the reviewer pass serves them through
 * the real run_check MCP server (the fake CLI calls it over stdio), and the
 * findings gate admits only citations of ids the pass served.
 */

const REPO = 'tkstang/app';
const MODELS = `version: 1
routes:
  - id: fake-verify-review
    model: fake-verify-review
    harness: fake
    family: fake
    providerModel: verify-review
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
  - id: fake-verify-review-forged
    model: fake-verify-review-forged
    harness: fake
    family: fake
    providerModel: verify-review-forged
    billing: none
    account: personal
    structuredOutput: prompt
    qualified: null
`;
const CONFIG =
  'version: 1\nchecks:\n  - name: test\n    command: echo "1 failing"; exit 1\n    description: unit tests\n  - name: lint\n    command: echo clean\n';
const identity = {
  repository: REPO,
  workflow: REVIEW_WORKFLOW,
  pr_number: 7,
  scope: 'default',
  run_id: '500',
  run_attempt: '1',
};
const POLICY = { fail_on_severity: null, floor: 'medium', budget: 10 } as const;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

async function scenario(model = 'fake-verify-review') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-verify-pipe-'));
  dirs.push(root);
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'src', 'cache.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(
    path.join(repo, 'src', 'cache.ts'),
    'export const a = 1;\nexport const added = load();\n',
  );
  git(repo, 'commit', '-qam', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  const diff = `${git(repo, 'diff', '--no-color', `${base}...${head}`)}\n`;
  const modelsPath = path.join(root, 'models.yaml');
  await writeFile(modelsPath, MODELS);
  const spec = {
    version: 1,
    request: {
      version: 1,
      mode: 'verify-review',
      primary: { model },
      second: { enabled: false, model },
      adjudicator: { enabled: false, model },
      instruction: '',
    },
    request_id: 'd'.repeat(64),
    repository: REPO,
    pr_number: 7,
    base_ref: 'main',
    base_sha: base,
    merge_base_sha: base,
    head_sha: head,
    guidance: {},
    diff: {
      truncated: false,
      files: 1,
      additions: 1,
      deletions: 0,
      sha256: sha256(diff),
    },
    changed_files: ['src/cache.ts'],
    pr: { title: 'Add load', body: '' },
    verify: verifySpecFromText(CONFIG),
  };
  const specDir = path.join(root, 'spec');
  await mkdir(specDir);
  const specText = `${JSON.stringify(spec, null, 2)}\n`;
  await writeFile(path.join(specDir, SPEC_FILES.spec), specText);
  await writeFile(path.join(specDir, SPEC_FILES.diff), diff);
  const loaded = await loadSpecDir({
    dir: specDir,
    specSha256: sha256(specText),
    repository: REPO,
  });
  // The verify stage, exactly as the verify job runs it (no isolation here
  // so the test behaves the same on every host).
  const checksDir = path.join(root, 'checks');
  const verified = await runVerify(
    {
      cwd: repo,
      spec: loaded,
      outDir: checksDir,
      env: { PATH: process.env.PATH },
    },
    { isolation: 'none' },
  );
  if (!verified.ok) throw new Error(verified.message);
  const checksDigest = await digestResultDir(checksDir);
  if (!checksDigest.ok) throw new Error(checksDigest.message);
  return {
    root,
    repo,
    base,
    head,
    modelsPath,
    spec: loaded,
    checksDir,
    checksDigest: checksDigest.value,
    evidence: verified.value.evidence,
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

function runPass(s: Scenario, overrides: { checksDigest?: string } = {}) {
  return runReviewPass({
    pass: 'primary',
    spec: s.spec,
    cwd: s.repo,
    outDir: path.join(s.root, 'out-primary'),
    allowPool: false,
    seedLogin: false,
    timeoutMs: 60_000,
    maxAttempts: 1,
    retryDelayMs: 0,
    modelsPath: s.modelsPath,
    env: { PATH: process.env.PATH },
    credentialFromEnv: false,
    checksDir: s.checksDir,
    checksDigest: overrides.checksDigest ?? s.checksDigest,
  });
}

async function gate(s: Scenario) {
  const dir = path.join(s.root, 'out-primary');
  const digest = await digestResultDir(dir);
  if (!digest.ok) throw new Error(digest.message);
  const primary = await loadPassDir({
    pass: 'primary',
    dir,
    digest: digest.value,
  });
  return validateGatedReview(
    gateArtifacts({
      spec: s.spec,
      identity,
      attempt: '1',
      passes: [primary],
      adjudication: null,
      read: gitSourceReader(s.repo, { RIGHT: s.head, LEFT: s.base }),
      posted: [],
      policy: POLICY,
    }),
    identity,
  );
}

describe('verify-review pipeline (fake harness, real bridge)', () => {
  it('serves recorded checks through run_check and gates the cited evidence', async () => {
    const s = await scenario();
    const test = s.evidence.entries.find((e) => e.name === 'test');
    expect(test).toMatchObject({ exit_code: 1, isolation: 'none' });
    const ran = await runPass(s);
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.value.record).toMatchObject({
      ok: true,
      repair: 'not-needed',
      // The fake CLI called the bridge for the first listed check.
      checks_served: ['test'],
    });
    const review = JSON.parse(
      await readFile(ran.value.reviewPath ?? '', 'utf8'),
    ) as { mode: string; findings: Array<{ evidence: unknown[] }> };
    expect(review.mode).toBe('verify-review');
    expect(review.findings[0]?.evidence).toContainEqual({
      kind: 'check',
      evidence_id: test?.evidence_id,
    });
    // The pass kept the validated checks it served, for the gate.
    expect(
      JSON.parse(
        await readFile(path.join(s.root, 'out-primary', 'checks.json'), 'utf8'),
      ),
    ).toEqual(s.evidence);

    const gated = await gate(s);
    expect(gated.review_status).toBe('complete');
    expect(gated.findings).toHaveLength(1);
    expect(gated.findings[0]?.evidence).toContainEqual({
      kind: 'check',
      evidence_id: test?.evidence_id,
      name: 'test',
      exit_code: 1,
    });
    expect(gated.checks?.entries.map((e) => [e.name, e.exit_code])).toEqual([
      ['test', 1],
      ['lint', 0],
    ]);
    const body = renderFindingBody(gated.findings[0]!, identity);
    expect(body).toContain('check ` test ` (exit 1, ` check-');
    const summary = renderSummary(gated);
    expect(summary).toContain('### Checks');
    expect(summary).toContain('| ` test ` | exit 1 | ` none ` |');
  }, 60_000);

  it('drops a finding that cites an evidence id the bridge never returned', async () => {
    const s = await scenario('fake-verify-review-forged');
    const ran = await runPass(s);
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    // The strict first answer earned the repair turn; the lenient last
    // chance kept the repaired envelope, and the gate drops the citation.
    expect(ran.value.record.repair).toBe('repaired');
    const gated = await gate(s);
    expect(gated.findings).toHaveLength(0);
    expect(gated.candidates[0]?.disposition).toBe(
      'invalid:evidence_unknown_check',
    );
  }, 60_000);

  it('refuses checks that do not match their digest or were altered', async () => {
    const s = await scenario();
    const wrongDigest = await runPass(s, { checksDigest: 'f'.repeat(64) });
    expect(wrongDigest).toMatchObject({ ok: false, code: 'E_VERIFY_EVIDENCE' });
    // An exit code flipped without recomputing the id, re-digested.
    const file = path.join(s.checksDir, 'checks.json');
    const value = JSON.parse(await readFile(file, 'utf8')) as {
      entries: Array<{ exit_code: number }>;
    };
    value.entries[0]!.exit_code = 0;
    await writeFile(file, JSON.stringify(value));
    const digest = await digestResultDir(s.checksDir);
    if (!digest.ok) throw new Error(digest.message);
    const altered = await runPass(s, { checksDigest: digest.value });
    expect(altered).toMatchObject({ ok: false, code: 'E_VERIFY_EVIDENCE' });
  }, 60_000);

  it('treats a pass check copy that fails validation as no evidence', async () => {
    const s = await scenario();
    const ran = await runPass(s);
    expect(ran.ok).toBe(true);
    const copy = path.join(s.root, 'out-primary', 'checks.json');
    const value = JSON.parse(await readFile(copy, 'utf8')) as {
      head_sha: string;
    };
    value.head_sha = 'f'.repeat(40);
    await writeFile(copy, JSON.stringify(value));
    const gated = await gate(s);
    expect(gated.checks).toBeNull();
    expect(gated.candidates[0]?.disposition).toBe(
      'invalid:evidence_check_unavailable',
    );
  }, 60_000);
});
