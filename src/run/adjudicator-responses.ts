import { assertSecretFree } from '@agent-ci/contracts/secret-guard.js';
import { DEFAULT_MAX_OUTPUT_BYTES } from '@agent-ci/harness/spawn.js';
import type { HarnessOutcome, Usage } from '@agent-ci/harness/types.js';
import { ADJUDICATION_RESPONSES_SCHEMA } from '@agent-ci/review/adjudicate.js';
import { adjudicatorTransport } from '@agent-ci/routing/adjudicator.js';
import type { Route } from '@agent-ci/routing/schema.js';
import { z } from 'zod';

const Metering = z.object({
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      input_tokens_details: z
        .object({
          cached_tokens: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .nullish(),
});
const Envelope = z.object({
  object: z.literal('response'),
  status: z.literal('completed'),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z.array(z.unknown()),
});
const Message = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  status: z.literal('completed'),
  content: z.tuple([
    z.object({ type: z.literal('output_text'), text: z.string().min(1) }),
  ]),
});
const Reasoning = z.object({
  type: z.literal('reasoning'),
  summary: z.array(
    z.object({ type: z.literal('summary_text'), text: z.string() }),
  ),
});

type Input = {
  readonly route: Route;
  readonly allowPool: boolean;
  readonly seedLogin: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompt: string;
  readonly repair?: {
    readonly previousAnswer: string;
    readonly instruction: string;
  };
  readonly timeoutMs: number;
  readonly secrets: readonly string[];
};

/**
 * Only HTTP interpretation for the internal Sol Low adjudicator. The caller
 * owns supervision, semantic acceptance and persistence. No session or tool
 * dispatch exists here; response IDs are deliberately ignored.
 */
export async function runAdjudicatorResponses(
  input: Input,
): Promise<{ outcome: HarnessOutcome; durationMs: number }> {
  const started = Date.now();
  let counters: Usage | null = null;
  const failed = (
    code:
      | 'E_POLICY_HARNESS'
      | 'E_HARNESS_AUTH'
      | 'E_HARNESS_FAILED'
      | 'E_HARNESS_TIMEOUT'
      | 'E_HARNESS_OUTPUT_LIMIT'
      | 'E_CREDENTIAL_LEAK',
    message: string,
    retryable = false,
  ) => ({
    outcome: { ok: false as const, code, message, retryable, usage: counters },
    durationMs: Date.now() - started,
  });
  const selected = adjudicatorTransport(input.route, input);
  if (!selected.ok || selected.value !== 'adjudicator-responses')
    return failed('E_POLICY_HARNESS', 'ineligible direct adjudicator route');
  const context =
    input.repair === undefined
      ? input.prompt
      : JSON.stringify({
          original_prompt: input.prompt,
          previous_answer: input.repair.previousAnswer,
          repair_instruction: input.repair.instruction,
        });
  if (Buffer.byteLength(context) > DEFAULT_MAX_OUTPUT_BYTES)
    return failed(
      'E_HARNESS_OUTPUT_LIMIT',
      'adjudicator context exceeded the capture limit',
    );
  const controller = new AbortController();
  // The same timer stays active until ALL response/error bytes are consumed.
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs),
  );
  try {
    const response = await fetch(`${input.route.baseUrl}/responses`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.env.AGENT_CI_PROXY_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: 'gpt-6.1-sol',
        reasoning: { effort: 'low' },
        input: context,
        tools: [],
        tool_choice: 'none',
        store: false,
        stream: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'adjudication',
            strict: true,
            schema: ADJUDICATION_RESPONSES_SCHEMA,
          },
        },
      }),
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader !== undefined) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > DEFAULT_MAX_OUTPUT_BYTES) {
            controller.abort();
            return failed(
              'E_HARNESS_OUTPUT_LIMIT',
              'adjudicator exceeded the output capture limit',
            );
          }
          // Error bodies count toward the budget but are never retained.
          if (response.ok) chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        return failed('E_HARNESS_AUTH', 'adjudicator authentication refused');
      return failed(
        'E_HARNESS_FAILED',
        `adjudicator HTTP status ${response.status}`,
        [429, 500, 502, 503, 504, 529].includes(response.status),
      );
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return failed('E_HARNESS_FAILED', 'adjudicator returned malformed JSON');
    }
    const metering = Metering.safeParse(raw);
    const usage = metering.success ? metering.data.usage : undefined;
    counters =
      usage == null
        ? null
        : {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            ...(usage.input_tokens_details === undefined
              ? {}
              : { cacheReadTokens: usage.input_tokens_details.cached_tokens }),
          };
    // Guard the ENTIRE envelope before discarding reasoning or metadata, and
    // before semantic acceptance could strip unknown fields from the answer.
    if (!assertSecretFree(raw, input.secrets).ok)
      return failed(
        'E_CREDENTIAL_LEAK',
        'adjudicator output contains a guarded value',
      );
    const envelope = Envelope.safeParse(raw);
    if (!envelope.success)
      return failed(
        'E_HARNESS_FAILED',
        'adjudicator returned an invalid or unfinished response',
      );
    const messages: z.infer<typeof Message>[] = [];
    for (const output of envelope.data.output) {
      const message = Message.safeParse(output);
      if (message.success) messages.push(message.data);
      else if (!Reasoning.safeParse(output).success)
        return failed(
          'E_HARNESS_FAILED',
          'adjudicator returned a tool, refusal or invalid output',
        );
    }
    const [message] = messages;
    if (messages.length !== 1 || message === undefined)
      return failed(
        'E_HARNESS_FAILED',
        'adjudicator must return exactly one final answer',
      );
    const finalText = message.content[0].text;
    try {
      if (!assertSecretFree(JSON.parse(finalText) as unknown, input.secrets).ok)
        return failed(
          'E_CREDENTIAL_LEAK',
          'adjudicator output contains a guarded value',
        );
    } catch {
      /* The run core offers the single structured repair. */
    }
    return {
      outcome: { ok: true, finalText, usage: counters },
      durationMs: Date.now() - started,
    };
  } catch {
    // Fetch causes, error bodies and headers may contain credentials or the
    // private origin. Never retain them, even for a redirect/network failure.
    return controller.signal.aborted
      ? failed('E_HARNESS_TIMEOUT', 'adjudicator exceeded its deadline')
      : failed('E_HARNESS_FAILED', 'adjudicator transport failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
