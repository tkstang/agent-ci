import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * Final-answer parsing (`stripJsonFence`, `parseJsonPayload`,
 * `extractStructuredResult`). Harness
 * adapters hand over the agent's final text (or a parsed structured-output
 * object); this module turns it into an untrusted JSON candidate.
 */

/** Remove one surrounding Markdown code fence (```json ... ```). */
export function stripJsonFence(value: string): string {
  const text = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
  return fenced?.[1] === undefined ? text : fenced[1].trim();
}

/**
 * Parse a JSON payload from text: the whole text, a fenced block, or the span
 * from the first `{` to the last `}` when the agent wrapped it in prose.
 */
export function parseJsonPayload(value: unknown): Result<unknown> {
  if (value !== null && typeof value === 'object') return success(value);
  const text = stripJsonFence(String(value ?? ''));
  try {
    return success(JSON.parse(text));
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return success(JSON.parse(text.slice(start, end + 1)));
      } catch {
        // fall through to the failure below
      }
    }
    return failure('E_INVALID_RUN_RESULT', 'agent final answer is not JSON');
  }
}

const WRAPPER_KEYS = ['result', 'text', 'message'] as const;

/**
 * Extract the RunResult candidate from a final answer. A wrapper object whose
 * `result`, `text` or `message` field holds the JSON (as harness envelopes and
 * some agents produce) is unwrapped once.
 */
export function extractStructuredResult(finalAnswer: unknown): Result<unknown> {
  const parsed = parseJsonPayload(finalAnswer);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.ok === undefined && record.status === undefined) {
      for (const key of WRAPPER_KEYS) {
        if (record[key] !== undefined) return parseJsonPayload(record[key]);
      }
    }
  }
  return success(value);
}
