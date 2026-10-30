import {
  closedRecord,
  contractError,
  REVIEW_MODES,
  type ReviewMode,
} from '@agent-ci/review/contracts.js';

/**
 * The resolved request configuration for one PR review run: the mode, each
 * pass's on/off state and model, and the commenter's request instruction.
 * The gate produces it from the trigger, the command and the workflow
 * defaults; prompt assembly and the passes consume only this validated
 * shape, never raw comment text. A model is a `models.yaml` model name.
 */

/** A `models.yaml` model name: the only model syntax a request carries. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Limits shared with the command parser. Over-limit text is rejected. */
export const REQUEST_LIMITS = Object.freeze({
  commentBytes: 16384,
  instructionCodePoints: 2000,
  instructionBytes: 8192,
});

export type PassSelection = { enabled: boolean; model: string };
export type ResolvedRequestConfig = {
  version: 1;
  mode: ReviewMode;
  /** The primary reviewer always runs. */
  primary: { model: string };
  second: PassSelection;
  adjudicator: PassSelection;
  /** Request instruction from the command; `''` when none. */
  instruction: string;
};

function invalid(message: string): never {
  return contractError('E_REVIEW_REQUEST', message);
}

function model(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    invalid(`${field} must be a non-empty model name`);
  if (!MODEL_NAME.test(value.trim()))
    invalid(`${field} is not a valid model name`);
  return value.trim();
}

function pass(value: unknown, field: string): PassSelection {
  if (
    !closedRecord(value, ['enabled', 'model']) ||
    typeof value.enabled !== 'boolean'
  )
    invalid(`${field} must be {enabled, model}`);
  return {
    enabled: value.enabled,
    model: model(value.model, `${field}.model`),
  };
}

/** True when `text` is within the request-instruction limits. */
export function instructionWithinLimits(text: string): boolean {
  return (
    [...text].length <= REQUEST_LIMITS.instructionCodePoints &&
    Buffer.byteLength(text, 'utf8') <= REQUEST_LIMITS.instructionBytes
  );
}

/** Validate a resolved request configuration (closed shape). */
export function validateRequestConfig(value: unknown): ResolvedRequestConfig {
  if (
    !closedRecord(value, [
      'version',
      'mode',
      'primary',
      'second',
      'adjudicator',
      'instruction',
    ])
  )
    invalid('request configuration must be an object with only known fields');
  if (value.version !== 1) invalid('unsupported request configuration version');
  if (
    typeof value.mode !== 'string' ||
    !(REVIEW_MODES as readonly string[]).includes(value.mode)
  )
    invalid('invalid review mode');
  if (!closedRecord(value.primary, ['model']))
    invalid('primary must be {model}');
  const instruction = value.instruction ?? '';
  if (typeof instruction !== 'string') invalid('instruction must be a string');
  if (!instructionWithinLimits(instruction))
    invalid(
      `instruction exceeds ${REQUEST_LIMITS.instructionCodePoints} code points or ${REQUEST_LIMITS.instructionBytes} bytes`,
    );
  return {
    version: 1,
    mode: value.mode as ReviewMode,
    primary: { model: model(value.primary.model, 'primary.model') },
    second: pass(value.second, 'second'),
    adjudicator: pass(value.adjudicator, 'adjudicator'),
    instruction,
  };
}
