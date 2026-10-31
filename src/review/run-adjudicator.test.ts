import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ADJUDICATION_ANSWER_SCHEMA } from '@agent-ci/review/adjudicate.js';
import { quoteSha256 } from '@agent-ci/review/contracts.js';
import type { ReviewSpecDocument } from '@agent-ci/review/prepare.js';
import { runAdjudicator } from '@agent-ci/review/run-adjudicator.js';
import { type RunDeps, runAgent } from '@agent-ci/run/execute.js';
import {
  completedResponse,
  requestBody,
  responsesServer,
} from '@agent-ci/run/testing/responses.js';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

const KEY = 'synthetic-pool-value-0002';
const SHAS = {
  base_sha: 'a'.repeat(40),
  merge_base_sha: 'b'.repeat(40),
  head_sha: 'c'.repeat(40),
};
const spec: ReviewSpecDocument = {
  version: 1,
  request: {
    version: 1,
    mode: 'review',
    primary: { model: 'fake-review' },
    second: { enabled: false, model: 'fake-review' },
    adjudicator: { enabled: true, model: 'gpt-6.1-sol-low' },
    instruction: '',
  },
  request_id: 'd'.repeat(64),
  repository: 'fixture/project',
  pr_number: 1,
  base_ref: 'main',
  ...SHAS,
  guidance: {},
  diff: {
    truncated: false,
    files: 1,
    additions: 1,
    deletions: 0,
    sha256: 'e'.repeat(64),
  },
  changed_files: ['src/a.ts'],
  pr: { title: 'Change', body: '' },
};
const passes = [
  {
    pass: 'primary' as const,
    attempt: '1',
    review: {
      version: 1,
      mode: 'review',
      pass: 'primary',
      ...SHAS,
      summary: 'One finding',
      findings: [
        {
          id: 'm1',
          severity: 'medium',
          category: 'correctness',
          rule_id: null,
          title: 'Condition',
          body: 'Check this.',
          path: 'src/a.ts',
          line: 1,
          end_line: 1,
          side: 'RIGHT',
          original_code: 'const x = 1;',
          suggestion: null,
          evidence: [
            {
              kind: 'code',
              path: 'src/a.ts',
              line: 1,
              end_line: 1,
              side: 'RIGHT',
              quote_sha256: quoteSha256('const x = 1;'),
            },
          ],
        },
      ],
    },
  },
];
const kept = {
  candidate_id: 'primary-a1-m1',
  op: 'drop',
  to_severity: null,
  reason: { code: 'incorrect_claim', detail: 'The supplied line is constant.' },
  references: [{ path: 'src/a.ts', line: 1, end_line: 1, side: 'RIGHT' }],
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function scenario(handle: Parameters<typeof responsesServer>[0]) {
  const s = await responsesServer(handle);
  cleanup.push(s.close);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-direct-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const modelsPath = path.join(dir, 'models.yaml');
  await writeFile(modelsPath, stringify({ version: 1, routes: [s.route] }));
  const options = {
    spec,
    passes,
    failOnSeverity: null,
    read: () => 'const x = 1;',
    outDir: path.join(dir, 'out'),
    allowPool: true,
    timeoutMs: 60_000,
    modelsPath,
    env: {
      PATH: process.env.PATH,
      AGENT_CI_CREDENTIAL: KEY,
      AGENT_CI_PROXY_BASE_URL: s.origin,
    },
    credentialFromEnv: true,
  };
  return { ...s, dir, options };
}
async function persisted(dir: string) {
  return (
    await Promise.all(
      (
        await readdir(dir)
      ).map((name) => readFile(path.join(dir, name), 'utf8')),
    )
  ).join('\n');
}
const noCli: RunDeps = {
  harness: {
    spawn: () => {
      throw new Error('unexpected CLI launch');
    },
  },
};

describe('Sol Low adjudicator run lifecycle', () => {
  it('repairs once with bounded local context, identical posture and summed usage, without session resume', async () => {
    const requests: Record<string, unknown>[] = [];
    const auth: unknown[] = [];
    const s = await scenario((req, res) => {
      void requestBody(req).then((body) => {
        requests.push(body);
        auth.push(req.headers.authorization);
        res.end(
          JSON.stringify(
            completedResponse(
              requests.length === 1 ? { wrong: true } : { operations: [] },
            ),
          ),
        );
      });
    });
    const result = await runAdjudicator(s.options, noCli);
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'completed',
        harness: 'codex',
        transport: 'adjudicator-responses',
        repair: 'repaired',
        usage: { inputTokens: 24, outputTokens: 8, cacheReadTokens: 4 },
      },
    });
    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect({ ...second, input: first?.input }).toEqual(first);
    expect(auth).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
    expect(JSON.parse(second?.input as string)).toMatchObject({
      original_prompt: first?.input,
      previous_answer: '{"wrong":true}',
      repair_instruction: expect.any(String),
    });
    expect(
      await readFile(
        path.join(s.options.outDir, 'adjudication-answer.json'),
        'utf8',
      ),
    ).toContain('"operations": []');
    const log = await readFile(
      path.join(s.options.outDir, 'run-log.jsonl'),
      'utf8',
    );
    expect(log).toContain('"transport":"adjudicator-responses"');
    expect(log).not.toContain('resp_synthetic');
    expect(await persisted(s.options.outDir)).not.toContain(KEY);
    expect(await persisted(s.options.outDir)).not.toContain(s.origin);
  });

  it('keeps the first answer’s allowed partial operations if its single repair is malformed', async () => {
    let requests = 0;
    const s = await scenario((_req, res) => {
      const response = completedResponse({
        operations: [kept, { ...kept, candidate_id: 'unknown' }],
      });
      if (++requests === 2) response.output[0]!.content[0]!.text = '{';
      res.end(JSON.stringify(response));
    });
    const result = await runAdjudicator(s.options, noCli);
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'completed', repair: 'repair-failed' },
    });
    expect(requests).toBe(2);
    expect(
      JSON.parse(
        await readFile(
          path.join(s.options.outDir, 'adjudication.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ operations: [kept] });
  });

  it.each(['key', 'origin', 'hostname', 'repair'] as const)(
    'withholds all accepted artifacts for a %s echo',
    async (echo) => {
      let requests = 0;
      const s = await scenario((_req, res) => {
        requests++;
        const value =
          echo === 'key' || echo === 'repair'
            ? KEY
            : echo === 'origin'
              ? s.origin
              : '127.0.0.1';
        // An unknown field the semantic acceptor would strip must still fail.
        res.end(
          JSON.stringify(
            completedResponse(
              echo === 'repair' && requests === 1
                ? { operations: [kept, { ...kept, candidate_id: 'unknown' }] }
                : { operations: [], ignored: value },
            ),
          ),
        );
      });
      const result = await runAdjudicator(s.options, noCli);
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: 'failed',
          reason: expect.stringContaining('E_CREDENTIAL_LEAK'),
        },
      });
      expect(requests).toBe(echo === 'repair' ? 2 : 1);
      expect(
        existsSync(path.join(s.options.outDir, 'adjudication-answer.json')),
      ).toBe(false);
      expect(
        JSON.parse(
          await readFile(
            path.join(s.options.outDir, 'adjudication.json'),
            'utf8',
          ),
        ),
      ).toEqual({ version: 1, status: 'failed', operations: [] });
      const outputs = await persisted(s.options.outDir);
      for (const secret of [KEY, s.origin, '127.0.0.1'])
        expect(outputs).not.toContain(secret);
    },
  );

  it.each([401, 503])(
    'retries only transient status %s on the same route',
    async (status) => {
      let hits = 0;
      const s = await scenario((_req, res) => {
        hits++;
        res.writeHead(hits === 1 ? status : 200);
        res.end(
          hits === 1 ? 'opaque failure' : JSON.stringify(completedResponse()),
        );
      });
      const result = await runAdjudicator(s.options, {
        ...noCli,
        sleep: async () => {},
      });
      expect(result).toMatchObject({
        ok: true,
        value: { status: status === 401 ? 'failed' : 'completed' },
      });
      expect(hits).toBe(status === 401 ? 1 : 2);
    },
  );

  it('does not start a retry that cannot fit the total deadline and backoff', async () => {
    let hits = 0;
    const s = await scenario((_req, res) => {
      hits++;
      res.writeHead(503);
      res.end();
    });
    const result = await runAdjudicator(
      { ...s.options, timeoutMs: 500 },
      noCli,
    );
    expect(result).toMatchObject({ ok: true, value: { status: 'failed' } });
    expect(hits).toBe(1);
    expect(await persisted(s.options.outDir)).toContain(
      '"stopReason":"deadline"',
    );
  });

  it('revalidates the route before runtime dispatch and leaves ordinary Codex noTools refused', async () => {
    let hits = 0;
    const s = await scenario((_req, res) => {
      hits++;
      res.end(JSON.stringify(completedResponse()));
    });
    await writeFile(
      s.options.modelsPath,
      stringify({ version: 1, routes: [{ ...s.route, effort: 'high' }] }),
    );
    expect(await runAdjudicator(s.options, noCli)).toMatchObject({
      ok: false,
      code: 'E_POLICY_HARNESS',
    });
    // Bypass the review wrapper: the run core must re-check independently.
    const generic = {
      routeId: s.route.id,
      prompt: 'Decide.',
      cwd: s.dir,
      outDir: path.join(s.dir, 'generic'),
      outputContract: 'report' as const,
      useCase: 'test',
      targetRepo: spec.repository,
      mode: 'read-only' as const,
      allowPool: true,
      seedLogin: false,
      timeoutMs: 60_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      modelsPath: s.options.modelsPath,
      env: { AGENT_CI_PROXY_API_KEY: KEY },
      structured: {
        schema: ADJUDICATION_ANSWER_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        accept: (value: unknown) => ({ ok: true as const, value }),
        repairPrompt: () => 'Repair.',
        outputFile: 'adjudication-answer.json',
        describe: () => 'Done.',
        noTools: true,
      },
    };
    expect(
      await runAgent(
        {
          ...generic,
          structured: {
            ...generic.structured,
            adjudicatorTransport: 'adjudicator-responses',
          },
        },
        noCli,
      ),
    ).toMatchObject({ ok: false, code: 'E_POLICY_HARNESS' });
    await writeFile(
      s.options.modelsPath,
      stringify({ version: 1, routes: [s.route] }),
    );
    expect(await runAgent(generic, noCli)).toMatchObject({
      ok: false,
      code: 'E_POLICY_HARNESS',
    });
    expect(hits).toBe(0);
  });

  it('spends nothing for no reducible candidates, even without credentials', async () => {
    let hits = 0;
    const s = await scenario((_req, res) => {
      hits++;
      res.end();
    });
    expect(
      await runAdjudicator({ ...s.options, passes: [], env: {} }, noCli),
    ).toMatchObject({
      ok: true,
      value: { status: 'skipped', transport: null, usage: null },
    });
    expect(hits).toBe(0);
  });
});
