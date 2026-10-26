/**
 * Public library barrel — the single entry point. Consumers import
 * `@tkstang/agent-ci`, never deep internal paths.
 */

export {
  type Result,
  type Success,
  type Failure,
  type ErrorCode,
  ERROR_CODES,
  success,
  failure,
  isSuccess,
} from '@agent-ci/result.js';
export { CliError, isCliError, exitCodeFor } from '@agent-ci/errors.js';
export {
  OUTPUT_CONTRACTS,
  type OutputContract,
  type RunResult,
  type ValidatedRunResult,
  validateRunResult,
  buildFailedRunResult,
} from '@agent-ci/contracts/run-result.js';
export { extractStructuredResult } from '@agent-ci/contracts/final-answer.js';
export {
  assertSecretFree,
  maskSecrets,
  KNOWN_CREDENTIAL_ENV,
} from '@agent-ci/contracts/secret-guard.js';
export {
  loadModelsFile,
  parseModelsFile,
  resolveRoute,
} from '@agent-ci/routing/resolve.js';
export type { Route, HarnessId } from '@agent-ci/routing/schema.js';
export {
  runAgent,
  type RunOptions,
  type RunSummary,
} from '@agent-ci/run/execute.js';
