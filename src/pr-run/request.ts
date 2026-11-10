import { failure, success, type Result } from '@agent-ci/result.js';
import { isRepository, isUserLogin } from '@agent-ci/review/contracts.js';
import { isBranchName } from '@agent-ci/review/trigger.js';
import { z } from 'zod';

export const PR_RUN_PROMPT_BYTES = 16 * 1024;
export const PR_RUN_CONTEXT_BYTES = 64 * 1024;

const text = (maxBytes: number) =>
  z
    .string()
    .refine((value) => !value.includes('\0'), 'must not contain NUL')
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= maxBytes,
      'exceeds the byte limit',
    );

/** The trusted gate's snapshot. Task and context stay in this artifact. */
export const PrRunRequestSchema = z
  .strictObject({
    version: z.literal(1),
    repository: z.string().refine(isRepository, 'invalid repository'),
    prNumber: z.number().int().positive().safe(),
    commentId: z.number().int().positive().safe(),
    actor: z.string().refine(isUserLogin, 'invalid human actor'),
    headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    headRef: z.string().refine(isBranchName, 'invalid head branch'),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
    baseRef: z.string().refine(isBranchName, 'invalid base branch'),
    prompt: text(PR_RUN_PROMPT_BYTES).refine(
      (value) => value.trim() !== '',
      'empty task',
    ),
    context: text(PR_RUN_CONTEXT_BYTES),
    prUrl: z.string().max(2048),
  })
  .refine((value) => value.headRef !== value.baseRef, {
    message: 'head branch must differ from the base branch',
    path: ['headRef'],
  })
  .refine(
    (value) => {
      try {
        const url = new URL(value.prUrl);
        return (
          url.protocol === 'https:' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === '' &&
          url.pathname === `/${value.repository}/pull/${value.prNumber}`
        );
      } catch {
        return false;
      }
    },
    { message: 'invalid pull request URL', path: ['prUrl'] },
  );

export type PrRunRequest = z.infer<typeof PrRunRequestSchema>;

export function parsePrRunRequest(value: unknown): Result<PrRunRequest> {
  const parsed = PrRunRequestSchema.safeParse(value);
  return parsed.success
    ? success(parsed.data)
    : failure('E_PR_RUN_REQUEST', 'the PR run request is malformed');
}
