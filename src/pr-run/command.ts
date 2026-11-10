import { failure, success, type Result } from '@agent-ci/result.js';

export const MODEL_PROFILE_NAMES = ['cost', 'balance', 'intelligence'] as const;
export type ModelProfileName = (typeof MODEL_PROFILE_NAMES)[number];

export interface PrRunCommand {
  readonly prompt: string;
  readonly modelProfile?: ModelProfileName;
}

/** Parse runner options only before the task begins. Skill text stays untouched. */
export function parsePrRunCommand(body: unknown): Result<PrRunCommand | null> {
  if (typeof body !== 'string') return success(null);
  const prefix = /^(?:\/agent-ci|@agent-ci)(?:\s+|$)/u.exec(body);
  if (prefix === null) return success(null);
  let prompt = body.slice(prefix[0].length).trim();
  let modelProfile: ModelProfileName | undefined;
  while (prompt.startsWith('--')) {
    const token = /^\S+/u.exec(prompt)?.[0] ?? '';
    prompt = prompt.slice(token.length).trimStart();
    if (token === '--') break;
    if (token !== '--model-profile' && !token.startsWith('--model-profile='))
      return failure(
        'E_PR_RUN_REQUEST',
        `unknown PR command option ${token}; use -- before a task that starts with an option`,
      );
    if (modelProfile !== undefined)
      return failure(
        'E_PR_RUN_REQUEST',
        'the model profile may be selected only once',
      );
    let value = token.slice('--model-profile='.length);
    if (token === '--model-profile') {
      value = /^\S+/u.exec(prompt)?.[0] ?? '';
      prompt = prompt.slice(value.length).trimStart();
    }
    if (!(MODEL_PROFILE_NAMES as readonly string[]).includes(value))
      return failure(
        'E_PR_RUN_REQUEST',
        `the model profile must be one of ${MODEL_PROFILE_NAMES.join(', ')}`,
      );
    modelProfile = value as ModelProfileName;
  }
  if (prompt === '')
    return failure(
      'E_PR_RUN_REQUEST',
      'the PR command requires a task after its options',
    );
  return success({
    prompt,
    ...(modelProfile === undefined ? {} : { modelProfile }),
  });
}
