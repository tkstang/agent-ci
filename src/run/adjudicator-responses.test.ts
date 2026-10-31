import { DEFAULT_MAX_OUTPUT_BYTES } from '@agent-ci/harness/spawn.js';
import { runAdjudicatorResponses } from '@agent-ci/run/adjudicator-responses.js';
import {
  completedResponse,
  requestBody,
  responsesServer,
} from '@agent-ci/run/testing/responses.js';
import { afterEach, describe, expect, it } from 'vitest';

const KEY = 'synthetic-pool-value-0001';
const servers: Awaited<ReturnType<typeof responsesServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const server = async (handle: Parameters<typeof responsesServer>[0]) => {
  const s = await responsesServer(handle);
  servers.push(s);
  return s;
};
const input = (
  s: Awaited<ReturnType<typeof responsesServer>>,
  timeoutMs = 2_000,
) => ({
  route: s.route,
  allowPool: true,
  seedLogin: false,
  env: { AGENT_CI_PROXY_API_KEY: KEY },
  prompt: 'Decide from supplied evidence.',
  timeoutMs,
  secrets: [KEY],
});

function checkStrictSchema(node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj.type === 'object') {
    expect(obj.additionalProperties).toBe(false);
    expect([...(obj.required as string[])].toSorted()).toEqual(
      Object.keys(obj.properties as object).toSorted(),
    );
  }
  for (const child of Object.values(obj)) checkStrictSchema(child);
}

describe('direct adjudicator HTTP boundary', () => {
  it('sends the exact authenticated no-tools strict Responses request and reports usage without a CLI session', async () => {
    let captured: unknown;
    const s = await server((req, res) => {
      void requestBody(req).then((body) => {
        captured = {
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          body,
        };
        const response = completedResponse();
        res.end(
          JSON.stringify({
            ...response,
            output: [{ type: 'reasoning', summary: [] }, ...response.output],
          }),
        );
      });
    });
    const result = await runAdjudicatorResponses(input(s));
    expect(result.outcome).toEqual({
      ok: true,
      finalText: '{"operations":[]}',
      usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2 },
    });
    expect(captured).toMatchObject({
      method: 'POST',
      url: '/v1/responses',
      auth: `Bearer ${KEY}`,
      body: {
        model: 'gpt-6.1-sol',
        reasoning: { effort: 'low' },
        tools: [],
        tool_choice: 'none',
        store: false,
        stream: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'adjudication',
            strict: true,
            schema: {
              properties: {
                operations: {
                  items: {
                    required: [
                      'candidate_id',
                      'op',
                      'to_severity',
                      'reason',
                      'references',
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });
    const body = (captured as { body: Record<string, unknown> }).body;
    expect(Object.keys(body).toSorted()).toEqual([
      'input',
      'model',
      'reasoning',
      'store',
      'stream',
      'text',
      'tool_choice',
      'tools',
    ]);
    checkStrictSchema(body.text);
  });

  it('bounds stateless repair context before sending any HTTP request', async () => {
    let hits = 0;
    const s = await server((_req, res) => {
      hits++;
      res.end();
    });
    const result = await runAdjudicatorResponses({
      ...input(s),
      repair: {
        previousAnswer: 'x'.repeat(DEFAULT_MAX_OUTPUT_BYTES),
        instruction: 'Repair.',
      },
    });
    expect(result.outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_OUTPUT_LIMIT',
      retryable: false,
    });
    expect(hits).toBe(0);
  });

  it('never follows a redirect or forwards auth to the destination', async () => {
    let hits = 0;
    const destination = await server((_req, res) => {
      hits++;
      res.end('{}');
    });
    const s = await server((_req, res) => {
      res.writeHead(307, { Location: `${destination.origin}/collect` });
      res.end();
    });
    expect((await runAdjudicatorResponses(input(s))).outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_FAILED',
      retryable: false,
    });
    expect(hits).toBe(0);
  });

  it.each(['headers', 'body'] as const)(
    'bounds delayed %s with the same abort deadline',
    async (phase) => {
      const s = await server((_req, res) => {
        if (phase === 'body') {
          res.writeHead(200);
          res.flushHeaders();
          res.write('{');
        }
      });
      const start = Date.now();
      expect(
        (await runAdjudicatorResponses(input(s, 60))).outcome,
      ).toMatchObject({
        ok: false,
        code: 'E_HARNESS_TIMEOUT',
        retryable: false,
      });
      expect(Date.now() - start).toBeLessThan(1_500);
    },
  );

  it.each([200, 503])(
    'bounds chunked %s output incrementally, including error bytes',
    async (status) => {
      const s = await server((_req, res) => {
        res.writeHead(status);
        const chunk = Buffer.alloc(64 * 1024, 'x');
        for (
          let bytes = 0;
          bytes <= DEFAULT_MAX_OUTPUT_BYTES;
          bytes += chunk.length
        )
          res.write(chunk);
        // Leave the stream open: the client must stop before EOF.
      });
      expect((await runAdjudicatorResponses(input(s))).outcome).toMatchObject({
        ok: false,
        code: 'E_HARNESS_OUTPUT_LIMIT',
        retryable: false,
      });
    },
  );

  it.each([
    [401, 'E_HARNESS_AUTH', false],
    [403, 'E_HARNESS_AUTH', false],
    [400, 'E_HARNESS_FAILED', false],
    [429, 'E_HARNESS_FAILED', true],
    [503, 'E_HARNESS_FAILED', true],
  ])(
    'classifies HTTP %s without retaining body/headers',
    async (status, code, retryable) => {
      const s = await server((_req, res) => {
        res.writeHead(status as number, { 'X-Private': KEY });
        res.end(KEY);
      });
      const result = await runAdjudicatorResponses(input(s));
      expect(result.outcome).toMatchObject({ ok: false, code, retryable });
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain(s.origin);
    },
  );

  const valid = completedResponse();
  it.each([
    ['malformed JSON', '{'],
    ['incomplete', { ...valid, status: 'incomplete' }],
    ['failed', { ...valid, status: 'failed' }],
    ['error', { ...valid, error: { message: 'failure' } }],
    ['missing final', { ...valid, output: [] }],
    [
      'multiple finals',
      { ...valid, output: [...valid.output, ...valid.output] },
    ],
    [
      'tool call',
      {
        ...valid,
        output: [
          { type: 'function_call', name: 'exec', arguments: '{}' },
          ...valid.output,
        ],
      },
    ],
    [
      'refusal',
      {
        ...valid,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'no' }],
          },
        ],
      },
    ],
    [
      'unfinished message',
      { ...valid, output: [{ ...valid.output[0], status: 'in_progress' }] },
    ],
  ])('rejects %s', async (_name, body) => {
    const s = await server((_req, res) =>
      res.end(typeof body === 'string' ? body : JSON.stringify(body)),
    );
    expect((await runAdjudicatorResponses(input(s))).outcome).toMatchObject({
      ok: false,
      code: 'E_HARNESS_FAILED',
      retryable: false,
    });
  });
});
