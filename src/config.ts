import { failure, success, type Result } from '@agent-ci/result.js';
import { z } from 'zod';

/**
 * Zod schema at the boundary: untrusted JSON in, a validated domain shape out.
 * Pair each schema with its inferred type immediately (house idiom).
 */
export const ConfigSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  retries: z.number().int().min(0).max(10).default(3),
  verbose: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse an untrusted JSON string into a `Config`, returning a result-envelope
 * (the domain layer never throws for expected-failure control flow).
 */
export function parseConfig(input: string): Result<Config> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return failure(
      'E_EMPTY_INPUT',
      'config input was empty',
      'Pass a non-empty JSON object, e.g. {"name":"my-app"}',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return failure(
      'E_INVALID_INPUT',
      'config input was not valid JSON',
      'Check for trailing commas or unquoted keys.',
    );
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where =
      first === undefined ? '' : ` at ${first.path.join('.') || '<root>'}`;
    const why =
      first === undefined ? 'unknown validation error' : first.message;
    return failure(
      'E_INVALID_INPUT',
      `config failed validation${where}: ${why}`,
    );
  }

  return success(parsed.data);
}
