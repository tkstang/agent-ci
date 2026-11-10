import { failure, success, type Result } from '@agent-ci/result.js';
import { HARNESS_IDS } from '@agent-ci/routing/schema.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { MODEL_PROFILE_NAMES, type ModelProfileName } from './command.js';

const key = z.string().min(1).regex(/^\S+$/u);

/** Each profile is a complete selection, independent of the default. */
export const PrRunModelSchema = z.strictObject({
  model: key,
  harness: z.enum(HARNESS_IDS).optional(),
  route: key.optional(),
});
export type PrRunModel = z.infer<typeof PrRunModelSchema>;

const ProfilesSchema = z.partialRecord(
  z.enum(MODEL_PROFILE_NAMES),
  PrRunModelSchema,
);
export type PrRunModelProfiles = z.infer<typeof ProfilesSchema>;

export function parsePrRunModelProfiles(
  text: string | undefined,
): Result<PrRunModelProfiles> {
  if (text === undefined || text.trim() === '') return success({});
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return failure('E_PR_RUN_REQUEST', 'model_profiles must be valid YAML');
  }
  const parsed = ProfilesSchema.safeParse(raw);
  return parsed.success
    ? success(parsed.data)
    : failure(
        'E_PR_RUN_REQUEST',
        'model_profiles must map cost, balance or intelligence to a model and optional harness or route',
      );
}

/** Caller configuration and its allowlist are trusted; comments select a name only. */
export function selectPrRunModel(input: {
  readonly defaultModel: PrRunModel;
  readonly profiles: PrRunModelProfiles;
  readonly requestedProfile?: ModelProfileName;
  readonly allowedModels: readonly string[];
}): Result<PrRunModel> {
  const configured = [input.defaultModel, ...Object.values(input.profiles)];
  if (configured.some((value) => !input.allowedModels.includes(value.model)))
    return failure(
      'E_PR_RUN_REQUEST',
      'the default and every configured profile model must be in allowed_models',
    );
  if (input.requestedProfile === undefined) return success(input.defaultModel);
  const selected = input.profiles[input.requestedProfile];
  return selected === undefined
    ? failure(
        'E_PR_RUN_REQUEST',
        `model profile ${input.requestedProfile} is not configured`,
      )
    : success(selected);
}
