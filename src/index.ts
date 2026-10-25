/**
 * Public library barrel — the single entry point. Consumers import `@tkstang/agent-ci`
 * (renamed to `@<project>/single`), never deep internal paths.
 */

export { parseConfig, ConfigSchema, type Config } from '@agent-ci/config.js';
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
export { CliError, isCliError } from '@agent-ci/errors.js';
