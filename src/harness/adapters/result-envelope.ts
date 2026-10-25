import { classifyFailure, truncate } from '@agent-ci/harness/classify.js';
import type {
  HarnessOutcome,
  ProcessOutput,
  Usage,
} from '@agent-ci/harness/types.js';

/**
 * Parser for the single JSON "result" envelope that `claude -p
 * --output-format json` and `agent -p --output-format json` print (shapes
 * recorded in harness-probes-2026-10-25): `type: "result"`, `is_error`,
 * `result` (final text), `session_id`, `usage`, and for Claude
 * `structured_output` and `total_cost_usd`.
 */

export interface EnvelopeOptions {
  /** Map the harness's usage object to agent-ci counters. */
  readonly usage: (envelope: Record<string, unknown>) => Usage | null;
  readonly harness: string;
}

function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value: unknown = JSON.parse(lines[index] ?? '');
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // not JSON; keep looking
    }
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Drop undefined counters; return null when nothing was reported. */
export function compactUsage(
  usage: Record<string, number | undefined>,
): Usage | null {
  const entries = Object.entries(usage).filter(
    ([, value]) => value !== undefined,
  );
  return entries.length === 0 ? null : (Object.fromEntries(entries) as Usage);
}

export function interpretResultEnvelope(
  output: ProcessOutput,
  options: EnvelopeOptions,
): HarnessOutcome {
  const envelope = lastJsonObject(output.stdout);
  const usage = envelope === undefined ? null : options.usage(envelope);
  const sessionId =
    typeof envelope?.session_id === 'string' ? envelope.session_id : undefined;
  const session = sessionId === undefined ? {} : { sessionId };
  const isError = envelope?.is_error === true;

  if (envelope === undefined || isError || output.exitCode !== 0) {
    const resultText =
      typeof envelope?.result === 'string' ? envelope.result : '';
    const diagnostic = [
      resultText,
      typeof envelope?.api_error_status === 'number'
        ? `status ${envelope.api_error_status}`
        : '',
      output.stderr,
      envelope === undefined ? output.stdout : '',
    ]
      .filter(Boolean)
      .join('\n');
    const { code, retryable } = classifyFailure(diagnostic);
    return {
      ok: false,
      code,
      retryable,
      usage,
      ...session,
      message: truncate(
        diagnostic === ''
          ? `${options.harness} exited with ${output.exitCode ?? output.signal}`
          : diagnostic,
      ),
    };
  }
  if (typeof envelope.result !== 'string') {
    return {
      ok: false,
      code: 'E_HARNESS_FAILED',
      retryable: false,
      usage,
      ...session,
      message: `${options.harness} result envelope has no result text`,
    };
  }
  return {
    ok: true,
    finalText: envelope.result,
    usage,
    ...session,
    ...(envelope.structured_output === undefined
      ? {}
      : { structured: envelope.structured_output }),
  };
}
