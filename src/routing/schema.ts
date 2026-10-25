import { z } from 'zod';

/** Harnesses agent-ci can drive. `fake` needs no model and no credential. */
export const HARNESS_IDS = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'fake',
] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * How a route is paid for. `subscription` spends a plan's included usage,
 * `paid-api` is metered API billing, `none` is the credential-free fake.
 */
export const BILLING_CLASSES = ['subscription', 'paid-api', 'none'] as const;
export type BillingClass = (typeof BILLING_CLASSES)[number];

/** Whose account a route spends. `pool` is the local proxy pool. */
export const ACCOUNTS = ['personal', 'work', 'pool'] as const;
export type Account = (typeof ACCOUNTS)[number];

/** How the harness returns structured output for this route. */
export const STRUCTURED_OUTPUT_MODES = [
  'json-schema',
  'output-schema',
  'prompt',
] as const;
export type StructuredOutputMode = (typeof STRUCTURED_OUTPUT_MODES)[number];

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const ROUTE_ID = /^[a-z0-9][a-z0-9.-]*$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export const RouteSchema = z.strictObject({
  /** Stable route identifier, selectable with `--route`. */
  id: z.string().regex(ROUTE_ID, 'route id must be lowercase kebab-case'),
  /** The qualified model key a caller picks. */
  model: z.string().min(1),
  harness: z.enum(HARNESS_IDS),
  /** Model ID as the harness expects it. */
  providerModel: z.string().min(1),
  /** Credential environment variable NAMES this route may receive. */
  credentials: z
    .array(z.string().regex(ENV_NAME, 'credential must be an env var name'))
    .default([]),
  /** Authenticates through a harness login seeded into the home root (local only). */
  login: z.boolean().default(false),
  /** Endpoint override (Claude: ANTHROPIC_BASE_URL; Codex: provider base_url). */
  baseUrl: z.url().optional(),
  /** Reasoning effort hint, for harnesses that take one. */
  effort: z.string().min(1).optional(),
  billing: z.enum(BILLING_CLASSES),
  account: z.enum(ACCOUNTS),
  structuredOutput: z.enum(STRUCTURED_OUTPUT_MODES),
  /** Date of the last live qualification, or null when not yet live-verified. */
  qualified: z.string().regex(ISO_DATE).nullable(),
  notes: z.string().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

export const ModelsFileSchema = z.strictObject({
  version: z.literal(1),
  routes: z.array(RouteSchema).min(1),
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;
